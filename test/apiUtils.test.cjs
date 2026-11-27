const assert = require('node:assert/strict');
const test = require('node:test');
const {
	errorMessageFromResponse,
	normalizeBaseUrl,
	parseModelList
} = require('../out/apiUtils.js');

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
