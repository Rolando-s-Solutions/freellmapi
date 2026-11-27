import * as vscode from 'vscode';
import { normalizeBaseUrl } from './apiUtils';
import { FreeLLMAPIProvider } from './provider';

const API_KEY_SECRET = 'freellmapi.apiKey';
const DEFAULT_BASE_URL = 'http://localhost:3001/v1';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new FreeLLMAPIProvider(context);
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('freellmapi', provider),
		provider,
		vscode.commands.registerCommand('freellmapi.configure', () => configureConnection(context, provider))
	);
}

async function configureConnection(context: vscode.ExtensionContext, provider: FreeLLMAPIProvider): Promise<void> {
	const currentUrl = vscode.workspace.getConfiguration('freellmapi').get<string>('baseUrl', DEFAULT_BASE_URL);
	const baseUrl = await vscode.window.showInputBox({
		title: 'Configure FreeLLMAPI',
		prompt: 'Enter the FreeLLMAPI OpenAI-compatible base URL.',
		value: currentUrl,
		placeHolder: 'http://localhost:3001/v1',
		validateInput: value => {
			try {
				normalizeBaseUrl(value);
				return undefined;
			} catch (error) {
				return error instanceof Error ? error.message : 'Enter a valid HTTP or HTTPS URL.';
			}
		}
	});
	if (baseUrl === undefined) {
		return;
	}

	const apiKey = await vscode.window.showInputBox({
		title: 'Configure FreeLLMAPI',
		prompt: 'Enter the unified API key from the FreeLLMAPI dashboard.',
		password: true,
		ignoreFocusOut: true,
		validateInput: value => value.trim().length > 0 ? undefined : 'The API key cannot be empty.'
	});
	if (apiKey === undefined) {
		return;
	}

	const normalizedUrl = normalizeBaseUrl(baseUrl);
	await vscode.workspace.getConfiguration('freellmapi').update(
		'baseUrl',
		normalizedUrl,
		vscode.ConfigurationTarget.Global
	);
	await context.secrets.store(API_KEY_SECRET, apiKey.trim());
	provider.clearModelCache();
	void vscode.window.showInformationMessage('FreeLLMAPI connection saved. Select a FreeLLMAPI model in the Chat model picker.');
}

export function deactivate(): void {}
