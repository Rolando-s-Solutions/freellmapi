import * as vscode from 'vscode';
import { DEFAULT_BASE_URL, errorMessageFromResponse, FreeLLMModel, normalizeBaseUrl, parseModelList } from './apiUtils';

const API_KEY_SECRET = 'freellmapi.apiKey';
const MODEL_CACHE_MS = 60_000;
/** OpenAI restricts `name` to this character set and length. */
const MAX_NAME_LENGTH = 64;

type OpenAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type OpenAIMessage =
	| { role: 'system'; content: string; name?: string }
	| { role: 'user'; content: string | OpenAIContentPart[]; name?: string }
	| { role: 'assistant'; content: string | null; name?: string; tool_calls?: OpenAIToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

export interface ConvertOptions {
	/** When false, tool calls and results are sent as plain text so models without tool support accept the history. */
	toolCalling: boolean;
}

interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

type ReportPart = (part: vscode.LanguageModelResponsePart) => void;

export class FreeLLMAPIProvider implements vscode.LanguageModelChatProvider<FreeLLMModel> {
	private cachedModels: FreeLLMModel[] | undefined;
	private cacheExpiresAt = 0;
	private readonly modelInfoChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelInfoChanged.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('freellmapi.baseUrl')) {
					this.clearModelCache();
				}
			})
		);
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken
	): Promise<FreeLLMModel[]> {
		const apiKey = await this.context.secrets.get(API_KEY_SECRET);
		if (!apiKey) {
			if (!options.silent) {
				void vscode.window.showInformationMessage(
					'Configure FreeLLMAPI to add its models to the VS Code Chat model picker.',
					'Configure'
				).then(selection => {
					if (selection === 'Configure') {
						return vscode.commands.executeCommand('freellmapi.configure');
					}
					return undefined;
				});
			}
			return [];
		}

		if (this.cachedModels && Date.now() < this.cacheExpiresAt) {
			return this.cachedModels;
		}

		const controller = abortOnCancellation(token);
		try {
			const baseUrl = this.getBaseUrl();
			const response = await fetch(`${baseUrl}/models?execution_status=ready`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(errorMessageFromResponse(response.status, await response.text(), apiKey));
			}
			const models = parseModelList(await response.json());
			this.cachedModels = models;
			this.cacheExpiresAt = Date.now() + MODEL_CACHE_MS;
			return models;
		} catch (error) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			throw error;
		} finally {
			controller.dispose();
		}
	}

	async provideLanguageModelChatResponse(
		model: FreeLLMModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const apiKey = await this.context.secrets.get(API_KEY_SECRET);
		if (!apiKey) {
			throw new Error('FreeLLMAPI is not configured. Run “FreeLLMAPI: Configure Connection”.');
		}

		const controller = abortOnCancellation(token);
		const report: ReportPart = part => progress.report(part);
		try {
			const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
					Accept: 'text/event-stream'
				},
				body: JSON.stringify(buildRequestBody(model, messages, options)),
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(errorMessageFromResponse(response.status, await response.text(), apiKey));
			}
			// Some routes (e.g. non-streaming upstreams) answer with a single JSON completion even when streaming was requested.
			if ((response.headers.get('content-type') ?? '').includes('application/json')) {
				parseJsonCompletion(await response.json(), report);
				return;
			}
			if (!response.body) {
				throw new Error('FreeLLMAPI returned an empty streaming response.');
			}
			await parseEventStream(response.body, report, token);
		} catch (error) {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			throw error;
		} finally {
			controller.dispose();
		}
	}

	async provideTokenCount(
		_model: FreeLLMModel,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		const value = typeof text === 'string' ? text : JSON.stringify(convertMessages([text]));
		return Math.ceil(value.length / 4);
	}

	clearModelCache(): void {
		this.cachedModels = undefined;
		this.cacheExpiresAt = 0;
		this.modelInfoChanged.fire();
	}

	dispose(): void {
		this.modelInfoChanged.dispose();
	}

	private getBaseUrl(): string {
		const configured = vscode.workspace.getConfiguration('freellmapi').get<string>('baseUrl', DEFAULT_BASE_URL);
		return normalizeBaseUrl(configured);
	}
}

export function buildRequestBody(
	model: FreeLLMModel,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions
): Record<string, unknown> {
	const toolCalling = model.capabilities.toolCalling;
	const body: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(messages, { toolCalling }),
		stream: true
	};
	if (toolCalling && options.tools?.length) {
		body.tools = options.tools.map(tool => ({
			type: 'function' as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? { type: 'object', properties: {} }
			}
		}));
		if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
			body.tool_choice = 'required';
		}
	}
	return body;
}

export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: ConvertOptions = { toolCalling: true }
): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	// Tool results are only valid as `role: 'tool'` when they answer a tool call already sent in this request.
	const sentToolCallIds = new Set<string>();

	for (const message of messages) {
		const name = sanitizeName(message.name);
		const nameField = name ? { name } : {};

		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const text: string[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelToolCallPart) {
					if (options.toolCalling) {
						toolCalls.push({
							id: part.callId,
							type: 'function',
							function: { name: part.name, arguments: JSON.stringify(part.input) }
						});
						sentToolCallIds.add(part.callId);
					} else {
						text.push(`Called tool ${part.name} (call ${part.callId}) with arguments: ${JSON.stringify(part.input)}`);
					}
				} else {
					text.push(partToText(part));
				}
			}
			result.push({
				role: 'assistant',
				content: text.join('') || (toolCalls.length > 0 ? null : ''),
				...nameField,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
			});
			continue;
		}

		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			const toolMessages: OpenAIMessage[] = [];
			const text: string[] = [];
			const userParts: OpenAIContentPart[] = [];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelToolResultPart) {
					const content = convertToolResult(part.content);
					toolMessages.push(options.toolCalling && sentToolCallIds.has(part.callId)
						? { role: 'tool', tool_call_id: part.callId, content }
						: { role: 'user', content: `Tool result for call ${part.callId}:\n${content}` });
				} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
					const base64 = Buffer.from(part.data).toString('base64');
					userParts.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${base64}` } });
				} else {
					const value = partToText(part);
					if (value) {
						text.push(value);
						userParts.push({ type: 'text', text: value });
					}
				}
			}
			// Tool messages must directly follow the assistant message that requested them.
			result.push(...toolMessages);
			if (userParts.length > 0 || message.content.length === 0) {
				result.push({
					role: 'user',
					content: userParts.some(part => part.type === 'image_url') ? userParts : text.join(''),
					...nameField
				});
			}
			continue;
		}

		// System instructions (role 3 at runtime) and any future roles are sent as system messages.
		result.push({ role: 'system', content: message.content.map(partToText).join(''), ...nameField });
	}
	return result;
}

/** Parses an OpenAI-compatible SSE stream, reporting text as it arrives and tool calls once complete. */
export async function parseEventStream(
	stream: ReadableStream<Uint8Array>,
	report: ReportPart,
	token?: { readonly isCancellationRequested: boolean }
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const accumulator = new ResponseAccumulator(report);
	let buffer = '';
	let dataLines: string[] = [];

	const dispatch = (): boolean => {
		if (dataLines.length === 0) {
			return false;
		}
		const data = dataLines.join('\n');
		dataLines = [];
		if (data === '[DONE]') {
			return true;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw new Error('FreeLLMAPI returned malformed streaming data.');
		}
		if (!isRecord(parsed)) {
			throw new Error('FreeLLMAPI returned an invalid streaming response.');
		}
		if (isRecord(parsed.error)) {
			throw new Error(`FreeLLMAPI streaming error: ${errorText(parsed.error)}`);
		}
		// Metadata, keep-alive and usage chunks carry no (or empty) choices; they are skipped.
		for (const choice of Array.isArray(parsed.choices) ? parsed.choices : []) {
			if (isRecord(choice)) {
				accumulator.add(isRecord(choice.delta) ? choice.delta : choice.message);
			}
		}
		return false;
	};

	const processLine = (line: string): boolean => {
		if (line === '') {
			return dispatch();
		}
		if (line.startsWith('data:')) {
			dataLines.push(line.slice(5).replace(/^ /, ''));
		}
		return false;
	};

	try {
		let done = false;
		while (!done) {
			if (token?.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const { value, done: streamEnded } = await reader.read();
			if (streamEnded) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
				buffer = buffer.slice(newlineIndex + 1);
				if (processLine(line)) {
					done = true;
					break;
				}
			}
		}
		if (!done) {
			buffer += decoder.decode();
			if (!(buffer.length > 0 && processLine(buffer.replace(/\r$/, '')))) {
				dispatch();
			}
		}
		accumulator.finish();
	} finally {
		reader.releaseLock();
	}
}

/** Parses a non-streaming `chat.completion` JSON payload. */
export function parseJsonCompletion(payload: unknown, report: ReportPart): void {
	if (!isRecord(payload)) {
		throw new Error('FreeLLMAPI returned an invalid response.');
	}
	if (isRecord(payload.error)) {
		throw new Error(`FreeLLMAPI request failed: ${errorText(payload.error)}`);
	}
	if (!Array.isArray(payload.choices)) {
		throw new Error('FreeLLMAPI returned an invalid response.');
	}
	const accumulator = new ResponseAccumulator(report);
	for (const choice of payload.choices) {
		if (isRecord(choice) && isRecord(choice.message)) {
			const message = choice.message;
			const toolCalls = Array.isArray(message.tool_calls)
				? message.tool_calls.map((call, index) => (isRecord(call) ? { index, ...call } : call))
				: undefined;
			accumulator.add({ ...message, tool_calls: toolCalls });
		}
	}
	accumulator.finish();
}

/** Collects content, reasoning and tool-call fragments shared by the SSE and JSON parsers. */
class ResponseAccumulator {
	private emittedText = false;
	private readonly reasoning: string[] = [];
	private readonly toolCalls = new Map<number, PendingToolCall>();

	constructor(private readonly report: ReportPart) {}

	add(delta: unknown): void {
		if (!isRecord(delta)) {
			return;
		}
		if (typeof delta.content === 'string' && delta.content.length > 0) {
			this.emittedText = true;
			this.report(new vscode.LanguageModelTextPart(delta.content));
		}
		for (const reasoning of [delta.reasoning, delta.reasoning_content]) {
			if (typeof reasoning === 'string') {
				this.reasoning.push(reasoning);
			}
		}
		for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
			if (!isRecord(toolCall)) {
				continue;
			}
			const fn = isRecord(toolCall.function) ? toolCall.function : {};
			const index = typeof toolCall.index === 'number' ? toolCall.index : this.toolCalls.size;
			const pending = this.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
			pending.id += stringOrEmpty(toolCall.id);
			pending.name += stringOrEmpty(fn.name);
			pending.arguments += stringOrEmpty(fn.arguments);
			this.toolCalls.set(index, pending);
		}
	}

	finish(): void {
		for (const [index, call] of [...this.toolCalls.entries()].sort(([a], [b]) => a - b)) {
			if (!call.name) {
				throw new Error('FreeLLMAPI returned a tool call without a name.');
			}
			let input: unknown;
			try {
				input = JSON.parse(call.arguments || '{}');
			} catch {
				throw new Error(`FreeLLMAPI returned invalid arguments for tool “${call.name}”.`);
			}
			if (!isRecord(input)) {
				throw new Error(`FreeLLMAPI returned non-object arguments for tool “${call.name}”.`);
			}
			this.report(new vscode.LanguageModelToolCallPart(call.id || `freellmapi-call-${index}`, call.name, input));
		}
		// Reasoning models can finish without visible content; show their reasoning instead of an empty reply.
		const reasoning = this.reasoning.join('');
		if (!this.emittedText && this.toolCalls.size === 0 && reasoning.trim().length > 0) {
			this.report(new vscode.LanguageModelTextPart(reasoning));
		}
	}
}

function partToText(part: unknown): string {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}
	if (part instanceof vscode.LanguageModelDataPart) {
		return isTextMimeType(part.mimeType) ? new TextDecoder().decode(part.data) : '';
	}
	if (part instanceof vscode.LanguageModelPromptTsxPart) {
		return promptTsxToText(part.value);
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return convertToolResult(part.content);
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return `Called tool ${part.name} with arguments: ${JSON.stringify(part.input)}`;
	}
	if (typeof part === 'string') {
		return part;
	}
	// Unknown future part types are skipped rather than failing the whole request.
	return '';
}

function isTextMimeType(mimeType: string): boolean {
	return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.endsWith('+json');
}

/** Extracts text from a `@vscode/prompt-tsx` JSON element tree, falling back to its JSON form. */
function promptTsxToText(value: unknown): string {
	const collected: string[] = [];
	const visit = (node: unknown): void => {
		if (typeof node === 'string') {
			collected.push(node);
		} else if (Array.isArray(node)) {
			node.forEach(visit);
		} else if (isRecord(node)) {
			if (typeof node.text === 'string') {
				collected.push(node.text);
			}
			visit(node.node);
			visit(node.children);
		}
	};
	visit(value);
	if (collected.length > 0) {
		return collected.join('');
	}
	return value === undefined ? '' : JSON.stringify(value) ?? '';
}

function convertToolResult(content: readonly unknown[]): string {
	return content.map(partToText).join('');
}

function sanitizeName(name: string | undefined): string | undefined {
	if (!name) {
		return undefined;
	}
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_NAME_LENGTH);
	return /[a-zA-Z0-9]/.test(sanitized) ? sanitized : undefined;
}

function errorText(error: Record<string, unknown>): string {
	return typeof error.message === 'string' ? error.message : 'The model returned an error.';
}

function abortOnCancellation(token: vscode.CancellationToken): AbortController & { dispose: () => void } {
	const controller = new AbortController();
	const cancellation = token.onCancellationRequested(() => controller.abort());
	return Object.assign(controller, { dispose: () => cancellation.dispose() });
}

function stringOrEmpty(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
