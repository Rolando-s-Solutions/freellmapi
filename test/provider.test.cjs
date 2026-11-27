const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}

class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}

class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}

class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}

class LanguageModelPromptTsxPart {
	constructor(value) {
		this.value = value;
	}
}

class CancellationError extends Error {}

const vscode = {
	CancellationError,
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	LanguageModelChatToolMode: { Auto: 1, Required: 2 },
	LanguageModelDataPart,
	LanguageModelPromptTsxPart,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscode;
	}
	return originalLoad.call(this, request, parent, isMain);
};

let provider;
try {
	provider = require('../out/provider.js');
} finally {
	Module._load = originalLoad;
}
const { buildRequestBody, convertMessages, parseEventStream, parseJsonCompletion } = provider;

const User = vscode.LanguageModelChatMessageRole.User;
const Assistant = vscode.LanguageModelChatMessageRole.Assistant;
const System = 3;

const msg = (role, content, name) => ({ role, content, name });
const text = value => new LanguageModelTextPart(value);

function model(id, toolCalling) {
	return {
		id,
		name: id,
		family: 'freellmapi',
		version: '1',
		maxInputTokens: 1000,
		maxOutputTokens: 100,
		capabilities: { toolCalling, imageInput: false }
	};
}

function sseStream(...chunks) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		}
	});
}

const data = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\r\n\r\n`;

function collect() {
	const parts = [];
	return { parts, report: part => parts.push(part) };
}

const reportedText = parts => parts.filter(part => part instanceof LanguageModelTextPart).map(part => part.value).join('');

// --- T-03 / AC-2: request body ---------------------------------------------------------------

const tools = [{ name: 'get_time', description: 'Get time', inputSchema: { type: 'object', properties: {} } }];

test('includes tools and tool_choice only for tool-capable models (AC-2)', () => {
	const messages = [msg(User, [text('Hi')])];
	const withTools = buildRequestBody(model('auto', true), messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Required });
	assert.equal(withTools.model, 'auto');
	assert.equal(withTools.stream, true);
	assert.deepEqual(withTools.tools, [{
		type: 'function',
		function: { name: 'get_time', description: 'Get time', parameters: { type: 'object', properties: {} } }
	}]);
	assert.equal(withTools.tool_choice, 'required');

	const autoMode = buildRequestBody(model('auto', true), messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Auto });
	assert.equal('tool_choice' in autoMode, false);

	const noTools = buildRequestBody(model('deepseek-v4-flash-0731', false), messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Required });
	assert.equal('tools' in noTools, false);
	assert.equal('tool_choice' in noTools, false);
});

// --- T-04 / T-05 / AC-5: rich parts, names, system role -------------------------------------

test('decodes JSON and prompt-tsx parts, ignores unknown parts and sanitizes names (AC-5)', () => {
	const json = new LanguageModelDataPart(new TextEncoder().encode('{"a":1}'), 'application/json');
	const vendorJson = new LanguageModelDataPart(new TextEncoder().encode('{"b":2}'), 'application/vnd.test+json');
	const tsx = new LanguageModelPromptTsxPart({ node: { type: 1, children: [{ type: 2, text: 'from tsx' }] } });
	const result = convertMessages([msg(User, [text('ctx '), json, vendorJson, tsx, { unexpected: true }], 'GitHub Copilot')]);
	assert.deepEqual(result, [{ role: 'user', content: 'ctx {"a":1}{"b":2}from tsx', name: 'GitHub_Copilot' }]);
});

test('drops names that have no valid characters (AC-5)', () => {
	const result = convertMessages([msg(User, [text('Hi')], '!!!')]);
	assert.deepEqual(result, [{ role: 'user', content: 'Hi' }]);
});

test('maps non user/assistant roles to the system role (AC-5)', () => {
	const result = convertMessages([msg(System, [text('Be brief.')]), msg(User, [text('Hi')])]);
	assert.deepEqual(result, [
		{ role: 'system', content: 'Be brief.' },
		{ role: 'user', content: 'Hi' }
	]);
});

// --- T-06 / T-07 / AC-3 / AC-4: tool messages ------------------------------------------------

const toolHistory = () => [
	msg(User, [text('What time is it?')]),
	msg(Assistant, [new LanguageModelToolCallPart('call-1', 'get_time', { tz: 'UTC' })]),
	msg(User, [new LanguageModelToolResultPart('call-1', [text('12:00')]), text('Thanks')])
];

test('emits role tool messages right after assistant tool calls (AC-3)', () => {
	assert.deepEqual(convertMessages(toolHistory(), { toolCalling: true }), [
		{ role: 'user', content: 'What time is it?' },
		{
			role: 'assistant',
			content: null,
			tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }]
		},
		{ role: 'tool', tool_call_id: 'call-1', content: '12:00' },
		{ role: 'user', content: 'Thanks' }
	]);
});

test('degrades tool history to plain text for models without tool calling (AC-4)', () => {
	const result = convertMessages(toolHistory(), { toolCalling: false });
	assert.equal(result.some(message => message.role === 'tool' || 'tool_calls' in message), false);
	assert.deepEqual(result, [
		{ role: 'user', content: 'What time is it?' },
		{ role: 'assistant', content: 'Called tool get_time (call call-1) with arguments: {"tz":"UTC"}' },
		{ role: 'user', content: 'Tool result for call call-1:\n12:00' },
		{ role: 'user', content: 'Thanks' }
	]);
});

test('degrades orphan tool results without a matching tool call (AC-4)', () => {
	const result = convertMessages([msg(User, [new LanguageModelToolResultPart('call-9', [text('42')])])], { toolCalling: true });
	assert.deepEqual(result, [{ role: 'user', content: 'Tool result for call call-9:\n42' }]);
});

// --- T-08 / AC-6: SSE parsing ----------------------------------------------------------------

test('parses SSE with comments, choice-less chunks, usage and [DONE] (AC-6)', async () => {
	const { parts, report } = collect();
	await parseEventStream(sseStream(
		': keep-alive\r\n\r\n',
		data({ id: 'x', object: 'chat.completion.chunk' }),
		data({ choices: [{ delta: { role: 'assistant', content: '', reasoning: 'thinking' } }] }),
		data({ choices: [{ delta: { content: 'Hel' } }] }),
		data({ choices: [{ delta: { content: 'lo' } }] }),
		data({ choices: [], usage: { total_tokens: 3 } }),
		data('[DONE]')
	), report);
	assert.equal(reportedText(parts), 'Hello');
});

test('falls back to reasoning text when no content is streamed (AC-6)', async () => {
	const { parts, report } = collect();
	await parseEventStream(sseStream(
		data({ choices: [{ delta: { content: '', reasoning: 'The answer ' } }] }),
		data({ choices: [{ delta: { reasoning_content: 'is 4.' } }] }),
		data('[DONE]')
	), report);
	assert.equal(reportedText(parts), 'The answer is 4.');
});

test('assembles streamed tool calls (AC-6)', async () => {
	const { parts, report } = collect();
	await parseEventStream(sseStream(
		data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'get_', arguments: '{"tz":' } }] } }] }),
		data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'time', arguments: '"UTC"}' } }] } }] }),
		data('[DONE]')
	), report);
	const calls = parts.filter(part => part instanceof LanguageModelToolCallPart);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].callId, 'call-1');
	assert.equal(calls[0].name, 'get_time');
	assert.deepEqual(calls[0].input, { tz: 'UTC' });
});

test('still surfaces streamed error payloads (AC-6)', async () => {
	const { report } = collect();
	await assert.rejects(
		parseEventStream(sseStream(data({ error: { message: 'rate limited' } })), report),
		/FreeLLMAPI streaming error: rate limited/
	);
});

// --- T-09 / AC-6: JSON completion fallback ---------------------------------------------------

test('parses non-streaming JSON completions (AC-6)', () => {
	const { parts, report } = collect();
	parseJsonCompletion({
		object: 'chat.completion',
		choices: [{
			message: {
				role: 'assistant',
				content: 'Done.',
				tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'get_time', arguments: '{}' } }]
			}
		}]
	}, report);
	assert.equal(reportedText(parts), 'Done.');
	const calls = parts.filter(part => part instanceof LanguageModelToolCallPart);
	assert.deepEqual(calls.map(call => [call.callId, call.name, call.input]), [['call-2', 'get_time', {}]]);
});

test('uses reasoning from JSON completions when content is empty and rejects error payloads (AC-6)', () => {
	const { parts, report } = collect();
	parseJsonCompletion({ choices: [{ message: { content: '', reasoning: 'Only reasoning' } }] }, report);
	assert.equal(reportedText(parts), 'Only reasoning');
	assert.throws(() => parseJsonCompletion({ error: { message: 'bad' } }, report), /FreeLLMAPI request failed: bad/);
});
