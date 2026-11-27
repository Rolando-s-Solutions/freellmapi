import * as vscode from 'vscode';
import { errorMessageFromResponse, FreeLLMModel, normalizeBaseUrl, parseModelList } from './apiUtils';

const API_KEY_SECRET = 'freellmapi.apiKey';
const DEFAULT_BASE_URL = 'http://localhost:3001/v1';
const MODEL_CACHE_MS = 60_000;

interface OpenAIMessage {
	role: 'user' | 'assistant';
	content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> | null;
	name?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
}

interface StreamChunk {
	choices?: Array<{
		delta?: {
			content?: unknown;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
}

interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

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
		const tools = options.tools?.map(tool => ({
			type: 'function' as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? { type: 'object', properties: {} }
			}
		}));
		const body: Record<string, unknown> = {
			model: model.id,
			messages: convertMessages(messages),
			stream: true
		};
		if (tools?.length) {
			body.tools = tools;
			if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
				body.tool_choice = 'required';
			}
		}

		try {
			const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json',
					Accept: 'text/event-stream'
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(errorMessageFromResponse(response.status, await response.text(), apiKey));
			}
			if (!response.body) {
				throw new Error('FreeLLMAPI returned an empty streaming response.');
			}

			await readEventStream(response.body, chunk => reportChunk(chunk, progress), token);
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

async function readEventStream(
	stream: ReadableStream<Uint8Array>,
	onChunk: (chunk: StreamChunk) => void,
	token: vscode.CancellationToken
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const toolCalls = new Map<number, PendingToolCall>();
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
			const message = typeof parsed.error.message === 'string'
				? parsed.error.message
				: 'The model returned an error.';
			throw new Error(`FreeLLMAPI streaming error: ${message}`);
		}
		if (!Array.isArray(parsed.choices)) {
			throw new Error('FreeLLMAPI returned an invalid streaming response.');
		}

		const chunk = parsed as StreamChunk;
		for (const choice of chunk.choices ?? []) {
			const content = choice.delta?.content;
			if (typeof content === 'string' && content.length > 0) {
				onChunk({ choices: [{ delta: { content } }] });
			}
			for (const toolCall of choice.delta?.tool_calls ?? []) {
				const index = toolCall.index ?? toolCalls.size;
				const pending = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
				pending.id += toolCall.id ?? '';
				pending.name += toolCall.function?.name ?? '';
				pending.arguments += toolCall.function?.arguments ?? '';
				toolCalls.set(index, pending);
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
			if (token.isCancellationRequested) {
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
		buffer += decoder.decode();
		if (buffer.length > 0 && processLine(buffer.replace(/\r$/, ''))) {
			done = true;
		}
		if (!done) {
			dispatch();
		}
		for (const [index, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
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
			onChunk({
				choices: [{
					delta: {
						tool_calls: [{
							index,
							id: call.id || `freellmapi-call-${index}`,
							function: { name: call.name, arguments: JSON.stringify(input) }
						}]
					}
				}]
			});
		}
	} finally {
		reader.releaseLock();
	}
}

function reportChunk(
	chunk: StreamChunk,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
	for (const choice of chunk.choices ?? []) {
		const delta = choice.delta;
		if (typeof delta?.content === 'string') {
			progress.report(new vscode.LanguageModelTextPart(delta.content));
		}
		for (const toolCall of delta?.tool_calls ?? []) {
			const id = toolCall.id;
			const name = toolCall.function?.name;
			const argumentsText = toolCall.function?.arguments;
			if (id && name && argumentsText) {
				let input: unknown;
				try {
					input = JSON.parse(argumentsText);
				} catch {
					throw new Error(`FreeLLMAPI returned invalid arguments for tool “${name}”.`);
				}
				if (!isRecord(input)) {
					throw new Error(`FreeLLMAPI returned non-object arguments for tool “${name}”.`);
				}
				progress.report(new vscode.LanguageModelToolCallPart(id, name, input));
			}
		}
	}
}

export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const text: string[] = [];
			const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					text.push(part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({
						id: part.callId,
						type: 'function',
						function: { name: part.name, arguments: JSON.stringify(part.input) }
					});
				} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('text/')) {
					text.push(new TextDecoder().decode(part.data));
				} else {
					throw new Error('FreeLLMAPI cannot convert this assistant message content type.');
				}
			}
			result.push({
				role: 'assistant',
				content: text.join('') || (toolCalls.length > 0 ? null : ''),
				...(message.name ? { name: message.name } : {}),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
			});
			continue;
		}
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			throw new Error('FreeLLMAPI cannot convert this message role.');
		}

		const text: string[] = [];
		const userParts: NonNullable<Extract<OpenAIMessage['content'], unknown[]>> = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text.push(part.value);
				userParts.push({ type: 'text', text: part.value });
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				const base64 = Buffer.from(part.data).toString('base64');
				userParts.push({
					type: 'image_url',
					image_url: { url: `data:${part.mimeType};base64,${base64}` }
				});
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('text/')) {
				const value = new TextDecoder().decode(part.data);
				text.push(value);
				userParts.push({ type: 'text', text: value });
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				result.push({
					role: 'user',
					content: `Tool result for call ${part.callId}:\n${convertToolResult(part.content)}`
				});
			} else {
				throw new Error('FreeLLMAPI cannot convert this user message content type.');
			}
		}
		if (userParts.length > 0 || message.content.length === 0) {
			result.push({
				role: 'user',
				content: userParts.some(part => part.type === 'image_url') ? userParts : text.join(''),
				...(message.name ? { name: message.name } : {})
			});
		}
	}
	return result;
}

function convertToolResult(content: readonly unknown[]): string {
	return content.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('text/')) {
			return new TextDecoder().decode(part.data);
		}
		throw new Error('FreeLLMAPI cannot convert this tool result content type.');
	}).join('');
}

function abortOnCancellation(token: vscode.CancellationToken): AbortController & { dispose: () => void } {
	const controller = new AbortController();
	const cancellation = token.onCancellationRequested(() => controller.abort());
	return Object.assign(controller, { dispose: () => cancellation.dispose() });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
