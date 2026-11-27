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

class LanguageModelDataPart {}

const vscode = {
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	LanguageModelDataPart,
	LanguageModelTextPart,
	LanguageModelToolCallPart: class {},
	LanguageModelToolResultPart
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscode;
	}
	return originalLoad.call(this, request, parent, isMain);
};

let convertMessages;
try {
	({ convertMessages } = require('../out/provider.js'));
} finally {
	Module._load = originalLoad;
}

test('converts tool results to user messages for role-limited API compatibility', () => {
	const result = convertMessages([{
		role: vscode.LanguageModelChatMessageRole.User,
		name: undefined,
		content: [
			new LanguageModelToolResultPart('call-1', [new LanguageModelTextPart('42')])
		]
	}]);

	assert.deepEqual(result, [{
		role: 'user',
		content: 'Tool result for call call-1:\n42'
	}]);
});
