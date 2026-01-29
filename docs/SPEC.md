# Prompt LSP: Language Server for AI Prompts

A language server protocol implementation for analyzing, validating, and improving AI prompts.

---

## Priority Tier 1: Critical Impact

### Contradiction Detection
**Why:** Contradictions silently degrade prompt effectiveness. Users rarely notice them.

- Logical conflicts: "Be concise" vs "provide detailed explanations"
- Behavioral conflicts: "Never refuse" vs "refuse harmful requests"
- Format conflicts: "respond in exactly 10 words" + "include a code block"

**Implementation:** LLM-powered semantic analysis on save, cached by content hash.

---

### Prompt Injection Surface Analysis
**Why:** Security-critical. User input interpolation points are attack vectors.

- Identify where `{{user_input}}` gets interpolated
- Flag instructions that could be overridden by injected content
- Suggest escaping, sandboxing, or delimiter strategies
- Pattern match against known jailbreak vectors

**Implementation:** Static analysis for interpolation points + LLM-powered vulnerability scoring.

---

### Instruction Strength & Positioning
**Why:** Many prompts fail not from bad content but from weak phrasing and poor placement.

| Strength | Examples |
|----------|----------|
| Strong | "Never", "Must", "Always", "Under no circumstances" |
| Medium | "Should", "Avoid", "Prefer" |
| Weak | "Try to", "Consider", "When appropriate", "If possible" |

- Warn when critical constraints use weak language
- Suggest moving important instructions to end (recency bias)
- Detect instruction dilution (too many competing constraints)

**Implementation:** Hybrid—static pattern matching for strength scoring, LLM for positioning recommendations.

---

### Variable/Placeholder Validation
**Why:** Runtime errors from undefined variables are common and preventable.

- `{{user_name}}` referenced but never defined
- Unused context variables (dead code)
- Type mismatches (expecting array, got string)
- Missing required context

**Implementation:** Pure static analysis—fast, reliable, no LLM needed.

---

### Ambiguity Detection
**Why:** Vague instructions lead to inconsistent model behavior.

- Quantifier warnings: "a few", "sometimes", "when appropriate"
- Unresolved references: "use the format mentioned above" (where?)
- Undefined terms: "be professional" (what does that mean here?)
- Scope ambiguity: overlapping rules with unclear precedence

**Implementation:** LLM analysis with structured output for suggestion generation.

---

## Priority Tier 2: High Impact

### Cross-Prompt Composition Validation
**Why:** Prompts that work alone often conflict when combined at runtime.

- System + user + context concatenation analysis
- Predict emergent conflicts from composition
- Import/inheritance dependency tracking
- Circular dependency detection across prompt files

**Implementation:** Build dependency graph (static), analyze compositions (LLM).

---

### Safety Guardrail Integrity
**Why:** Weak guardrails fail silently until exploited.

- Jailbreak susceptibility scoring
- Pattern match against known attack vectors
- Identify guardrails that can be circumvented with roleplay
- Missing safety boundaries for detected capabilities
- "This phrasing is vulnerable to 'pretend you are' attacks"

**Implementation:** Static pattern library + LLM-powered adversarial analysis.

---

### Output Shape Prediction
**Why:** Mismatched expectations cause downstream failures.

- Token count estimation for typical responses
- JSON/structured output validity prediction
- Refusal rate estimation
- Format compliance probability
- "This prompt will produce ~500 tokens on average"

**Implementation:** LLM analysis with calibrated confidence scores.

---

### Persona Consistency
**Why:** Inconsistent persona confuses models and degrades output quality.

- Conflicting personality traits
- Tone drift detection across sections
- "You're a helpful assistant" + "respond with sarcasm" = conflict
- Implied characteristics that clash with stated behavior

**Implementation:** LLM semantic analysis.

---

### Cognitive Load Assessment
**Why:** Overly complex prompts overwhelm model attention.

- Too many nested conditions
- Conflicting prioritization hierarchies
- "This section has 12 constraints fighting for attention"
- Decision tree depth warnings (>3 levels = concerning)
- Suggest consolidation or prioritization

**Implementation:** Static complexity metrics + LLM suggestions for simplification.

---

## Priority Tier 3: Medium Impact

### Model-Specific Compatibility
**Why:** Prompts often need adjustment across models.

- "This phrasing works for GPT-4 but confuses Claude"
- Model-specific idiom suggestions
- Capability gap warnings ("This model can't execute code")
- API compatibility checks (tool schemas, function calling format)

**Implementation:** Model capability database + pattern matching.

---

### Tokenization Awareness
**Why:** Invisible costs and edge cases from tokenization.

- Words that tokenize poorly
- Unicode/emoji token cost warnings
- Context window budget visualization
- "This prompt uses 2,847 of your 4,096 token budget"

**Implementation:** Pure static analysis with tokenizer libraries.

---

### Reasoning Affordance Analysis
**Why:** Task complexity must match reasoning support.

- Does prompt enable chain-of-thought when needed?
- Mismatch between task complexity and verbosity constraints
- "This task requires multi-step reasoning but prompt demands brevity"
- Self-correction affordance (can model express uncertainty?)

**Implementation:** LLM analysis of task requirements vs. constraints.

---

### Semantic Coverage / Intent Matrix
**Why:** Gaps in coverage lead to undefined behavior.

- What user intents does this prompt handle well/poorly?
- "No guidance for edge case: user asks about competitors"
- Gap analysis against expected use cases
- Missing error handling paths

**Implementation:** LLM-generated coverage report based on stated purpose.

---

### Example Sufficiency Analysis
**Why:** Few-shot examples are powerful but often incomplete.

- Examples present but don't cover output format
- "Add negative example for refusal case"
- Example diversity scoring
- Consistency between examples and instructions

**Implementation:** Static counting + LLM semantic analysis.

---

### Prompt Diff / Regression Detection
**Why:** Changes have consequences that aren't obvious.

- "This change weakens your safety guardrails"
- "New instruction conflicts with removed instruction"
- Semantic diff beyond text diff
- Track versions against eval results when available

**Implementation:** Diff analysis + LLM-powered semantic change detection.

---

## Priority Tier 4: Nice to Have

### Redundancy Detection
- Repeated instructions with slight variations
- Subsumed constraints (one rule implies another)
- Consolidation suggestions

### Structure & Style Linting
- Section ordering recommendations (context → behavior → format → safety)
- Inconsistent heading styles
- Mixed XML/Markdown conventions
- Unclosed tags

### Audience Model Validation
- Prompt assumes technical expertise but targets beginners
- Reading level analysis vs. stated audience
- Cultural assumption detection

### Latency Estimation
- Complex reasoning chains = longer inference
- Tool call probability estimation
- "This prompt triggers chain-of-thought 80% of the time"

### Emotional Valence
- Aggressive phrasing may produce defensive responses
- Prompt tone affects response tone
- Suggest neutral alternatives

### Implicit Assumption Detection
- "Assumes model knows current date"
- "Assumes model has internet access"
- "Assumes English-only input"

### Sycophancy Detection
- "This prompt encourages agreement over accuracy"
- Missing instructions for disagreement/correction

### Observability Hooks
- Suggest where to add trace markers
- "Add request_id for debugging"
- A/B testing structure identification

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Prompt Document                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Layer 1: Static Analysis                  │
│  • Syntax validation          • Variable resolution         │
│  • Token counting             • Structure linting           │
│  • Pattern matching           • Strength scoring            │
│                                                             │
│  Latency: <10ms               Cost: Free                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Layer 2: LLM-Powered Analysis                  │
│  • Contradiction detection    • Ambiguity analysis          │
│  • Persona consistency        • Safety scoring              │
│  • Output prediction          • Semantic coverage           │
│                                                             │
│  Latency: 1-3s (cached)       Cost: Moderate                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       LSP Cache                             │
│  • Content-hash keyed         • Incremental updates         │
│  • Cross-session persistence  • TTL-based expiry            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      LSP Interface                          │
│  • Diagnostics (errors, warnings, info)                     │
│  • Hover information                                        │
│  • Code actions (quick fixes)                               │
│  • Go to definition (variables, references)                 │
│  • Document symbols                                         │
└─────────────────────────────────────────────────────────────┘
```

## Caching Strategy

| Trigger | Action | Cache Behavior |
|---------|--------|----------------|
| Keystroke | Static checks only | N/A |
| Pause (500ms) | Debounced static refresh | N/A |
| Save | Full analysis if changed | Check hash → hit or analyze |
| Focus | Retrieve cached diagnostics | Instant if cached |

## File Association

```json
{
  "files.associations": {
    "*.prompt.md": "prompt",
    "*.system.md": "prompt",
    "*.agent.md": "prompt"
  }
}
```

## Open Questions

1. **How to handle intentional tensions?**
   "Be helpful" vs "refuse harmful requests" isn't a bug—it's a deliberate tradeoff. Need severity calibration.

2. **Ground truth for accuracy?** 
   LLM analysis could be wrong. How to validate? Human review? Eval correlation?

3. **Model-specific analysis?** 
   Should there be a target model setting that adjusts recommendations?

4. **Prompt testing integration?** 
   Could inline test results enhance diagnostics? "This constraint violated in 3/100 test cases"

5. **Multi-file prompts?** 
   How to handle prompts split across files or composed at runtime?
