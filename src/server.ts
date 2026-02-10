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
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { StaticAnalyzer } from './analyzers/static';
import { LLMAnalyzer } from './analyzers/llm';
import { AnalysisCache } from './cache';
import { PromptDocument, AnalysisResult, CompositionLink, LLMProxyRequest, LLMProxyResponse } from './types';

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
const llmDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_DELAY = 500; // ms
const LLM_DEBOUNCE_DELAY = 2000; // ms - longer delay for LLM to avoid excessive API calls

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
  // No LLM-specific config needed — Copilot is auto-detected via vscode.lm
}

// Handle document changes - static analysis immediately, LLM analysis after pause
documents.onDidChangeContent((change) => {
  const uri = change.document.uri;

  // Cancel existing debounce timers
  const existingTimer = debounceTimers.get(uri);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const existingLLMTimer = llmDebounceTimers.get(uri);
  if (existingLLMTimer) {
    clearTimeout(existingLLMTimer);
  }

  // Run static analysis immediately
  runStaticAnalysis(change.document);

  // Debounce static refresh
  const timer = setTimeout(() => {
    runDebouncedAnalysis(change.document);
    debounceTimers.delete(uri);
  }, DEBOUNCE_DELAY);
  debounceTimers.set(uri, timer);

  // Debounce LLM analysis with longer delay
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
  connection.console.log(`[Analysis] Running full analysis on ${textDocument.uri}`);
  const promptDoc = parsePromptDocument(textDocument);
  const contentHash = computeCompositeHash(textDocument, promptDoc);

  // Check cache first
  const cachedResults = cache.get(contentHash);
  if (cachedResults) {
    connection.console.log('[Analysis] Using cached results');
    const diagnostics = resultsTodiagnostics(cachedResults);
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    return;
  }

  // Run static analysis
  const staticResults = staticAnalyzer.analyze(promptDoc);
  connection.console.log(`[Analysis] Static: ${staticResults.length} issues`);

  // Run LLM analysis
  connection.console.log(`[Analysis] LLM available: ${llmAnalyzer.isAvailable()}`);
  const llmResults = await llmAnalyzer.analyze(promptDoc);
  connection.console.log(`[Analysis] LLM: ${llmResults.length} issues`);

  // Combine results
  const allResults = [...staticResults, ...llmResults];

  // Cache results
  cache.set(contentHash, allResults);

  // Send diagnostics
  const diagnostics = resultsTodiagnostics(allResults);
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
  connection.console.log(`[Analysis] Sent ${diagnostics.length} diagnostics`);
}

function computeCompositeHash(textDocument: TextDocument, promptDoc: PromptDocument): string {
  let compositeText = textDocument.getText();

  if (promptDoc.compositionLinks && promptDoc.compositionLinks.length > 0) {
    for (const link of promptDoc.compositionLinks) {
      if (!link.resolvedPath) continue;
      try {
        const linkedText = fs.readFileSync(link.resolvedPath, 'utf8');
        compositeText += `\n\n--- link:${link.target} ---\n${linkedText}`;
      } catch {
        // Missing/unreadable links are handled by static analyzer
      }
    }
  }

  return cache.computeHash(compositeText);
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

  const compositionLinks: CompositionLink[] = [];
  const documentDir = getDocumentDir(textDocument.uri);
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

  lines.forEach((line, lineIndex) => {
    let match;
    while ((match = linkPattern.exec(line)) !== null) {
      const rawTarget = match[2].trim();
      const target = normalizeMarkdownLinkTarget(rawTarget);
      if (!target) continue;

      const targetWithoutAnchor = target.split('#')[0];
      if (!targetWithoutAnchor) continue;

      if (!isPromptFile(targetWithoutAnchor)) continue;

      const resolvedPath = resolveLinkPath(targetWithoutAnchor, documentDir);
      compositionLinks.push({
        target: targetWithoutAnchor,
        resolvedPath,
        line: lineIndex,
        column: match.index,
        endColumn: match.index + match[0].length,
      });
    }
  });

  return {
    uri: textDocument.uri,
    text,
    lines,
    variables,
    sections,
    compositionLinks,
  };
}

function getDocumentDir(uri: string): string | undefined {
  try {
    const filePath = fileURLToPath(uri);
    return path.dirname(filePath);
  } catch {
    return undefined;
  }
}

function normalizeMarkdownLinkTarget(target: string): string | undefined {
  let cleaned = target.trim();

  if (cleaned.startsWith('<') && cleaned.endsWith('>')) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (!cleaned || cleaned.startsWith('#')) {
    return undefined;
  }

  if (/^(https?:|mailto:)/i.test(cleaned)) {
    return undefined;
  }

  const match = cleaned.match(/^([^\s]+)(?:\s+['"][^'"]*['"])?$/);
  return match ? match[1] : cleaned;
}

function resolveLinkPath(target: string, documentDir?: string): string | undefined {
  if (!documentDir) return undefined;

  if (target.startsWith('file://')) {
    try {
      return fileURLToPath(target);
    } catch {
      return undefined;
    }
  }

  if (path.isAbsolute(target)) {
    return target;
  }

  return path.resolve(documentDir, target);
}

function isPromptFile(target: string): boolean {
  const lower = target.toLowerCase();
  return (
    lower.endsWith('.prompt.md') ||
    lower.endsWith('.system.md') ||
    lower.endsWith('.agent.md') ||
    isSkillMarkdownPath(lower)
  );
}

function isSkillMarkdownPath(target: string): boolean {
  return target.endsWith('.md') && /(^|[\\/])skills[\\/]/.test(target);
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

// Make the text document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
