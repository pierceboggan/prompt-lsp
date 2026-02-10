import { Range } from 'vscode-languageserver';

export interface PromptDocument {
  uri: string;
  text: string;
  lines: string[];
  variables: Map<string, number[]>;
  sections: Section[];
  compositionLinks: CompositionLink[];
}

export interface CompositionLink {
  target: string;
  resolvedPath?: string;
  line: number;
  column: number;
  endColumn: number;
}

export interface Section {
  name: string;
  startLine: number;
  endLine: number;
}

export interface AnalysisResult {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  range: Range;
  analyzer: string;
  suggestion?: string;
}

export interface Variable {
  name: string;
  line: number;
  column: number;
  isDefined: boolean;
  isUsed: boolean;
}

export interface InstructionStrength {
  text: string;
  strength: 'strong' | 'medium' | 'weak';
  line: number;
  column: number;
}

export interface InjectionPoint {
  variable: string;
  line: number;
  column: number;
  riskLevel: 'high' | 'medium' | 'low';
  context: string;
}

export interface Contradiction {
  instruction1: string;
  instruction2: string;
  line1: number;
  line2: number;
  severity: 'error' | 'warning';
  explanation: string;
}

export interface AmbiguityIssue {
  text: string;
  line: number;
  type: 'quantifier' | 'reference' | 'term' | 'scope';
  suggestion: string;
}

export interface TokenInfo {
  totalTokens: number;
  sections: Map<string, number>;
  budgetWarning?: string;
}

export interface LLMAnalysisRequest {
  text: string;
  analysisType: 
    | 'contradiction'
    | 'ambiguity'
    | 'persona'
    | 'safety'
    | 'coverage'
    | 'output_shape';
}

export interface LLMAnalysisResponse {
  issues: AnalysisResult[];
  confidence: number;
}

export interface CacheEntry {
  hash: string;
  results: AnalysisResult[];
  timestamp: number;
  ttl: number;
}

export interface PromptLSPConfig {
  enableLLMAnalysis: boolean;
  cacheTTL: number; // in seconds
  targetModel?: string; // Target model for compatibility checks
  maxTokenBudget?: number;
}

// LSP proxy types for vscode.lm integration
export interface LLMProxyRequest {
  prompt: string;
  systemPrompt: string;
}

export interface LLMProxyResponse {
  text: string;
  error?: string;
}

export type LLMProxyFn = (request: LLMProxyRequest) => Promise<LLMProxyResponse>;
