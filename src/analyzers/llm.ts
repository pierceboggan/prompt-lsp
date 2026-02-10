import fs from 'fs';
import { PromptDocument, AnalysisResult, LLMProxyFn } from '../types';

/**
 * LLM-powered analyzer for semantic analysis that can't be done statically.
 * Handles: contradiction detection, persona consistency, safety analysis, etc.
 */
export class LLMAnalyzer {
  private proxyFn?: LLMProxyFn;

  /**
   * Extract JSON from an LLM response that may be wrapped in markdown code fences.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractJSON(text: string): any {
    // Strip markdown code fences: ```json ... ``` or ``` ... ```
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();
    return JSON.parse(jsonStr);
  }

  /**
   * Set a proxy function for LLM calls (vscode.lm / Copilot integration).
   */
  setProxyFn(fn: LLMProxyFn): void {
    this.proxyFn = fn;
  }

  /**
   * Returns true if LLM analysis can run (proxy is configured).
   */
  isAvailable(): boolean {
    return !!this.proxyFn;
  }

  async analyze(doc: PromptDocument): Promise<AnalysisResult[]> {
    if (!this.isAvailable()) {
      // Return a hint that LLM analysis is disabled
      return [{
        code: 'llm-disabled',
        message: 'LLM-powered analysis is disabled. Install GitHub Copilot to enable contradiction detection, persona consistency, and other semantic analyses.',
        severity: 'hint',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'llm-analyzer',
      }];
    }

    const results: AnalysisResult[] = [];

    try {
      // Run all LLM-based analyses in parallel
      const [
        contradictions,
        ambiguities,
        personaIssues,
        safetyIssues,
        cognitiveLoad,
        outputShape,
        semanticCoverage,
        compositionConflicts,
      ] = await Promise.all([
        this.analyzeContradictions(doc),
        this.analyzeAmbiguity(doc),
        this.analyzePersonaConsistency(doc),
        this.analyzeSafetyGuardrails(doc),
        this.analyzeCognitiveLoad(doc),
        this.analyzeOutputShape(doc),
        this.analyzeSemanticCoverage(doc),
        this.analyzeCompositionConflicts(doc),
      ]);

      results.push(...contradictions);
      results.push(...ambiguities);
      results.push(...personaIssues);
      results.push(...safetyIssues);
      results.push(...cognitiveLoad);
      results.push(...outputShape);
      results.push(...semanticCoverage);
      results.push(...compositionConflicts);
    } catch (error) {
      results.push({
        code: 'llm-error',
        message: `LLM analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        severity: 'info',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'llm-analyzer',
      });
    }

    return results;
  }

  /**
   * Ambiguity Detection (Tier 1 - LLM)
   * Finds vague, underspecified, or context-missing instructions with suggestions
   */
  private async analyzeAmbiguity(doc: PromptDocument): Promise<AnalysisResult[]> {
    const prompt = `Analyze this AI prompt for ambiguity. Look for:
1. Vague or underspecified instructions
2. Ambiguous quantifiers ("a few", "sometimes", etc.)
3. Unresolved references ("as mentioned above")
4. Undefined terms ("be professional" without definition)
5. Scope ambiguity or unclear precedence

Prompt to analyze:
"""
${doc.text}
"""

Respond in JSON format:
{
  "issues": [
    {
      "text": "exact ambiguous text",
      "type": "quantifier" | "reference" | "term" | "scope" | "other",
      "severity": "warning" | "info",
      "suggestion": "specific rewrite or clarification"
    }
  ]
}

If no issues found, return {"issues": []}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      for (const issue of parsed.issues || []) {
        const line = this.findLineNumber(doc, issue.text);
        results.push({
          code: 'ambiguity-llm',
          message: `Ambiguity detected: ${issue.text}. ${issue.suggestion}`,
          severity: issue.severity === 'warning' ? 'warning' : 'info',
          range: {
            start: { line, character: 0 },
            end: { line, character: doc.lines[line]?.length || 0 },
          },
          analyzer: 'ambiguity-detection',
          suggestion: issue.suggestion,
        });
      }
    } catch {
      // JSON parse error, skip
    }

    return results;
  }

  /**
   * Contradiction Detection (Tier 1)
   * Identifies logical, behavioral, and format conflicts
   */
  private async analyzeContradictions(doc: PromptDocument): Promise<AnalysisResult[]> {
    const prompt = `Analyze this AI prompt for internal contradictions. Look for:
1. Logical conflicts (e.g., "Be concise" vs "provide detailed explanations")
2. Behavioral conflicts (e.g., "Never refuse" vs "refuse harmful requests")
3. Format conflicts (e.g., "respond in exactly 10 words" + "include a code block")

Prompt to analyze:
"""
${doc.text}
"""

Respond in JSON format:
{
  "contradictions": [
    {
      "instruction1": "exact text of first conflicting instruction",
      "instruction2": "exact text of second conflicting instruction",
      "severity": "error" | "warning",
      "explanation": "why these conflict",
      "line1_estimate": number,
      "line2_estimate": number
    }
  ]
}

If no contradictions found, return {"contradictions": []}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      for (const contradiction of parsed.contradictions || []) {
        // Find actual line numbers by searching for the instruction text
        const line1 = this.findLineNumber(doc, contradiction.instruction1);
        const line2 = this.findLineNumber(doc, contradiction.instruction2);

        results.push({
          code: 'contradiction',
          message: `Contradiction detected: "${contradiction.instruction1}" conflicts with "${contradiction.instruction2}". ${contradiction.explanation}`,
          severity: contradiction.severity === 'error' ? 'error' : 'warning',
          range: {
            start: { line: line1, character: 0 },
            end: { line: line1, character: doc.lines[line1]?.length || 0 },
          },
          analyzer: 'contradiction-detection',
        });

        if (line2 !== line1) {
          results.push({
            code: 'contradiction-related',
            message: `Related to contradiction above. See line ${line1 + 1}.`,
            severity: 'info',
            range: {
              start: { line: line2, character: 0 },
              end: { line: line2, character: doc.lines[line2]?.length || 0 },
            },
            analyzer: 'contradiction-detection',
          });
        }
      }
    } catch (e) {
      // JSON parse error, skip
    }

    return results;
  }

  /**
   * Persona Consistency (Tier 2)
   * Checks for conflicting personality traits and tone drift
   */
  private async analyzePersonaConsistency(doc: PromptDocument): Promise<AnalysisResult[]> {
    const prompt = `Analyze this AI prompt for persona consistency issues. Look for:
1. Conflicting personality traits
2. Tone drift across sections
3. Implied characteristics that clash with stated behavior

Prompt to analyze:
"""
${doc.text}
"""

Respond in JSON format:
{
  "issues": [
    {
      "description": "description of the persona inconsistency",
      "trait1": "first conflicting trait or tone",
      "trait2": "second conflicting trait or tone",
      "severity": "warning" | "info",
      "suggestion": "how to resolve"
    }
  ]
}

If no issues found, return {"issues": []}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      for (const issue of parsed.issues || []) {
        results.push({
          code: 'persona-inconsistency',
          message: `Persona inconsistency: ${issue.description}. "${issue.trait1}" vs "${issue.trait2}"`,
          severity: issue.severity === 'warning' ? 'warning' : 'info',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'persona-consistency',
          suggestion: issue.suggestion,
        });
      }
    } catch (e) {
      // JSON parse error, skip
    }

    return results;
  }

  /**
   * Safety Guardrail Integrity (Tier 2)
   * Identifies weak or vulnerable safety measures
   */
  private async analyzeSafetyGuardrails(doc: PromptDocument): Promise<AnalysisResult[]> {
    const prompt = `Analyze this AI prompt for safety guardrail weaknesses. Look for:
1. Guardrails vulnerable to roleplay/pretend attacks
2. Missing safety boundaries for detected capabilities
3. Instructions that could be easily bypassed
4. Safety rules using weak language

Prompt to analyze:
"""
${doc.text}
"""

Respond in JSON format:
{
  "vulnerabilities": [
    {
      "description": "description of the vulnerability",
      "vulnerable_text": "the specific text that is weak",
      "attack_vector": "how it could be exploited",
      "severity": "error" | "warning",
      "suggestion": "how to strengthen"
    }
  ]
}

If no vulnerabilities found, return {"vulnerabilities": []}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      for (const vuln of parsed.vulnerabilities || []) {
        const line = this.findLineNumber(doc, vuln.vulnerable_text);
        
        results.push({
          code: 'safety-vulnerability',
          message: `Safety vulnerability: ${vuln.description}. Attack vector: ${vuln.attack_vector}`,
          severity: vuln.severity === 'error' ? 'error' : 'warning',
          range: {
            start: { line, character: 0 },
            end: { line, character: doc.lines[line]?.length || 0 },
          },
          analyzer: 'safety-analysis',
          suggestion: vuln.suggestion,
        });
      }
    } catch (e) {
      // JSON parse error, skip
    }

    return results;
  }

  /**
   * Cognitive Load Assessment (Tier 2)
   * Identifies overly complex prompts that may overwhelm model attention
   */
  private async analyzeCognitiveLoad(doc: PromptDocument): Promise<AnalysisResult[]> {
    const prompt = `Analyze this AI prompt for cognitive load issues. Look for:
1. Too many nested conditions
2. Conflicting prioritization hierarchies
3. Decision tree depth > 3 levels
4. Too many constraints fighting for attention

Prompt to analyze:
"""
${doc.text}
"""

Respond in JSON format:
{
  "issues": [
    {
      "type": "nested-conditions" | "priority-conflict" | "deep-decision-tree" | "constraint-overload",
      "description": "description of the issue",
      "severity": "warning" | "info",
      "suggestion": "how to simplify"
    }
  ],
  "overall_complexity": "low" | "medium" | "high" | "very-high"
}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      
      if (parsed.overall_complexity === 'very-high') {
        results.push({
          code: 'high-complexity',
          message: `Very high cognitive load detected. This prompt may overwhelm the model's attention. Consider breaking it into simpler, focused prompts.`,
          severity: 'warning',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'cognitive-load',
        });
      }

      for (const issue of parsed.issues || []) {
        results.push({
          code: `cognitive-${issue.type}`,
          message: issue.description,
          severity: issue.severity === 'warning' ? 'warning' : 'info',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'cognitive-load',
          suggestion: issue.suggestion,
        });
      }
    } catch (e) {
      // JSON parse error, skip
    }

    return results;
  }

  /**
   * Output Shape Prediction (Tier 2)
   * Predicts typical response characteristics and potential format issues
   */
  private async analyzeOutputShape(doc: PromptDocument): Promise<AnalysisResult[]> {
    const prompt = `Analyze this AI prompt and predict the output characteristics. Evaluate:
1. Expected response length (token estimate)
2. JSON/structured output validity likelihood
3. Refusal rate estimation (how often will the model refuse)
4. Format compliance probability (will output match specified format)

Prompt to analyze:
"""
${doc.text}
"""

Respond in JSON format:
{
  "predictions": {
    "estimated_tokens": number,
    "token_variance": "low" | "medium" | "high",
    "structured_output_requested": boolean,
    "structured_output_compliance": "high" | "medium" | "low",
    "refusal_probability": "low" | "medium" | "high",
    "format_issues": [
      {
        "issue": "description of potential format problem",
        "suggestion": "how to fix"
      }
    ]
  },
  "warnings": [
    {
      "message": "warning about output expectations",
      "severity": "warning" | "info"
    }
  ]
}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      const predictions = parsed.predictions;

      if (predictions) {
        // Token estimate warning
        if (predictions.estimated_tokens > 500 && predictions.token_variance === 'high') {
          results.push({
            code: 'unpredictable-length',
            message: `Output length is unpredictable (estimated ~${predictions.estimated_tokens} tokens with high variance). Consider adding explicit length constraints.`,
            severity: 'info',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            analyzer: 'output-prediction',
          });
        }

        // Structured output compliance
        if (predictions.structured_output_requested && predictions.structured_output_compliance === 'low') {
          results.push({
            code: 'low-format-compliance',
            message: 'Structured output requested but compliance likelihood is low. Add explicit examples or use function calling.',
            severity: 'warning',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            analyzer: 'output-prediction',
          });
        }

        // Refusal probability
        if (predictions.refusal_probability === 'high') {
          results.push({
            code: 'high-refusal-rate',
            message: 'This prompt may trigger frequent refusals. Review constraints for overly restrictive or ambiguous safety rules.',
            severity: 'warning',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            analyzer: 'output-prediction',
          });
        }

        // Format issues
        for (const issue of predictions.format_issues || []) {
          results.push({
            code: 'format-issue',
            message: issue.issue,
            severity: 'info',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            analyzer: 'output-prediction',
            suggestion: issue.suggestion,
          });
        }
      }

      // Additional warnings
      for (const warning of parsed.warnings || []) {
        results.push({
          code: 'output-warning',
          message: warning.message,
          severity: warning.severity === 'warning' ? 'warning' : 'info',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'output-prediction',
        });
      }
    } catch (e) {
      // JSON parse error, skip
    }

    return results;
  }

  /**
   * Semantic Coverage / Intent Matrix (Tier 3)
   * Analyzes what user intents the prompt handles well/poorly
   */
  private async analyzeSemanticCoverage(doc: PromptDocument): Promise<AnalysisResult[]> {
    const prompt = `Analyze this AI prompt for semantic coverage gaps. Evaluate:
1. What user intents does this prompt handle well?
2. What edge cases or intents are NOT covered?
3. Are there missing error handling paths?
4. What situations might produce undefined behavior?

Prompt to analyze:
"""
${doc.text}
"""

Respond in JSON format:
{
  "coverage_analysis": {
    "well_handled_intents": ["intent1", "intent2"],
    "coverage_gaps": [
      {
        "gap": "description of uncovered scenario",
        "impact": "high" | "medium" | "low",
        "suggestion": "how to address this gap"
      }
    ],
    "missing_error_handling": [
      {
        "scenario": "error scenario not handled",
        "suggestion": "how to handle it"
      }
    ],
    "overall_coverage": "comprehensive" | "adequate" | "limited" | "minimal"
  }
}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      const analysis = parsed.coverage_analysis;

      if (analysis) {
        // Overall coverage warning
        if (analysis.overall_coverage === 'limited' || analysis.overall_coverage === 'minimal') {
          results.push({
            code: 'limited-coverage',
            message: `Semantic coverage is ${analysis.overall_coverage}. This prompt may produce inconsistent results for edge cases.`,
            severity: 'warning',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            analyzer: 'semantic-coverage',
          });
        }

        // Coverage gaps
        for (const gap of analysis.coverage_gaps || []) {
          if (gap.impact === 'high') {
            results.push({
              code: 'coverage-gap',
              message: `Coverage gap: ${gap.gap}`,
              severity: 'warning',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              analyzer: 'semantic-coverage',
              suggestion: gap.suggestion,
            });
          } else {
            results.push({
              code: 'coverage-gap',
              message: `Minor coverage gap: ${gap.gap}`,
              severity: 'info',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              analyzer: 'semantic-coverage',
              suggestion: gap.suggestion,
            });
          }
        }

        // Missing error handling
        for (const error of analysis.missing_error_handling || []) {
          results.push({
            code: 'missing-error-handling',
            message: `No guidance for: ${error.scenario}`,
            severity: 'info',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            analyzer: 'semantic-coverage',
            suggestion: error.suggestion,
          });
        }
      }
    } catch (e) {
      // JSON parse error, skip
    }

    return results;
  }

  /**
   * Composition Conflict Analysis (Tier 2 - LLM, one-hop)
   * Detects conflicts across current prompt and directly linked prompts
   */
  private async analyzeCompositionConflicts(doc: PromptDocument): Promise<AnalysisResult[]> {
    if (!doc.compositionLinks || doc.compositionLinks.length === 0) {
      return [];
    }

    const composedText = this.buildComposedText(doc);
    if (!composedText) {
      return [];
    }

    const prompt = `Analyze the composed prompt for conflicts across files. Look for:
1. Behavioral conflicts (e.g., "Never refuse" vs "Refuse harmful requests")
2. Format conflicts (e.g., "10 words" vs "include code block")
3. Priority conflicts (two sections both claiming highest priority)

Composed prompt:
"""
${composedText}
"""

Respond in JSON format:
{
  "conflicts": [
    {
      "summary": "short description",
      "instruction1": "exact text of first conflicting instruction",
      "instruction2": "exact text of second conflicting instruction",
      "severity": "error" | "warning",
      "suggestion": "how to resolve"
    }
  ]
}

If no conflicts found, return {"conflicts": []}`;

    const response = await this.callLLM(prompt);
    const results: AnalysisResult[] = [];

    try {
      const parsed = this.extractJSON(response);
      for (const conflict of parsed.conflicts || []) {
        results.push({
          code: 'composition-conflict',
          message: `Composition conflict: ${conflict.summary}. "${conflict.instruction1}" vs "${conflict.instruction2}"`,
          severity: conflict.severity === 'error' ? 'error' : 'warning',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'composition-conflicts',
          suggestion: conflict.suggestion,
        });
      }
    } catch {
      // JSON parse error, skip
    }

    return results;
  }

  private buildComposedText(doc: PromptDocument): string {
    const parts: string[] = [doc.text];

    for (const link of doc.compositionLinks) {
      if (!link.resolvedPath) continue;
      try {
        const linkedText = fs.readFileSync(link.resolvedPath, 'utf8');
        parts.push(`\n\n--- begin ${link.target} ---\n${linkedText}\n--- end ${link.target} ---\n`);
      } catch {
        // Missing/unreadable files handled by static analyzer
      }
    }

    return parts.join('\n');
  }

  /**
   * Find the line number where a piece of text appears
   */
  private findLineNumber(doc: PromptDocument, text: string): number {
    if (!text) return 0;
    
    const lowerText = text.toLowerCase();
    for (let i = 0; i < doc.lines.length; i++) {
      if (doc.lines[i].toLowerCase().includes(lowerText)) {
        return i;
      }
    }
    
    // Try partial match
    const words = lowerText.split(/\s+/).slice(0, 5);
    for (let i = 0; i < doc.lines.length; i++) {
      const lowerLine = doc.lines[i].toLowerCase();
      if (words.some(word => word.length > 3 && lowerLine.includes(word))) {
        return i;
      }
    }
    
    return 0;
  }

  /**
   * Call the LLM via the vscode.lm proxy (Copilot)
   */
  private async callLLM(prompt: string): Promise<string> {
    if (!this.proxyFn) {
      throw new Error('No language model available. Install GitHub Copilot.');
    }

    const systemPrompt = 'You are a prompt analysis expert. Analyze prompts for issues and respond in JSON format only.';
    const result = await this.proxyFn({ prompt, systemPrompt });
    if (result.error) {
      throw new Error(result.error);
    }
    return result.text;
  }
}
