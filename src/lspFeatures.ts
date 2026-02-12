import { CodeLens, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';

import { StaticAnalyzer } from './analyzers/static';
import { AnalysisResult, CompositionLink, PromptDocument } from './types';

export const PROMPT_LSP_NOOP_COMMAND = 'promptLSP.noop';

export function getVariableNameAtPosition(lineText: string, character: number): string | undefined {
  const variablePattern = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = variablePattern.exec(lineText)) !== null) {
    const start = match.index;
    const endExclusive = start + match[0].length;
    if (character >= start && character <= endExclusive) {
      return match[1];
    }
  }
  return undefined;
}

export function findFirstVariableOccurrence(
  doc: PromptDocument,
  variableName: string,
): { line: number; character: number; length: number } | undefined {
  const variablePattern = /\{\{(\w+)\}\}/g;

  for (let lineIndex = 0; lineIndex < doc.lines.length; lineIndex++) {
    const lineText = doc.lines[lineIndex] ?? '';
    let match: RegExpExecArray | null;
    variablePattern.lastIndex = 0;
    while ((match = variablePattern.exec(lineText)) !== null) {
      if (match[1] !== variableName) continue;
      return { line: lineIndex, character: match.index, length: match[0].length };
    }
  }

  return undefined;
}

export function findCompositionLinkAtPosition(
  doc: PromptDocument,
  line: number,
  character: number,
): CompositionLink | undefined {
  for (const link of doc.compositionLinks) {
    if (link.line !== line) continue;
    const start = link.targetStartColumn ?? link.column;
    const endExclusive = link.targetEndColumn ?? link.endColumn;
    if (character >= start && character <= endExclusive) {
      return link;
    }
  }
  return undefined;
}

export function createCodeLenses(
  doc: PromptDocument,
  staticResults: AnalysisResult[] | undefined,
  analyzer: StaticAnalyzer,
): CodeLens[] {
  const issueCount = staticResults?.length ?? 0;
  const codeLenses: CodeLens[] = [];

  codeLenses.push({
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    command: {
      title: `Prompt LSP: ${issueCount} issue${issueCount === 1 ? '' : 's'} found`,
      command: PROMPT_LSP_NOOP_COMMAND,
    },
  });

  const tokenInfo = analyzer.getTokenInfo(doc);

  for (let index = 0; index < doc.sections.length; index++) {
    const section = doc.sections[index];
    const sectionTokens = tokenInfo.sectionTokens?.[index] ?? tokenInfo.sections.get(section.name) ?? 0;
    codeLenses.push({
      range: {
        start: { line: section.startLine, character: 0 },
        end: { line: section.startLine, character: 0 },
      },
      command: {
        title: `\u00A7 ${section.name} \u2014 ${sectionTokens} tokens`,
        command: PROMPT_LSP_NOOP_COMMAND,
      },
    });
  }

  return codeLenses;
}

/**
 * Convert analysis results to LSP diagnostics.
 */
export function resultsToDiagnostics(results: AnalysisResult[]): Diagnostic[] {
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
