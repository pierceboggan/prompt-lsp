import { describe, expect, it } from 'vitest';

import { StaticAnalyzer } from '../analyzers/static';
import { createCodeLenses, findCompositionLinkAtPosition, findFirstVariableOccurrence, getVariableNameAtPosition, PROMPT_LSP_NOOP_COMMAND, resultsToDiagnostics } from '../lspFeatures';
import { AnalysisResult } from '../types';
import { makeDoc } from './helpers';

describe('lspFeatures', () => {
  it('detects variable name at a given cursor position', () => {
    const line = 'Hello {{foo_bar}} world';
    expect(getVariableNameAtPosition(line, line.indexOf('foo_bar'))).toBe('foo_bar');
    expect(getVariableNameAtPosition(line, 0)).toBeUndefined();
  });

  it('finds the first occurrence of a variable in the document', () => {
    const doc = makeDoc('x {{v}}\nsecond {{v}}\nother {{w}}');
    const found = findFirstVariableOccurrence(doc, 'v');
    expect(found).toEqual({ line: 0, character: 2, length: '{{v}}'.length });
  });

  it('finds composition links only when cursor is on the link target span', () => {
    const doc = makeDoc('# H\n[text](file.agent.md)');
    doc.compositionLinks = [
      {
        target: 'file.agent.md',
        resolvedPath: '/tmp/file.agent.md',
        line: 1,
        column: 0,
        endColumn: '[text](file.agent.md)'.length,
        targetStartColumn: '[text]('.length,
        targetEndColumn: '[text]('.length + 'file.agent.md'.length,
      },
    ];

    expect(findCompositionLinkAtPosition(doc, 1, 2)).toBeUndefined(); // inside [text]
    expect(findCompositionLinkAtPosition(doc, 1, '[text]('.length + 1)?.target).toBe('file.agent.md');
  });

  it('creates CodeLenses for issue summary and each section', () => {
    const analyzer = new StaticAnalyzer();
    const text = '# Intro\nHello world\n\n## Details\nMore text';
    const doc = makeDoc(text);
    const staticResults: AnalysisResult[] = [
      { code: 'a', message: 'a', severity: 'info', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, analyzer: 'x' },
      { code: 'b', message: 'b', severity: 'info', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, analyzer: 'x' },
    ];

    const lenses = createCodeLenses(doc, staticResults, analyzer);
    expect(lenses.length).toBe(1 + doc.sections.length);
    expect(lenses[0].command?.title).toBe('Prompt LSP: 2 issues found');
    expect(lenses[0].command?.command).toBe(PROMPT_LSP_NOOP_COMMAND);

    // Token lens titles are deterministic because they use the same analyzer/tokenizer
    for (let i = 0; i < doc.sections.length; i++) {
      const section = doc.sections[i];
      const sectionText = doc.lines.slice(section.startLine, section.endLine + 1).join('\n');
      const expectedTokens = analyzer.getTokenCount(sectionText);
      expect(lenses[i + 1].command?.title).toBe(`\u00A7 ${section.name} \u2014 ${expectedTokens} tokens`);
      expect(lenses[i + 1].command?.command).toBe(PROMPT_LSP_NOOP_COMMAND);
    }
  });

  describe('resultsToDiagnostics', () => {
    it('maps severity levels correctly', () => {
      const results: AnalysisResult[] = [
        { code: 'a', message: 'err', severity: 'error', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, analyzer: 'x' },
        { code: 'b', message: 'warn', severity: 'warning', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, analyzer: 'x' },
        { code: 'c', message: 'inf', severity: 'info', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, analyzer: 'x' },
        { code: 'd', message: 'hnt', severity: 'hint', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }, analyzer: 'x' },
      ];

      const diagnostics = resultsToDiagnostics(results);
      expect(diagnostics).toHaveLength(4);
      // DiagnosticSeverity: Error=1, Warning=2, Information=3, Hint=4
      expect(diagnostics[0].severity).toBe(1);
      expect(diagnostics[1].severity).toBe(2);
      expect(diagnostics[2].severity).toBe(3);
      expect(diagnostics[3].severity).toBe(4);
    });

    it('includes source and code', () => {
      const results: AnalysisResult[] = [
        { code: 'test-code', message: 'msg', severity: 'warning', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, analyzer: 'my-analyzer' },
      ];
      const diagnostics = resultsToDiagnostics(results);
      expect(diagnostics[0].source).toBe('prompt-lsp (my-analyzer)');
      expect(diagnostics[0].code).toBe('test-code');
    });

    it('passes suggestion as data', () => {
      const results: AnalysisResult[] = [
        { code: 'x', message: 'msg', severity: 'info', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, analyzer: 'a', suggestion: 'fix it' },
      ];
      const diagnostics = resultsToDiagnostics(results);
      expect(diagnostics[0].data).toBe('fix it');
    });

    it('returns empty array for empty input', () => {
      expect(resultsToDiagnostics([])).toEqual([]);
    });
  });
});
