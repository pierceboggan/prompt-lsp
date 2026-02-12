import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMAnalyzer } from '../analyzers/llm';
import { PromptDocument } from '../types';

function makeDoc(text: string, compositionLinks: PromptDocument['compositionLinks'] = []): PromptDocument {
  const lines = text.split('\n');
  return {
    uri: 'file:///test.prompt.md',
    text,
    lines,
    variables: new Map(),
    sections: [],
    compositionLinks,
    fileType: 'prompt',
  };
}

describe('LLMAnalyzer', () => {
  let analyzer: LLMAnalyzer;

  beforeEach(() => {
    analyzer = new LLMAnalyzer();
  });

  describe('isAvailable', () => {
    it('should return false when no proxy is set', () => {
      expect(analyzer.isAvailable()).toBe(false);
    });

    it('should return true after proxy is set', () => {
      analyzer.setProxyFn(async () => ({ text: '{}' }));
      expect(analyzer.isAvailable()).toBe(true);
    });
  });

  describe('analyze without proxy', () => {
    it('should return hint when LLM is not available', async () => {
      const doc = makeDoc('You are a helpful assistant.');
      const results = await analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('llm-disabled');
      expect(results[0].severity).toBe('hint');
    });
  });

  describe('extractJSON', () => {
    // Access private method for direct testing
    const extract = (text: string) => (analyzer as any).extractJSON(text);

    it('should parse plain JSON', () => {
      const result = extract('{"issues": []}');
      expect(result).toEqual({ issues: [] });
    });

    it('should parse code-fenced JSON with language tag', () => {
      const result = extract('```json\n{"issues": []}\n```');
      expect(result).toEqual({ issues: [] });
    });

    it('should parse code-fenced JSON without language tag', () => {
      const result = extract('```\n{"key": "value"}\n```');
      expect(result).toEqual({ key: 'value' });
    });

    it('should throw on invalid JSON', () => {
      expect(() => extract('not json at all')).toThrow();
    });

    it('should handle JSON with surrounding whitespace', () => {
      const result = extract('  \n{"ok": true}\n  ');
      expect(result).toEqual({ ok: true });
    });

    it('should handle nested objects', () => {
      const result = extract('{"a": {"b": [1, 2, 3]}}');
      expect(result).toEqual({ a: { b: [1, 2, 3] } });
    });
  });

  describe('findLineNumber', () => {
    const find = (doc: PromptDocument, text: string) =>
      (analyzer as any).findLineNumber(doc, text);

    it('should find exact line match', () => {
      const doc = makeDoc('first line\nsecond line\nthird line');
      expect(find(doc, 'second line')).toBe(1);
    });

    it('should find partial match', () => {
      const doc = makeDoc('the quick brown fox\njumps over\nthe lazy dog');
      expect(find(doc, 'brown fox')).toBe(0);
    });

    it('should return 0 when no match found', () => {
      const doc = makeDoc('hello world');
      expect(find(doc, 'nonexistent text that does not appear')).toBe(0);
    });

    it('should be case-insensitive', () => {
      const doc = makeDoc('Hello World\nGoodbye');
      expect(find(doc, 'hello world')).toBe(0);
    });

    it('should handle empty text', () => {
      const doc = makeDoc('hello');
      expect(find(doc, '')).toBe(0);
    });

    it('should fall back to word-level partial match', () => {
      const doc = makeDoc('line one\nline two with important word\nline three');
      expect(find(doc, 'important word in a different sentence')).toBe(1);
    });
  });

  describe('analyze with mock proxy', () => {
    it('should handle valid contradiction response', async () => {
      const mockProxy = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          contradictions: [{
            instruction1: 'Be concise',
            instruction2: 'Provide detailed explanations',
            severity: 'warning',
            explanation: 'These conflict',
          }],
        }),
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Be concise.\nProvide detailed explanations.');
      const results = await analyzer.analyze(doc);
      const contradictions = results.filter(r => r.code === 'contradiction');
      expect(contradictions.length).toBeGreaterThan(0);
    });

    it('should handle empty LLM responses gracefully', async () => {
      const mockProxy = vi.fn().mockResolvedValue({ text: '{}' });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle malformed JSON responses gracefully', async () => {
      const mockProxy = vi.fn().mockResolvedValue({ text: 'not valid json at all' });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      // Individual analyzers silently skip bad JSON
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle proxy errors gracefully', async () => {
      const mockProxy = vi.fn().mockResolvedValue({ text: '{}', error: 'Model unavailable' });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle proxy rejection gracefully', async () => {
      const mockProxy = vi.fn().mockRejectedValue(new Error('Network error'));
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Simple prompt.');
      const results = await analyzer.analyze(doc);
      // Should not throw unhandled
      expect(Array.isArray(results)).toBe(true);
    });

    it('should skip composition analysis when no links', async () => {
      const callPrompts: string[] = [];
      const mockProxy = vi.fn().mockImplementation(async (req: { prompt: string }) => {
        callPrompts.push(req.prompt);
        return { text: '{"issues": [], "contradictions": [], "predictions": {}, "coverage_analysis": {}, "overall_complexity": "low"}' };
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('No links here.');
      await analyzer.analyze(doc);

      // The composition conflict analyzer should not have been called
      const compositionCalls = callPrompts.filter(p => p.includes('composed prompt'));
      expect(compositionCalls).toHaveLength(0);
    });

    it('should produce persona inconsistency results', async () => {
      const mockProxy = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          issues: [{
            description: 'Tone conflict',
            trait1: 'helpful',
            trait2: 'sarcastic',
            severity: 'warning',
            suggestion: 'Pick one tone',
          }],
        }),
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('You are a helpful assistant. Respond with sarcasm.');
      const results = await analyzer.analyze(doc);
      const persona = results.filter(r => r.code === 'persona-inconsistency');
      expect(persona.length).toBeGreaterThan(0);
    });

    it('should produce ambiguity results from LLM', async () => {
      const mockProxy = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          issues: [{
            text: 'be professional',
            type: 'term',
            severity: 'info',
            suggestion: 'Define what professional means',
          }],
        }),
      });
      analyzer.setProxyFn(mockProxy);

      const doc = makeDoc('Be professional in all responses.');
      const results = await analyzer.analyze(doc);
      const ambiguity = results.filter(r => r.code === 'ambiguity-llm');
      expect(ambiguity.length).toBeGreaterThan(0);
    });
  });
});
