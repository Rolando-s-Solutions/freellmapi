const assert = require('node:assert/strict');
const test = require('node:test');
const {
	DEFAULT_BASE_URL,
	errorMessageFromResponse,
	normalizeBaseUrl,
	parseModelList
} = require('../out/apiUtils.js');
const packageJson = require('../package.json');

test('defaults to the FreeLLMAPI desktop app URL (AC-1)', () => {
	assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:31415/v1');
	assert.equal(packageJson.contributes.configuration.properties['freellmapi.baseUrl'].default, DEFAULT_BASE_URL);
	assert.equal(normalizeBaseUrl(DEFAULT_BASE_URL), DEFAULT_BASE_URL);
});

test('derives tool calling from supported_parameters (AC-2)', () => {
	const toolParams = ['temperature', 'stream', 'tools', 'tool_choice'];
	const models = parseModelList({
		data: [
			{ id: 'auto' },
			{ id: 'claude-sonnet-4-5' },
			{ id: 'fusion' },
			{ id: 'glm-5.3-flash', supported_parameters: toolParams },
			{ id: 'deepseek-v4-flash-0731', supported_parameters: ['temperature', 'stream'] }
		]
	});
	const byId = Object.fromEntries(models.map(model => [model.id, model.capabilities.toolCalling]));
	assert.deepEqual(byId, {
		'auto': true,
		'claude-sonnet-4-5': true,
		'fusion': false,
		'glm-5.3-flash': true,
		'deepseek-v4-flash-0731': false
	});
});

test('normalizes root and versioned API URLs without duplicating /v1', () => {
	assert.equal(normalizeBaseUrl('http://localhost:3001'), 'http://localhost:3001/v1');
	assert.equal(normalizeBaseUrl('http://localhost:3001/v1/'), 'http://localhost:3001/v1');
	assert.equal(normalizeBaseUrl('https://api.example.test/gateway'), 'https://api.example.test/gateway/v1');
});

test('rejects API URLs with credentials or unsupported schemes', () => {
	assert.throws(() => normalizeBaseUrl('ftp://localhost:3001'), /HTTP or HTTPS/);
	assert.throws(() => normalizeBaseUrl('https://user:pass@example.test'), /must not contain credentials/);
});

test('parses ready models, marks Auto image-capable, and ignores malformed entries', () => {
	const models = parseModelList({
		data: [
			{ id: 'auto' },
			{ id: 'vision-model', input_modalities: ['text', 'image'], max_input_tokens: 64000 },
			{ id: 'text-model', context_length: 32000 },
			{ id: 42 }
		]
	});

	assert.equal(models.length, 3);
	assert.equal(models[0].name, 'FreeLLMAPI Auto');
	assert.equal(models[0].capabilities.imageInput, true);
	assert.equal(models[0].capabilities.toolCalling, true);
	assert.equal(models[1].maxInputTokens, 64000);
	assert.equal(models[1].capabilities.imageInput, true);
	assert.equal(models[2].maxInputTokens, 32000);
	assert.equal(models[2].capabilities.imageInput, false);
});

test('redacts the API key from server error details', () => {
	assert.equal(
		errorMessageFromResponse(401, '{"error":{"message":"bad key freellmapi-secret"}}', 'freellmapi-secret'),
		'FreeLLMAPI request failed (401): bad key [redacted]'
	);
});
