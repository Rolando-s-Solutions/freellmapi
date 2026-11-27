.PHONY: vsix

vsix:
	npx --yes @vscode/vsce package
