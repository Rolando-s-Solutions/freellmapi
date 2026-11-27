export interface FreeLLMModel {
	id: string;
	name: string;
	family: string;
	version: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean;
		imageInput: boolean;
	};
}

interface ModelRecord {
	id?: unknown;
	name?: unknown;
	owned_by?: unknown;
	family?: unknown;
	version?: unknown;
	context_length?: unknown;
	context_window?: unknown;
	max_input_tokens?: unknown;
	max_output_tokens?: unknown;
	input_modalities?: unknown;
	supports_vision?: unknown;
}

export function normalizeBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error('Enter a valid FreeLLMAPI URL.');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('The FreeLLMAPI URL must use HTTP or HTTPS.');
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error('The FreeLLMAPI URL must not contain credentials, a query, or a fragment.');
	}

	const path = url.pathname.replace(/\/+$/, '');
	url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
	return url.toString().replace(/\/$/, '');
}

export function parseModelList(payload: unknown): FreeLLMModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error('FreeLLMAPI returned an invalid model list.');
	}

	const models = new Map<string, FreeLLMModel>();
	for (const item of payload.data) {
		if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) {
			continue;
		}

		const model = item as ModelRecord;
		const id = model.id as string;
		const inputModalities = Array.isArray(model.input_modalities) ? model.input_modalities : [];
		const imageInput = id === 'auto' || model.supports_vision === true ||
			inputModalities.some(modality => typeof modality === 'string' && modality.toLowerCase() === 'image');
		models.set(id, {
			id,
			name: typeof model.name === 'string' ? model.name : id === 'auto' ? 'FreeLLMAPI Auto' : id,
			family: typeof model.family === 'string'
				? model.family
				: typeof model.owned_by === 'string' ? model.owned_by : 'FreeLLMAPI',
			version: typeof model.version === 'string' ? model.version : '1',
			maxInputTokens: positiveNumber(model.max_input_tokens) ??
				positiveNumber(model.context_length) ??
				positiveNumber(model.context_window) ??
				128_000,
			maxOutputTokens: positiveNumber(model.max_output_tokens) ?? 8_192,
			capabilities: {
				toolCalling: true,
				imageInput
			}
		});
	}

	return [...models.values()];
}

export function errorMessageFromResponse(status: number, body: string, apiKey: string): string {
	let detail = body.trim();
	try {
		const payload: unknown = JSON.parse(detail);
		if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string') {
			detail = payload.error.message;
		}
	} catch {
		// Keep the response text when the server does not return JSON.
	}
	detail = detail.replaceAll(apiKey, '[redacted]').slice(0, 500);
	return `FreeLLMAPI request failed (${status})${detail ? `: ${detail}` : '.'}`;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
