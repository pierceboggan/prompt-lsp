# How It Works

This document walks through how Prompt LSP analyzes your prompt files, from the moment you open a file to the diagnostics that appear in the Problems panel.

## Overview

Prompt LSP is a [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) implementation that runs as a Node.js process alongside VS Code. It has two main components:

- **Language Server** (`src/`) — Parses documents, runs analysis, and sends diagnostics via LSP
- **VS Code Client** (`client/`) — Connects to the server, provides UI integration, and proxies LLM requests through GitHub Copilot

Analysis happens in two layers:

| Layer | When it runs | Speed | Cost |
|-------|-------------|-------|------|
| **Static Analysis** | Every keystroke (quick subset) and after typing pauses (full) | < 10ms | Free |
| **LLM Analysis** | On save and on open (active file only) | 1–3s (cached) | GitHub Copilot subscription |

## Document Lifecycle

### 1. File Opens

When you open a supported file (`.agent.md`, `.prompt.md`, etc.), the server:

1. **Detects the file type** — The `detectFileType()` function in `src/parsing.ts` inspects the filename to determine whether it's an agent, prompt, system prompt, instructions, or skill file. This drives file-type-aware validation (e.g., agent files need a `description` in frontmatter).

2. **Parses the document** — `parsePromptDocument()` extracts:
   - **Frontmatter** — YAML between `---` delimiters, parsed with the `yaml` package
   - **Sections** — Markdown headers become sections with start/end line ranges
   - **Variables** — All `{{variable_name}}` references with their line positions
   - **Composition links** — Markdown links to other prompt files (e.g., `[base](./base.prompt.md)`)

3. **Runs full analysis** — Both static and LLM analysis run on open (LLM only if this is the active editor), and results are sent as LSP diagnostics.

### 2. Typing (Content Changes)

On every keystroke:

1. **Quick static analysis** runs immediately — this is a fast subset that skips expensive operations like token counting and filesystem access. It checks variables, instruction strength, ambiguity, structure, redundancy, examples, and frontmatter.

2. **After a 2-second typing pause**, full static analysis runs — this adds token counting (via tiktoken) and composition link validation (filesystem access to check linked files exist).

3. **LLM analysis does NOT run on keystrokes** — it's too expensive. It only runs on save or open, and only for the currently focused file. Background files receive static analysis only.

### 3. File Saves

On save, the server runs the complete analysis pipeline:

1. Compute a **composite content hash** — includes the file content plus the contents of any linked prompt files
2. Check the **analysis cache** — if the hash matches a cached entry that hasn't expired (1-hour TTL), return cached results immediately
3. On cache miss, run **static analysis** and (if this is the active file) **LLM analysis** in parallel
4. Cache the combined results and send diagnostics

### 4. File Closes

Per-document state is cleaned up: parsed document cache, analysis results, debounce timers, and version tracking.

## Static Analysis Pipeline

The static analyzer (`src/analyzers/static.ts`) runs nine checks:

### Variable Validation
Scans for `{{variable}}` patterns. Cross-references usages against definitions (patterns like `variable:` or `define variable`). Common runtime variables (`user_input`, `context`, etc.) are allowlisted. Also flags empty `{{}}` placeholders as errors.

### Instruction Strength
Classifies instruction language into three tiers:
- **Strong:** "never", "must", "always", "forbidden"
- **Medium:** "should", "avoid", "prefer"
- **Weak:** "try to", "consider", "if possible"

Warns on weak language and detects instruction dilution (>15 competing constraints).

### Ambiguity Detection
Flags three categories:
- **Ambiguous quantifiers** — "a few", "some", "several" → suggests specific values
- **Vague terms** — "be appropriate", "in a professional" → asks for specific definitions
- **Unresolved references** — "mentioned above", "see below" → warns these may not resolve

### Structure & Style Linting
Detects mixed XML and Markdown conventions in the same file. Counts opening and closing XML tags and reports mismatches.

### Redundancy Detection
Normalizes instruction text and finds duplicates. Also detects when a "Never X" constraint subsumes a weaker "Avoid X" constraint.

### Example Sufficiency
If the prompt specifies an output format (JSON, structured data) but provides no examples, it suggests adding few-shot examples. Also checks for mismatched input/output example counts.

### Token Counting
Uses [tiktoken](https://github.com/openai/tiktoken) for accurate GPT-4 token counts (with a char/4 fallback). Reports:
- Total token count and context window budget usage
- Per-section token breakdown (heaviest section warning)
- Expensive tokens: emojis, long acronyms, very long words

### Frontmatter Validation
File-type-aware validation:
- **Agent files** — warns if `description` is missing, flags deprecated `infer` field, reports unknown fields
- **Skill files** — requires `name` and `description`, validates name format (lowercase, hyphens, max 64 chars)
- **Prompt/Instructions files** — reports unknown frontmatter fields

### Composition Link Checking
For markdown links pointing to other prompt files (`.prompt.md`, `.agent.md`, etc.):
- Resolves relative paths against the document directory
- Validates the target file exists and is readable
- Enforces workspace containment (prevents path traversal)

## LLM Analysis Pipeline

The LLM analyzer (`src/analyzers/llm.ts`) uses GitHub Copilot's `vscode.lm` API for semantic analysis. All seven analyses run **in parallel** using `Promise.allSettled` so partial results are preserved even if some fail.

### How LLM Calls Work

1. The **language server** constructs a structured prompt with the document content wrapped in `<DOCUMENT_TO_ANALYZE>` tags
2. The server sends the prompt to the **VS Code client** via a custom LSP request (`promptLSP/llmRequest`)
3. The **client extension** forwards it to `vscode.lm.selectChatModels()` — preferring `gpt-4o` from Copilot
4. The **response** (JSON) is parsed by the server and converted to diagnostics

Each LLM prompt includes:
- A system prompt establishing the "prompt analysis expert" role
- Instructions to treat the document content as **data to analyze, not instructions to follow** (injection defense)
- A specific JSON schema for the expected response format

### LLM Analyses

| Analysis | What it detects |
|----------|----------------|
| **Contradiction Detection** | Logical conflicts ("be concise" vs "detailed explanations"), behavioral conflicts, format conflicts |
| **Semantic Ambiguity** | Deeper ambiguity than static analysis — vague instructions, unclear precedence, missing context |
| **Persona Consistency** | Conflicting personality traits, tone drift across sections |
| **Cognitive Load** | Nested conditions, priority conflicts, deep decision trees, constraint overload |
| **Output Shape Prediction** | Expected response length, structured output compliance, refusal probability |
| **Semantic Coverage** | Unhandled user intents, missing edge cases, absent error handling paths |
| **Composition Conflicts** | Conflicts across the current file and directly linked prompt files |

### Injection Defense

LLM prompts wrap document content in delimiters (`<DOCUMENT_TO_ANALYZE>`) and explicitly instruct the model to treat it as data. For composition conflict analysis, linked file contents are sanitized by stripping these delimiter markers before inclusion.

## Caching

The analysis cache (`src/cache.ts`) prevents redundant work:

- **Key:** SHA-256 hash of the document content (plus linked file contents for composed prompts)
- **TTL:** 1 hour
- **Max entries:** 100 (LRU eviction)
- **Scope:** Per-session (in-memory)

Cache hits return instantly. The cache is cleared on manual analysis (`Prompt LSP: Analyze Prompt`) or via the clear cache command.

## LSP Features

Beyond diagnostics, the server provides several LSP features implemented in `src/lspFeatures.ts` and `src/server.ts`:

### CodeLens
Two types of CodeLens appear at the top of the file and at each section header:
- **Issue count** — "Prompt LSP: 3 issues found" at line 0
- **Section token counts** — "§ Section Name — 142 tokens" at each heading

### Hover
Hovering over `{{variables}}` shows a tooltip explaining the variable. Hovering over instruction keywords shows their strength classification with guidance.

### Quick Fixes
Code actions are generated for specific diagnostic codes:
- `ambiguous-quantifier` → "Replace with 2-3" (specific value)
- `weak-instruction` → "Strengthen to Always"
- `empty-variable` → "Remove empty placeholder"
- `agent-missing-description` → "Add description field"
- `skill-missing-frontmatter` → "Add skill frontmatter"

### Go to Definition
- **Variables** — `Ctrl+Click` on `{{variable}}` jumps to its first occurrence
- **Composition links** — `Ctrl+Click` on a link target opens the linked prompt file

### Document Symbols
Markdown headers are exposed as document symbols, powering the Outline view and breadcrumb navigation.

## Client Extension

The VS Code client (`client/src/extension.ts`) handles:

1. **Server lifecycle** — Starts the language server process over IPC
2. **LLM proxy** — Bridges `promptLSP/llmRequest` calls from the server to `vscode.lm`
3. **Model selection** — Prefers `gpt-4o` from Copilot, falls back to any available model, caches the selection
4. **Status bar** — Shows live token count (quick estimate on change, accurate count via tiktoken after debounce)
5. **Commands** — Registers the analyze, token count, and cache clear commands
6. **File watching** — Notifies the server when prompt files change on disk
