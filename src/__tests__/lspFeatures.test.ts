import { describe, expect, it } from 'vitest';

import { StaticAnalyzer } from '../analyzers/static';
import { createCodeLenses, findCompositionLinkAtPosition, findFirstVariableOccurrence, getVariableNameAtPosition, PROMPT_LSP_NOOP_COMMAND } from '../lspFeatures';
import { AnalysisResult, PromptDocument } from '../types';

function makeDoc(text: string): PromptDocument {
  const lines = text.split('\n');
  const variables = new Map<string, number[]>();
  const variablePattern = /\{\{(\w+)\}\}/g;

  lines.forEach((line, lineIndex) => {
    let match: RegExpExecArray | null;
    variablePattern.lastIndex = 0;
    while ((match = variablePattern.exec(line)) !== null) {
      const varName = match[1];
      const positions = variables.get(varName) || [];
      positions.push(lineIndex);
      variables.set(varName, positions);
    }
  });

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
    uri: 'file:///test.prompt.md',
    text,
    lines,
    variables,
    sections,
    compositionLinks: [],
    fileType: 'prompt',
  };
}

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
});
