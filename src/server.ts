import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  CodeAction,
  CodeActionKind,
  TextDocumentEdit,
  TextEdit,
  HoverParams,
  Hover,
  MarkupKind,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { StaticAnalyzer } from './analyzers/static';
import { LLMAnalyzer } from './analyzers/llm';
import { AnalysisCache } from './cache';
import { PromptDocument, AnalysisResult } from './types';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Initialize analyzers and cache
const staticAnalyzer = new StaticAnalyzer();
const llmAnalyzer = new LLMAnalyzer();
const cache = new AnalysisCache();

// Debounce timers for analysis
const debounceTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_DELAY = 500; // ms

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Hover provider for detailed explanations
      hoverProvider: true,
      // Code actions for quick fixes
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor],
      },
      // Document symbols for outline
      documentSymbolProvider: true,
    },
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }

  return result;
});

connection.onInitialized(() => {
  connection.console.log('Prompt LSP initialized');
});

// Handle document changes - static analysis only on keystroke
documents.onDidChangeContent((change) => {
  const uri = change.document.uri;

  // Cancel existing debounce timer
  const existingTimer = debounceTimers.get(uri);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Run static analysis immediately
  runStaticAnalysis(change.document);

  // Debounce full analysis
  const timer = setTimeout(() => {
    runDebouncedAnalysis(change.document);
    debounceTimers.delete(uri);
  }, DEBOUNCE_DELAY);

  debounceTimers.set(uri, timer);
});

// Full analysis on save
documents.onDidSave((event) => {
  runFullAnalysis(event.document);
});

// Full analysis when document is opened
documents.onDidOpen((event) => {
  runFullAnalysis(event.document);
});

// Run static analysis only (fast, on keystroke)
async function runStaticAnalysis(textDocument: TextDocument): Promise<void> {
  const promptDoc = parsePromptDocument(textDocument);
  const staticResults = staticAnalyzer.analyze(promptDoc);

  const diagnostics = resultsTodiagnostics(staticResults);
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Run debounced analysis (static refresh after pause)
async function runDebouncedAnalysis(textDocument: TextDocument): Promise<void> {
  const promptDoc = parsePromptDocument(textDocument);
  const staticResults = staticAnalyzer.analyze(promptDoc);

  const diagnostics = resultsTodiagnostics(staticResults);
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Run full analysis including LLM (on save)
async function runFullAnalysis(textDocument: TextDocument): Promise<void> {
  const promptDoc = parsePromptDocument(textDocument);
  const contentHash = cache.computeHash(textDocument.getText());

  // Check cache first
  const cachedResults = cache.get(contentHash);
  if (cachedResults) {
    const diagnostics = resultsTodiagnostics(cachedResults);
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    return;
  }

  // Run static analysis
  const staticResults = staticAnalyzer.analyze(promptDoc);

  // Run LLM analysis
  const llmResults = await llmAnalyzer.analyze(promptDoc);

  // Combine results
  const allResults = [...staticResults, ...llmResults];

  // Cache results
  cache.set(contentHash, allResults);

  // Send diagnostics
  const diagnostics = resultsTodiagnostics(allResults);
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Parse text document into prompt document structure
function parsePromptDocument(textDocument: TextDocument): PromptDocument {
  const text = textDocument.getText();
  const lines = text.split('\n');

  // Extract variables like {{variable_name}}
  const variables: Map<string, number[]> = new Map();
  const variablePattern = /\{\{(\w+)\}\}/g;

  lines.forEach((line, lineIndex) => {
    let match;
    while ((match = variablePattern.exec(line)) !== null) {
      const varName = match[1];
      const positions = variables.get(varName) || [];
      positions.push(lineIndex);
      variables.set(varName, positions);
    }
  });

  // Extract sections (markdown headers)
  const sections: { name: string; startLine: number; endLine: number }[] = [];
  let currentSection: { name: string; startLine: number } | null = null;

  lines.forEach((line, lineIndex) => {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      if (currentSection !== null) {
        sections.push({
          name: currentSection.name,
          startLine: currentSection.startLine,
          endLine: lineIndex - 1,
        });
      }
      currentSection = { name: headerMatch[2], startLine: lineIndex };
    }
  });

  if (currentSection !== null) {
    sections.push({
      name: (currentSection as { name: string; startLine: number }).name,
      startLine: (currentSection as { name: string; startLine: number }).startLine,
      endLine: lines.length - 1,
    });
  }

  return {
    uri: textDocument.uri,
    text,
    lines,
    variables,
    sections,
  };
}

// Convert analysis results to LSP diagnostics
function resultsTodiagnostics(results: AnalysisResult[]): Diagnostic[] {
  return results.map((result) => {
    let severity: DiagnosticSeverity;
    switch (result.severity) {
      case 'error':
        severity = DiagnosticSeverity.Error;
        break;
      case 'warning':
        severity = DiagnosticSeverity.Warning;
        break;
      case 'info':
        severity = DiagnosticSeverity.Information;
        break;
      default:
        severity = DiagnosticSeverity.Hint;
    }

    return {
      severity,
      range: result.range,
      message: result.message,
      source: `prompt-lsp (${result.analyzer})`,
      code: result.code,
      data: result.suggestion,
    };
  });
}

// Hover provider for detailed explanations
connection.onHover((params: HoverParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const position = params.position;
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });

  // Check for variable hover
  const variablePattern = /\{\{(\w+)\}\}/g;
  let match;
  while ((match = variablePattern.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Variable:** \`${match[1]}\`\n\nThis variable will be interpolated at runtime. Ensure it's defined in your context.`,
        },
      };
    }
  }

  // Check for instruction strength
  const strengthPatterns = staticAnalyzer.getStrengthPatterns();
  for (const [strength, patterns] of Object.entries(strengthPatterns)) {
    for (const pattern of patterns) {
      const regex = new RegExp(`\\b${pattern}\\b`, 'gi');
      let strengthMatch;
      while ((strengthMatch = regex.exec(line)) !== null) {
        const start = strengthMatch.index;
        const end = start + strengthMatch[0].length;
        if (position.character >= start && position.character <= end) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: `**Instruction Strength:** ${strength}\n\n${getStrengthDescription(strength)}`,
            },
          };
        }
      }
    }
  }

  return null;
});

function getStrengthDescription(strength: string): string {
  switch (strength) {
    case 'strong':
      return 'This is a **strong** instruction. The model will prioritize following this constraint.';
    case 'medium':
      return 'This is a **medium** strength instruction. Consider using stronger language for critical constraints.';
    case 'weak':
      return 'This is a **weak** instruction. The model may not reliably follow this. Consider using stronger language like "Never", "Must", or "Always".';
    default:
      return '';
  }
}

// Code actions for quick fixes
connection.onCodeAction((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const codeActions: CodeAction[] = [];

  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source?.startsWith('prompt-lsp') && diagnostic.data) {
      const suggestion = diagnostic.data as string;
      const action: CodeAction = {
        title: `Fix: ${suggestion}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        edit: {
          documentChanges: [
            TextDocumentEdit.create(
              { uri: params.textDocument.uri, version: document.version },
              [TextEdit.replace(diagnostic.range, suggestion)]
            ),
          ],
        },
      };
      codeActions.push(action);
    }
  }

  return codeActions;
});

// Document symbols for outline
connection.onDocumentSymbol((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const promptDoc = parsePromptDocument(document);
  return promptDoc.sections.map((section) => ({
    name: section.name,
    kind: 15, // SymbolKind.String (markdown section)
    range: {
      start: { line: section.startLine, character: 0 },
      end: { line: section.endLine, character: 0 },
    },
    selectionRange: {
      start: { line: section.startLine, character: 0 },
      end: { line: section.startLine, character: section.name.length + 2 },
    },
  }));
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();

// Handle clear cache notification from client
connection.onNotification('promptLSP/clearCache', () => {
  cache.clear();
  connection.console.log('Analysis cache cleared');
});
