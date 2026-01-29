import { Range } from 'vscode-languageserver';
import { PromptDocument, AnalysisResult, InstructionStrength, TokenInfo } from '../types';
import { encoding_for_model, TiktokenModel } from 'tiktoken';

export class StaticAnalyzer {
  private strengthPatterns: Record<string, string[]> = {
    strong: ['never', 'must', 'always', 'under no circumstances', 'absolutely', 'required', 'mandatory', 'forbidden', 'prohibited'],
    medium: ['should', 'avoid', 'prefer', 'recommended', 'expected', 'generally', 'typically'],
    weak: ['try to', 'consider', 'when appropriate', 'if possible', 'might', 'could', 'may want to', 'optionally'],
  };

  private ambiguousQuantifiers = ['a few', 'some', 'sometimes', 'occasionally', 'often', 'many', 'several', 'various', 'numerous'];
  
  private vagueTerms = ['appropriate', 'professional', 'good', 'bad', 'nice', 'proper', 'suitable', 'reasonable', 'adequate'];

  private injectionPatterns = [
    /ignore\s+(previous|all|above)\s+(instructions?|prompts?)/i,
    /disregard\s+(previous|all|above)/i,
    /new\s+instructions?:/i,
    /system\s*:\s*/i,
    /\[INST\]/i,
    /<<SYS>>/i,
    /pretend\s+(you\s+are|to\s+be)/i,
    /roleplay\s+as/i,
    /act\s+as\s+if/i,
    /jailbreak/i,
    /DAN\s+mode/i,
  ];

  // Model context window sizes
  private contextWindows: Record<string, number> = {
    'gpt-3.5-turbo': 4096,
    'gpt-4': 8192,
    'gpt-4-32k': 32768,
    'gpt-4-turbo': 128000,
    'gpt-4o': 128000,
    'claude-2': 100000,
    'claude-3-sonnet': 200000,
    'claude-3-opus': 200000,
    'claude-3-haiku': 200000,
  };

  // Tiktoken encoder cached
  private encoder: ReturnType<typeof encoding_for_model> | null = null;

  getStrengthPatterns(): Record<string, string[]> {
    return this.strengthPatterns;
  }

  /**
   * Get accurate token count using tiktoken
   */
  getTokenCount(text: string, model: string = 'gpt-4'): number {
    try {
      if (!this.encoder) {
        // Map model to tiktoken model name
        let tiktokenModel: TiktokenModel = 'gpt-4';
        if (model.includes('gpt-3.5')) {
          tiktokenModel = 'gpt-3.5-turbo';
        } else if (model.includes('gpt-4')) {
          tiktokenModel = 'gpt-4';
        }
        this.encoder = encoding_for_model(tiktokenModel);
      }
      return this.encoder.encode(text).length;
    } catch {
      // Fallback to estimation
      return Math.ceil(text.length / 4);
    }
  }

  /**
   * Get detailed token info for sections
   */
  getTokenInfo(doc: PromptDocument, targetModel?: string): TokenInfo {
    const totalTokens = this.getTokenCount(doc.text, targetModel);
    const sections = new Map<string, number>();
    
    // Calculate tokens per section
    for (const section of doc.sections) {
      const sectionText = doc.lines.slice(section.startLine, section.endLine + 1).join('\n');
      sections.set(section.name, this.getTokenCount(sectionText, targetModel));
    }

    const contextWindow = this.contextWindows[targetModel || 'gpt-4'] || 8192;
    let budgetWarning: string | undefined;

    if (totalTokens > contextWindow * 0.9) {
      budgetWarning = `Prompt uses ${totalTokens} tokens (${Math.round(totalTokens / contextWindow * 100)}% of ${targetModel || 'default'} context window). Leave room for response!`;
    } else if (totalTokens > contextWindow * 0.5) {
      budgetWarning = `Prompt uses ${totalTokens} tokens (${Math.round(totalTokens / contextWindow * 100)}% of context window)`;
    }

    return { totalTokens, sections, budgetWarning };
  }

  analyze(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Run all static analyzers
    results.push(...this.analyzeVariables(doc));
    results.push(...this.analyzeInstructionStrength(doc));
    results.push(...this.analyzeInjectionSurface(doc));
    results.push(...this.analyzeAmbiguity(doc));
    results.push(...this.analyzeStructure(doc));
    results.push(...this.analyzeRedundancy(doc));
    results.push(...this.analyzeExamples(doc));
    results.push(...this.analyzeTokenUsage(doc));

    return results;
  }

  // Variable/Placeholder Validation (Tier 1)
  private analyzeVariables(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    const variablePattern = /\{\{(\w+)\}\}/g;
    const definedVariables = new Set<string>();
    const usedVariables = new Map<string, { line: number; col: number }[]>();

    // First pass: find definitions (e.g., {{variable_name}} = or context definitions)
    const definitionPatterns = [
      /(\w+)\s*[:=]/g, // variable: or variable=
      /define\s+(\w+)/gi, // define variable
      /\{\{(\w+)\}\}\s*[:=]/g, // {{variable}} =
    ];

    doc.lines.forEach((line, lineIndex) => {
      for (const pattern of definitionPatterns) {
        let match;
        const regex = new RegExp(pattern.source, pattern.flags);
        while ((match = regex.exec(line)) !== null) {
          definedVariables.add(match[1].toLowerCase());
        }
      }
    });

    // Second pass: find usages
    doc.lines.forEach((line, lineIndex) => {
      let match;
      const regex = new RegExp(variablePattern.source, variablePattern.flags);
      while ((match = regex.exec(line)) !== null) {
        const varName = match[1];
        const occurrences = usedVariables.get(varName) || [];
        occurrences.push({ line: lineIndex, col: match.index });
        usedVariables.set(varName, occurrences);
      }
    });

    // Check for undefined variables
    for (const [varName, occurrences] of usedVariables) {
      // Common context variables that are typically provided at runtime
      const commonContextVars = ['user_input', 'user_name', 'context', 'input', 'query', 'message', 'date', 'time', 'user'];
      if (!definedVariables.has(varName.toLowerCase()) && !commonContextVars.includes(varName.toLowerCase())) {
        for (const occurrence of occurrences) {
          results.push({
            code: 'undefined-variable',
            message: `Variable '{{${varName}}}' is referenced but may not be defined. Ensure it's provided in the runtime context.`,
            severity: 'warning',
            range: {
              start: { line: occurrence.line, character: occurrence.col },
              end: { line: occurrence.line, character: occurrence.col + varName.length + 4 },
            },
            analyzer: 'variable-validation',
          });
        }
      }
    }

    // Check for empty variable placeholders
    doc.lines.forEach((line, lineIndex) => {
      const emptyVarPattern = /\{\{\s*\}\}/g;
      let match;
      while ((match = emptyVarPattern.exec(line)) !== null) {
        results.push({
          code: 'empty-variable',
          message: 'Empty variable placeholder detected.',
          severity: 'error',
          range: {
            start: { line: lineIndex, character: match.index },
            end: { line: lineIndex, character: match.index + match[0].length },
          },
          analyzer: 'variable-validation',
        });
      }
    });

    return results;
  }

  // Instruction Strength & Positioning (Tier 1)
  private analyzeInstructionStrength(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    const criticalKeywords = ['safety', 'security', 'harmful', 'refuse', 'reject', 'never', 'forbidden', 'prohibited', 'dangerous', 'illegal'];

    doc.lines.forEach((line, lineIndex) => {
      const lowerLine = line.toLowerCase();

      // Check if this line contains critical safety/constraint keywords
      const hasCriticalKeyword = criticalKeywords.some(keyword => lowerLine.includes(keyword));

      // Check for weak language in critical constraints
      for (const weakPattern of this.strengthPatterns.weak) {
        const regex = new RegExp(`\\b${weakPattern}\\b`, 'gi');
        let match;
        while ((match = regex.exec(line)) !== null) {
          if (hasCriticalKeyword) {
            results.push({
              code: 'weak-critical-instruction',
              message: `Critical constraint uses weak language: "${match[0]}". Consider using stronger language like "Never", "Must", or "Always".`,
              severity: 'warning',
              range: {
                start: { line: lineIndex, character: match.index },
                end: { line: lineIndex, character: match.index + match[0].length },
              },
              analyzer: 'instruction-strength',
              suggestion: this.suggestStrongerLanguage(match[0]),
            });
          } else {
            results.push({
              code: 'weak-instruction',
              message: `Weak instruction language: "${match[0]}". This may be interpreted inconsistently by the model.`,
              severity: 'info',
              range: {
                start: { line: lineIndex, character: match.index },
                end: { line: lineIndex, character: match.index + match[0].length },
              },
              analyzer: 'instruction-strength',
              suggestion: this.suggestStrongerLanguage(match[0]),
            });
          }
        }
      }
    });

    // Check for instruction positioning - important instructions at the beginning
    // Safety instructions should typically be at the end (recency bias)
    const totalLines = doc.lines.length;
    doc.lines.forEach((line, lineIndex) => {
      const lowerLine = line.toLowerCase();
      const hasSafetyKeyword = ['safety', 'harmful', 'refuse', 'reject', 'forbidden', 'prohibited'].some(k => lowerLine.includes(k));
      
      if (hasSafetyKeyword && lineIndex < totalLines * 0.3 && totalLines > 10) {
        results.push({
          code: 'safety-positioning',
          message: 'Safety instructions placed early in the prompt. Consider moving critical safety constraints toward the end for better adherence (recency bias).',
          severity: 'info',
          range: {
            start: { line: lineIndex, character: 0 },
            end: { line: lineIndex, character: line.length },
          },
          analyzer: 'instruction-strength',
        });
      }
    });

    // Check for too many competing constraints
    let constraintCount = 0;
    doc.lines.forEach((line) => {
      const lowerLine = line.toLowerCase();
      const constraintWords = [...this.strengthPatterns.strong, ...this.strengthPatterns.medium];
      if (constraintWords.some(w => lowerLine.includes(w))) {
        constraintCount++;
      }
    });

    if (constraintCount > 15) {
      results.push({
        code: 'instruction-dilution',
        message: `High number of constraints detected (${constraintCount}). Too many competing instructions may dilute their effectiveness. Consider consolidating.`,
        severity: 'warning',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'instruction-strength',
      });
    }

    return results;
  }

  private suggestStrongerLanguage(weakPhrase: string): string {
    const suggestions: Record<string, string> = {
      'try to': 'Always',
      'consider': 'Must',
      'when appropriate': 'Always',
      'if possible': 'Must',
      'might': 'Will',
      'could': 'Must',
      'may want to': 'Must',
      'optionally': 'Always',
    };
    return suggestions[weakPhrase.toLowerCase()] || 'Must';
  }

  // Prompt Injection Surface Analysis (Tier 1)
  private analyzeInjectionSurface(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    doc.lines.forEach((line, lineIndex) => {
      // Check for user input interpolation points
      const variablePattern = /\{\{(user_input|user_message|input|query|message|user_query)\}\}/gi;
      let match;
      while ((match = variablePattern.exec(line)) !== null) {
        results.push({
          code: 'injection-surface',
          message: `User input interpolation point: {{${match[1]}}}. This is a potential injection vector. Consider using delimiters, input validation, or sandboxing.`,
          severity: 'warning',
          range: {
            start: { line: lineIndex, character: match.index },
            end: { line: lineIndex, character: match.index + match[0].length },
          },
          analyzer: 'injection-analysis',
          suggestion: `<user_input>\n{{${match[1]}}}\n</user_input>`,
        });
      }

      // Check for known injection patterns in the prompt itself
      for (const pattern of this.injectionPatterns) {
        const injectionMatch = pattern.exec(line);
        if (injectionMatch) {
          results.push({
            code: 'injection-pattern',
            message: `Potential jailbreak pattern detected: "${injectionMatch[0]}". If this is in user input, it could override your instructions.`,
            severity: 'error',
            range: {
              start: { line: lineIndex, character: injectionMatch.index },
              end: { line: lineIndex, character: injectionMatch.index + injectionMatch[0].length },
            },
            analyzer: 'injection-analysis',
          });
        }
      }
    });

    // Check if there are delimiters around user input
    const hasDelimiters = doc.text.includes('<user_input>') || 
                          doc.text.includes('```user') ||
                          doc.text.includes('---USER INPUT---') ||
                          doc.text.includes('<input>');
    
    const hasUserVars = /\{\{(user_input|user_message|input|query)\}\}/gi.test(doc.text);

    if (hasUserVars && !hasDelimiters) {
      results.push({
        code: 'missing-input-delimiters',
        message: 'User input is interpolated without clear delimiters. Consider wrapping user input in XML tags or code blocks to prevent injection attacks.',
        severity: 'warning',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'injection-analysis',
      });
    }

    return results;
  }

  // Ambiguity Detection (Tier 1)
  private analyzeAmbiguity(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    doc.lines.forEach((line, lineIndex) => {
      const lowerLine = line.toLowerCase();

      // Check for ambiguous quantifiers
      for (const quantifier of this.ambiguousQuantifiers) {
        const regex = new RegExp(`\\b${quantifier}\\b`, 'gi');
        let match;
        while ((match = regex.exec(line)) !== null) {
          results.push({
            code: 'ambiguous-quantifier',
            message: `Ambiguous quantifier: "${match[0]}". The model may interpret this inconsistently. Consider specifying exact values.`,
            severity: 'info',
            range: {
              start: { line: lineIndex, character: match.index },
              end: { line: lineIndex, character: match.index + match[0].length },
            },
            analyzer: 'ambiguity-detection',
          });
        }
      }

      // Check for vague terms
      for (const term of this.vagueTerms) {
        const regex = new RegExp(`\\bbe ${term}\\b|\\bin a ${term}\\b`, 'gi');
        let match;
        while ((match = regex.exec(line)) !== null) {
          results.push({
            code: 'vague-term',
            message: `Vague term: "${match[0]}". Consider defining what this means specifically for your use case.`,
            severity: 'info',
            range: {
              start: { line: lineIndex, character: match.index },
              end: { line: lineIndex, character: match.index + match[0].length },
            },
            analyzer: 'ambiguity-detection',
          });
        }
      }

      // Check for unresolved references
      const unresolvedPatterns = [
        /\b(mentioned|described|shown|listed|given)\s+(above|below|earlier|previously|before)\b/gi,
        /\bthe\s+(above|below|following|preceding)\s+(format|example|instructions?|rules?|guidelines?)\b/gi,
        /\bsee\s+(above|below)\b/gi,
        /\bas\s+(mentioned|described|stated)\b/gi,
      ];

      for (const pattern of unresolvedPatterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          results.push({
            code: 'unresolved-reference',
            message: `Potentially unresolved reference: "${match[0]}". Ensure the referenced content exists and is clear.`,
            severity: 'info',
            range: {
              start: { line: lineIndex, character: match.index },
              end: { line: lineIndex, character: match.index + match[0].length },
            },
            analyzer: 'ambiguity-detection',
          });
        }
      }
    });

    return results;
  }

  // Structure & Style Linting (Tier 4, but useful as static check)
  private analyzeStructure(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Check for mixed XML/Markdown conventions
    const hasXmlTags = /<[a-z]+>/i.test(doc.text);
    const hasMarkdownHeaders = /^#{1,6}\s+/m.test(doc.text);

    if (hasXmlTags && hasMarkdownHeaders) {
      results.push({
        code: 'mixed-conventions',
        message: 'Mixed XML and Markdown formatting detected. Consider using a consistent convention throughout.',
        severity: 'hint',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'structure-linting',
      });
    }

    // Check for unclosed XML tags
    const xmlTagPattern = /<([a-z_]+)>/gi;
    const closingTagPattern = /<\/([a-z_]+)>/gi;
    
    const openTags = new Map<string, number>();
    const closeTags = new Map<string, number>();

    let match;
    while ((match = xmlTagPattern.exec(doc.text)) !== null) {
      const tagName = match[1].toLowerCase();
      openTags.set(tagName, (openTags.get(tagName) || 0) + 1);
    }

    while ((match = closingTagPattern.exec(doc.text)) !== null) {
      const tagName = match[1].toLowerCase();
      closeTags.set(tagName, (closeTags.get(tagName) || 0) + 1);
    }

    for (const [tag, count] of openTags) {
      const closeCount = closeTags.get(tag) || 0;
      if (count !== closeCount) {
        results.push({
          code: 'unclosed-tag',
          message: `Mismatched XML tag: <${tag}> appears ${count} time(s), </${tag}> appears ${closeCount} time(s).`,
          severity: 'warning',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'structure-linting',
        });
      }
    }

    return results;
  }

  // Redundancy Detection (Tier 4 - but useful statically)
  private analyzeRedundancy(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];
    
    // Track instruction patterns for duplicate detection
    const instructionPatterns = new Map<string, number[]>();
    const instructionRegex = /\b(must|should|always|never|avoid|do not|don't)\s+([^.!?]+)/gi;

    doc.lines.forEach((line, lineIndex) => {
      let match;
      while ((match = instructionRegex.exec(line)) !== null) {
        const normalizedInstruction = match[2].toLowerCase().trim().replace(/\s+/g, ' ');
        // Only consider instructions of reasonable length
        if (normalizedInstruction.length > 10) {
          const existing = instructionPatterns.get(normalizedInstruction) || [];
          existing.push(lineIndex);
          instructionPatterns.set(normalizedInstruction, existing);
        }
      }
    });

    // Check for duplicates
    for (const [instruction, lines] of instructionPatterns) {
      if (lines.length > 1) {
        results.push({
          code: 'redundant-instruction',
          message: `Similar instruction appears ${lines.length} times (lines ${lines.map(l => l + 1).join(', ')}). Consider consolidating.`,
          severity: 'info',
          range: {
            start: { line: lines[0], character: 0 },
            end: { line: lines[0], character: doc.lines[lines[0]]?.length || 0 },
          },
          analyzer: 'redundancy-detection',
        });
      }
    }

    // Check for subsumed constraints (one implies another)
    const neverPatterns: { text: string; line: number }[] = [];
    const avoidPatterns: { text: string; line: number }[] = [];

    doc.lines.forEach((line, lineIndex) => {
      const neverMatch = line.match(/never\s+([^.!?]+)/i);
      if (neverMatch) {
        neverPatterns.push({ text: neverMatch[1].toLowerCase(), line: lineIndex });
      }
      const avoidMatch = line.match(/avoid\s+([^.!?]+)/i);
      if (avoidMatch) {
        avoidPatterns.push({ text: avoidMatch[1].toLowerCase(), line: lineIndex });
      }
    });

    // "Never X" subsumes "Avoid X"
    for (const avoidP of avoidPatterns) {
      for (const neverP of neverPatterns) {
        if (avoidP.text.includes(neverP.text.substring(0, 20)) || neverP.text.includes(avoidP.text.substring(0, 20))) {
          results.push({
            code: 'subsumed-constraint',
            message: `"Avoid" on line ${avoidP.line + 1} may be subsumed by "Never" on line ${neverP.line + 1}. Consider removing the weaker constraint.`,
            severity: 'hint',
            range: {
              start: { line: avoidP.line, character: 0 },
              end: { line: avoidP.line, character: doc.lines[avoidP.line]?.length || 0 },
            },
            analyzer: 'redundancy-detection',
          });
          break;
        }
      }
    }

    return results;
  }

  // Example Sufficiency Analysis (Tier 3)
  private analyzeExamples(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Detect example sections
    const examplePatterns = [
      /example[s]?:/i,
      /for example/i,
      /e\.g\./i,
      /such as:/i,
      /here's how/i,
      /sample\s+(input|output|response)/i,
    ];

    const hasExamples = examplePatterns.some(p => p.test(doc.text));
    const hasJsonOutput = /json|object|array|\{|\[/i.test(doc.text) && /output|respond|return/i.test(doc.text);
    const hasFormatRequirement = /format|structure|schema/i.test(doc.text);

    // Check if output format is specified but no examples given
    if ((hasJsonOutput || hasFormatRequirement) && !hasExamples) {
      results.push({
        code: 'missing-examples',
        message: 'Output format specified but no examples provided. Consider adding a few-shot example to clarify expected output structure.',
        severity: 'info',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'example-analysis',
      });
    }

    // Count examples if present
    if (hasExamples) {
      const inputExamples = (doc.text.match(/input\s*:/gi) || []).length;
      const outputExamples = (doc.text.match(/output\s*:/gi) || []).length;

      if (inputExamples > 0 && outputExamples > 0 && inputExamples !== outputExamples) {
        results.push({
          code: 'example-mismatch',
          message: `Found ${inputExamples} input example(s) but ${outputExamples} output example(s). Ensure each input has a corresponding output.`,
          severity: 'warning',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'example-analysis',
        });
      }

      // Check for negative examples (refusal cases)
      const hasRefusalInstructions = /refuse|reject|decline|don't|do not|never/i.test(doc.text);
      const hasNegativeExample = /bad example|negative example|incorrect|wrong|don't do|invalid/i.test(doc.text);

      if (hasRefusalInstructions && !hasNegativeExample && inputExamples > 0) {
        results.push({
          code: 'missing-negative-example',
          message: 'Prompt has refusal/rejection instructions but no negative examples. Consider adding an example showing correct refusal behavior.',
          severity: 'info',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'example-analysis',
        });
      }
    }

    return results;
  }

  // Token Usage Analysis (Tier 3) - Using tiktoken for accurate counting
  private analyzeTokenUsage(doc: PromptDocument): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // Get accurate token count using tiktoken
    const tokenInfo = this.getTokenInfo(doc);
    const estimatedTokens = tokenInfo.totalTokens;

    // Add budget warning if present
    if (tokenInfo.budgetWarning) {
      results.push({
        code: 'token-budget',
        message: tokenInfo.budgetWarning,
        severity: estimatedTokens > 4000 ? 'warning' : 'info',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'token-analysis',
      });
    }

    // Warn if prompt is large
    if (estimatedTokens > 2000) {
      results.push({
        code: 'large-prompt',
        message: `Prompt uses ${estimatedTokens} tokens. This is a large prompt. Leave room for your model's response and context window limits.`,
        severity: 'info',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'token-analysis',
      });
    }

    // Check for unicode/emoji heavy content (expensive tokens)
    const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu;
    const emojiMatches = doc.text.match(emojiPattern);
    if (emojiMatches && emojiMatches.length > 10) {
      results.push({
        code: 'emoji-tokens',
        message: `${emojiMatches.length} emojis detected. Emojis can use multiple tokens each. Consider reducing if token budget is tight.`,
        severity: 'hint',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        analyzer: 'token-analysis',
      });
    }

    // Check for words that tokenize poorly (multi-byte, compound words, etc.)
    const poorlyTokenizedPatterns = [
      /[A-Z]{10,}/g, // Long acronyms
      /\w{20,}/g, // Very long words
      /\d{10,}/g, // Long numbers
    ];

    for (const pattern of poorlyTokenizedPatterns) {
      let match;
      let lineIndex = 0;
      for (const line of doc.lines) {
        while ((match = pattern.exec(line)) !== null) {
          results.push({
            code: 'inefficient-tokenization',
            message: `"${match[0].substring(0, 20)}..." may tokenize inefficiently. Consider breaking up or abbreviating.`,
            severity: 'hint',
            range: {
              start: { line: lineIndex, character: match.index },
              end: { line: lineIndex, character: match.index + match[0].length },
            },
            analyzer: 'token-analysis',
          });
        }
        lineIndex++;
      }
    }

    // Section-by-section token breakdown for large prompts
    if (estimatedTokens > 1000 && tokenInfo.sections.size > 0) {
      const heaviestSection = [...tokenInfo.sections.entries()]
        .sort((a, b) => b[1] - a[1])[0];
      
      if (heaviestSection && heaviestSection[1] > estimatedTokens * 0.4) {
        results.push({
          code: 'heavy-section',
          message: `Section "${heaviestSection[0]}" uses ${heaviestSection[1]} tokens (${Math.round(heaviestSection[1] / estimatedTokens * 100)}% of prompt). Consider condensing.`,
          severity: 'info',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          analyzer: 'token-analysis',
        });
      }
    }

    return results;
  }
}
