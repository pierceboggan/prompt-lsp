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
  CodeLens,
  Location,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';

import { StaticAnalyzer } from './analyzers/static';
import { LLMAnalyzer } from './analyzers/llm';
import { AnalysisCache } from './cache';
import { parsePromptDocument } from './parsing';
import { PromptDocument, AnalysisResult, LLMProxyRequest, LLMProxyResponse } from './types';
import {
  createCodeLenses,
  findCompositionLinkAtPosition,
  findFirstVariableOccurrence,
  getVariableNameAtPosition,
} from './lspFeatures';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Initialize analyzers and cache
const staticAnalyzer = new StaticAnalyzer();
const llmAnalyzer = new LLMAnalyzer();
const cache = new AnalysisCache();

// Debounce timers for analysis
const llmDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
const recentlyOpened: Set<string> = new Set();
const documentVersions: Map<string, number> = new Map();
const LLM_DEBOUNCE_DELAY = 2000; // ms - longer delay for LLM to avoid excessive API calls

// Parse cache: avoids re-parsing on every CodeLens/Hover/Definition request
const parsedDocumentCache: Map<string, { version: number; doc: PromptDocument }> = new Map();

let workspaceRoot: string | undefined;

interface ServerConfig {
  enableLLMAnalysis: boolean;
  maxTokenBudget: number;
  targetModel: string;
}

let serverConfig: ServerConfig = {
  enableLLMAnalysis: true,
  maxTokenBudget: 4096,
  targetModel: 'auto',
};

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Store last STATIC analysis results per URI for CodeLens issue summary
const lastStaticAnalysisResults: Map<string, AnalysisResult[]> = new Map();

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );

  // Capture workspace root for path traversal validation
  if (params.rootUri) {
    try { workspaceRoot = fileURLToPath(params.rootUri); } catch { /* ignore */ }
  } else if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    try { workspaceRoot = fileURLToPath(params.workspaceFolders[0].uri); } catch { /* ignore */ }
  }

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: false },
      },
      // Hover provider for detailed explanations
      hoverProvider: true,
      // Code actions for quick fixes
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor],
      },
      // Document symbols for outline
      documentSymbolProvider: true,
      // Go to Definition for variables and composition links
      definitionProvider: true,
      // CodeLens for token counts and issue summary
      codeLensProvider: { resolveProvider: false },
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

  // Set up LLM proxy: server sends requests to client, client calls vscode.lm
  llmAnalyzer.setProxyFn(async (request: LLMProxyRequest): Promise<LLMProxyResponse> => {
    try {
      connection.console.log('[LLM Proxy] Sending request to client...');
      const response = await connection.sendRequest<LLMProxyResponse>('promptLSP/llmRequest', request);
      if (response.error) {
        connection.console.log(`[LLM Proxy] Client returned error: ${response.error}`);
      } else {
        connection.console.log(`[LLM Proxy] Got response (${response.text.length} chars)`);
      }
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Proxy request failed';
      connection.console.log(`[LLM Proxy] Request failed: ${msg}`);
      return {
        text: '{}',
        error: msg,
      };
    }
  });

  // Fetch initial configuration
  updateConfiguration();
});

// Watch for configuration changes
connection.onDidChangeConfiguration(() => {
  updateConfiguration();
});

async function updateConfiguration(): Promise<void> {
  if (!hasConfigurationCapability) return;
  try {
    const config = await connection.workspace.getConfiguration('promptLSP');
    if (config) {
      serverConfig = {
        enableLLMAnalysis: config.enableLLMAnalysis ?? true,
        maxTokenBudget: config.maxTokenBudget ?? 4096,
        targetModel: config.targetModel ?? 'auto',
      };
    }
  } catch {
    // Configuration not available
  }
}

// Handle document changes - static analysis immediately, LLM analysis after pause
documents.onDidChangeContent((change) => {
  const uri = change.document.uri;

  // Cancel existing LLM debounce timer
  const existingLLMTimer = llmDebounceTimers.get(uri);
  if (existingLLMTimer) {
    clearTimeout(existingLLMTimer);
  }

  // Skip analysis for initial content event on open (onDidOpen already triggers it)
  if (recentlyOpened.has(uri)) {
    recentlyOpened.delete(uri);
    return;
  }

  // Run quick static analysis immediately (cheap checks only, no token counting or FS access)
  runStaticAnalysis(change.document);

  // Debounce full analysis (including LLM) with longer delay
  const llmTimer = setTimeout(() => {
    runFullAnalysis(change.document);
    llmDebounceTimers.delete(uri);
  }, LLM_DEBOUNCE_DELAY);
  llmDebounceTimers.set(uri, llmTimer);
});

// Full analysis on save
documents.onDidSave((event) => {
  runFullAnalysis(event.document);
});

// Full analysis when document is opened
documents.onDidOpen((event) => {
  recentlyOpened.add(event.document.uri);
  runFullAnalysis(event.document);
});

// Run quick static analysis only (fast, on keystroke — no token counting or FS access)
function getCachedPromptDocument(textDocument: TextDocument): PromptDocument {
  const uri = textDocument.uri;
  const version = textDocument.version;
  const cached = parsedDocumentCache.get(uri);
  if (cached && cached.version === version) {
    return cached.doc;
  }
  const doc = parsePromptDocument({ uri, text: textDocument.getText(), workspaceRoot });
  parsedDocumentCache.set(uri, { version, doc });
  return doc;
}

async function runStaticAnalysis(textDocument: TextDocument): Promise<void> {
  const promptDoc = getCachedPromptDocument(textDocument);
  const staticResults = staticAnalyzer.analyzeQuick(promptDoc);

  lastStaticAnalysisResults.set(textDocument.uri, staticResults);

  const diagnostics = resultsTodiagnostics(staticResults);
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Run full analysis including LLM (on save)
async function runFullAnalysis(textDocument: TextDocument): Promise<void> {
  const uri = textDocument.uri;
  const version = textDocument.version;

  // Track this analysis version to detect stale results
  documentVersions.set(uri, version);

  connection.console.log(`[Analysis] Running full analysis on ${uri}`);
  const promptDoc = getCachedPromptDocument(textDocument);
  const contentHash = await computeCompositeHash(textDocument, promptDoc);

  // Discard if document changed since analysis started
  if (documentVersions.get(uri) !== version) {
    connection.console.log('[Analysis] Document changed, discarding stale results');
    return;
  }

  // Check cache first
  const cachedResults = cache.get(contentHash);
  if (cachedResults) {
    connection.console.log('[Analysis] Using cached results');
    // Refresh static-only results for CodeLens issue summary.
    lastStaticAnalysisResults.set(uri, staticAnalyzer.analyze(promptDoc));
    const diagnostics = resultsTodiagnostics(cachedResults);
    connection.sendDiagnostics({ uri, diagnostics });
    return;
  }

  // Run static analysis
  const staticResults = staticAnalyzer.analyze(promptDoc);
  connection.console.log(`[Analysis] Static: ${staticResults.length} issues`);

  // Store static results for CodeLens issue summary
  lastStaticAnalysisResults.set(uri, staticResults);

  // Run LLM analysis (if enabled and available)
  let llmResults: AnalysisResult[] = [];
  if (serverConfig.enableLLMAnalysis) {
    connection.console.log(`[Analysis] LLM available: ${llmAnalyzer.isAvailable()}`);
    llmResults = await llmAnalyzer.analyze(promptDoc);
    connection.console.log(`[Analysis] LLM: ${llmResults.length} issues`);
  }

  // Discard if document changed during LLM analysis
  if (documentVersions.get(uri) !== version) {
    connection.console.log('[Analysis] Document changed during analysis, discarding');
    return;
  }

  // Combine results
  const allResults = [...staticResults, ...llmResults];

  // Cache results
  cache.set(contentHash, allResults);

  // Send diagnostics
  const diagnostics = resultsTodiagnostics(allResults);
  connection.sendDiagnostics({ uri, diagnostics });
  connection.console.log(`[Analysis] Sent ${diagnostics.length} diagnostics`);
}

async function computeCompositeHash(textDocument: TextDocument, promptDoc: PromptDocument): Promise<string> {
  let compositeText = textDocument.getText();

  if (promptDoc.compositionLinks && promptDoc.compositionLinks.length > 0) {
    for (const link of promptDoc.compositionLinks) {
      if (!link.resolvedPath) continue;
      try {
        const linkedText = await fs.promises.readFile(link.resolvedPath, 'utf8');
        compositeText += `\n\n--- link:${link.target} ---\n${linkedText}`;
      } catch {
        // Missing/unreadable links are handled by static analyzer
      }
    }
  }

  return cache.computeHash(compositeText);
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

// Go to Definition for variables and composition links
connection.onDefinition((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const promptDoc = getCachedPromptDocument(document);
  const position = params.position;
  const lineText = promptDoc.lines[position.line] ?? '';

  // Check if cursor is on a {{variable}}
  const variableName = getVariableNameAtPosition(lineText, position.character);
  if (variableName) {
    const occurrence = findFirstVariableOccurrence(promptDoc, variableName);
    if (occurrence) {
      return Location.create(params.textDocument.uri, {
        start: { line: occurrence.line, character: occurrence.character },
        end: { line: occurrence.line, character: occurrence.character + occurrence.length },
      });
    }
  }

  // Check if cursor is on a composition link target (inside parentheses)
  const link = findCompositionLinkAtPosition(promptDoc, position.line, position.character);
  if (link?.resolvedPath) {
    try {
      fs.accessSync(link.resolvedPath, fs.constants.R_OK);
      const targetUri = pathToFileURL(link.resolvedPath).toString();
      return Location.create(targetUri, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      });
    } catch {
      // Missing/unreadable links are handled by diagnostics
    }
  }

  return null;
});

// CodeLens for token counts and issue summary
connection.onCodeLens((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const promptDoc = getCachedPromptDocument(document);

  return createCodeLenses(
    promptDoc,
    lastStaticAnalysisResults.get(params.textDocument.uri),
    staticAnalyzer,
  );
});

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
    if (!diagnostic.source?.startsWith('prompt-lsp')) continue;

    // Suggestion-based quick fix (from diagnostic.data)
    if (diagnostic.data) {
      const suggestion = diagnostic.data as string;
      let title: string;
      switch (diagnostic.code) {
        case 'ambiguous-quantifier':
          title = `Replace with "${suggestion}"`;
          break;
        case 'weak-instruction':
          title = `Strengthen to "${suggestion}"`;
          break;
        default:
          title = `Fix: ${suggestion}`;
      }
      codeActions.push({
        title,
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
      });
    }

    // Code-specific actions
    switch (diagnostic.code) {
      case 'empty-variable':
        codeActions.push({
          title: 'Remove empty placeholder',
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            documentChanges: [
              TextDocumentEdit.create(
                { uri: params.textDocument.uri, version: document.version },
                [TextEdit.replace(diagnostic.range, '')]
              ),
            ],
          },
        });
        break;
      case 'agent-missing-description': {
        const insertLine = diagnostic.range.start.line + 1;
        codeActions.push({
          title: 'Add description field',
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            documentChanges: [
              TextDocumentEdit.create(
                { uri: params.textDocument.uri, version: document.version },
                [TextEdit.insert({ line: insertLine, character: 0 }, 'description: \n')]
              ),
            ],
          },
        });
        break;
      }
      case 'skill-missing-frontmatter':
        codeActions.push({
          title: 'Add skill frontmatter',
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          edit: {
            documentChanges: [
              TextDocumentEdit.create(
                { uri: params.textDocument.uri, version: document.version },
                [TextEdit.insert({ line: 0, character: 0 }, '---\nname: \ndescription: \n---\n')]
              ),
            ],
          },
        });
        break;
    }
  }

  return codeActions;
});

// Document symbols for outline
connection.onDocumentSymbol((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const promptDoc = getCachedPromptDocument(document);
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

// Handle clear cache notification from client
connection.onNotification('promptLSP/clearCache', () => {
  cache.clear();
  connection.console.log('Analysis cache cleared');
});

// Handle manual analysis trigger from client
connection.onNotification('promptLSP/analyze', (params: { uri: string }) => {
  const document = documents.get(params.uri);
  if (document) {
    // Clear cache for this document so we get fresh results
    cache.clear();
    connection.console.log(`[Analysis] Manual analysis triggered for ${params.uri}`);
    runFullAnalysis(document);
  } else {
    connection.console.log(`[Analysis] No document found for ${params.uri}`);
  }
});

// Token count request for client status bar
connection.onRequest('promptLSP/tokenCount', (params: { uri: string }): number => {
  const document = documents.get(params.uri);
  if (!document) return 0;
  return staticAnalyzer.getTokenCount(document.getText());
});

// Clean up per-document state when documents are closed
documents.onDidClose((event) => {
  const uri = event.document.uri;
  parsedDocumentCache.delete(uri);
  lastStaticAnalysisResults.delete(uri);
  documentVersions.delete(uri);
  const timer = llmDebounceTimers.get(uri);
  if (timer) clearTimeout(timer);
  llmDebounceTimers.delete(uri);
  recentlyOpened.delete(uri);
});

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
