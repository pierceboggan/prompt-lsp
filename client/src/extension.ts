import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
  // Path to the server module
  const serverModule = context.asAbsolutePath(path.join('..', 'out', 'server.js'));

  // Debug options for the server
  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // Server options - run the server module
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  // Client options
  const clientOptions: LanguageClientOptions = {
    // Register the server for prompt documents
    documentSelector: [
      { scheme: 'file', language: 'prompt' },
      { scheme: 'file', pattern: '**/*.prompt.md' },
      { scheme: 'file', pattern: '**/*.system.md' },
      { scheme: 'file', pattern: '**/*.agent.md' },
      { scheme: 'file', pattern: '**/*.prompt' },
      // Also support markdown files with certain patterns
      { scheme: 'file', language: 'markdown', pattern: '**/prompts/**/*.md' },
    ],
    synchronize: {
      // Notify the server about file changes to prompt files
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{prompt.md,system.md,agent.md,prompt}'),
    },
    outputChannel: vscode.window.createOutputChannel('Prompt LSP'),
  };

  // Create the language client
  client = new LanguageClient(
    'promptLSP',
    'Prompt LSP',
    serverOptions,
    clientOptions
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('promptLSP.analyzePrompt', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        // Force re-analysis by making a fake edit
        vscode.commands.executeCommand('editor.action.formatDocument');
        vscode.window.showInformationMessage('Analyzing prompt...');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptLSP.showTokenCount', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const text = editor.document.getText();
        // Rough estimation: ~4 characters per token for English
        const estimatedTokens = Math.ceil(text.length / 4);
        vscode.window.showInformationMessage(
          `Estimated tokens: ~${estimatedTokens} (${text.length} characters)`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('promptLSP.clearCache', () => {
      // Send notification to server to clear cache
      client.sendNotification('promptLSP/clearCache');
      vscode.window.showInformationMessage('Analysis cache cleared.');
    })
  );

  // Create status bar item for token count
  const tokenStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  tokenStatusBar.command = 'promptLSP.showTokenCount';
  context.subscriptions.push(tokenStatusBar);

  // Update token count on active editor change
  const updateTokenCount = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isPromptDocument(editor.document)) {
      const text = editor.document.getText();
      const estimatedTokens = Math.ceil(text.length / 4);
      tokenStatusBar.text = `$(symbol-number) ~${estimatedTokens} tokens`;
      tokenStatusBar.tooltip = 'Estimated token count (click for details)';
      tokenStatusBar.show();
    } else {
      tokenStatusBar.hide();
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateTokenCount)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor?.document === e.document) {
        updateTokenCount();
      }
    })
  );

  // Start the client
  client.start();

  // Initial update
  updateTokenCount();

  console.log('Prompt LSP extension activated');
}

function isPromptDocument(document: vscode.TextDocument): boolean {
  const fileName = document.fileName.toLowerCase();
  return (
    document.languageId === 'prompt' ||
    fileName.endsWith('.prompt.md') ||
    fileName.endsWith('.system.md') ||
    fileName.endsWith('.agent.md') ||
    fileName.endsWith('.prompt')
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
