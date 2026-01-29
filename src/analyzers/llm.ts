import { PromptDocument, AnalysisResult } from '../types';

/**
 * LLM-powered analyzer for semantic analysis that can't be done statically.
 * Handles: contradiction detection, persona consistency, safety analysis, etc.
 */
export class LLMAnalyzer {
  private apiKey?: string;
  private model: string = 'gpt-4';
  private enabled: boolean = false;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    this.model = model || 'gpt-4';
    this.enabled = !!this.apiKey;
  }

  async analyze(doc: PromptDocument): Promise<AnalysisResult[]> {
    if (!this.enabled) {
      // Return a hint that LLM analysis is disabled
      return [{
        code: 'llm-disabled',
        message: 'LLM-powered analysis is disabled. Set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable contradiction detection, persona consistency, and other semantic analyses.',
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
        personaIssues,
        safetyIssues,
        cognitiveLoad,
        outputShape,
        semanticCoverage,
      ] = await Promise.all([
        this.analyzeContradictions(doc),
        this.analyzePersonaConsistency(doc),
        this.analyzeSafetyGuardrails(doc),
        this.analyzeCognitiveLoad(doc),
        this.analyzeOutputShape(doc),
        this.analyzeSemanticCoverage(doc),
      ]);

      results.push(...contradictions);
      results.push(...personaIssues);
      results.push(...safetyIssues);
      results.push(...cognitiveLoad);
      results.push(...outputShape);
      results.push(...semanticCoverage);
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
      const parsed = JSON.parse(response);
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
      const parsed = JSON.parse(response);
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
      const parsed = JSON.parse(response);
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
      const parsed = JSON.parse(response);
      
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
      const parsed = JSON.parse(response);
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
      const parsed = JSON.parse(response);
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
   * Call the LLM API
   */
  private async callLLM(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('No API key configured');
    }

    // Detect provider from API key format or environment
    const isAnthropic = this.apiKey.startsWith('sk-ant-') || process.env.ANTHROPIC_API_KEY;

    if (isAnthropic) {
      return this.callAnthropic(prompt);
    } else {
      return this.callOpenAI(prompt);
    }
  }

  private async callOpenAI(prompt: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a prompt analysis expert. Analyze prompts for issues and respond in JSON format only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content || '{}';
  }

  private async callAnthropic(prompt: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 2000,
        messages: [
          { role: 'user', content: prompt },
        ],
        system: 'You are a prompt analysis expert. Analyze prompts for issues and respond in JSON format only.',
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as { content: Array<{ text: string }> };
    return data.content[0]?.text || '{}';
  }
}
