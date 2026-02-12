# AGENTS.md

## Project Overview

Prompt LSP is a Language Server Protocol implementation for analyzing, validating, and improving AI prompt files (`.prompt.md`, `.agent.md`, `.system.md`, `.instructions.md`). It ships as a VS Code extension with a language server backend.

## Architecture

The project has two main components:

- **Language Server** (`src/`) — Node.js LSP server that analyzes prompt documents
- **VS Code Client** (`client/`) — Extension that connects to the server and provides UI integration

Analysis is split into two layers:

1. **Static Analysis** (`src/analyzers/static.ts`) — Fast, free, runs on every keystroke. Handles variable validation, injection detection, instruction strength, ambiguity, tokenization, frontmatter validation, and composition link checking.
2. **LLM Analysis** (`src/analyzers/llm.ts`) — Semantic analysis via GitHub Copilot's `vscode.lm` API. Handles contradiction detection, persona consistency, safety guardrail analysis, cognitive load, output shape prediction, and semantic coverage. Runs on save with debouncing.

Results are cached by content hash in `src/cache.ts` with TTL-based expiry.

## Build & Test

```bash
npm install          # Install all dependencies (server + client)
npm run compile      # Build server only
npm run build        # Build server + client
npm test             # Run tests (vitest)
npx vitest           # Run tests in watch mode
```

Press `F5` in VS Code to launch the Extension Development Host for manual testing.

## Project Structure

```
src/
├── server.ts              # LSP server entry point, document parsing, diagnostics
├── types.ts               # Shared TypeScript types and interfaces
├── cache.ts               # Content-hash analysis cache with TTL
├── analyzers/
│   ├── static.ts          # All static analysis rules
│   └── llm.ts             # All LLM-powered analysis rules
└── __tests__/
    ├── static.test.ts     # Static analyzer tests
    └── cache.test.ts      # Cache tests

client/
├── src/extension.ts       # VS Code extension activation, LLM proxy setup
├── syntaxes/              # TextMate grammar for syntax highlighting
└── package.json           # Extension manifest with configuration schema

examples/                  # Sample prompt files for manual testing
docs/                      # Design specs and guides
```

## Key Conventions

- TypeScript strict mode is enabled.
- Tests use Vitest and live in `src/__tests__/`. Test files follow the pattern `*.test.ts`.
- Static analyzers return `AnalysisResult[]` — each result has a `code`, `message`, `severity`, `range`, and `analyzer` field.
- The LLM analyzer communicates with Copilot via a proxy function (`LLMProxyFn`) set up during server initialization. It sends structured prompts and parses JSON responses.
- Token counting uses tiktoken for accuracy, with a fallback estimator.
- Frontmatter validation is file-type-aware: agents, prompts, instructions, and skills each have their own known fields.

## Adding a New Analyzer

1. Add your analysis method to `src/analyzers/static.ts` (for deterministic checks) or `src/analyzers/llm.ts` (for semantic/LLM-powered checks).
2. Call the new method from the class's `analyze()` function.
3. Add tests in `src/__tests__/`.
4. Use the `AnalysisResult` interface from `src/types.ts` for all diagnostics.
5. Document the new diagnostic code in `docs/SPEC.md`.

## File Types

The server recognizes these prompt file types (see `detectFileType` in `src/server.ts`):

| Pattern | Type |
|---|---|
| `*.agent.md` | `agent` |
| `*.prompt.md` | `prompt` |
| `*.system.md` | `system` |
| `*.instructions.md` | `instructions` |
| `agents.md` | `agents-md` |
| `copilot-instructions.md` | `copilot-instructions` |
| `**/skills/**/*.md` | `skill` |

## Configuration

Extension settings are declared in `client/package.json` under `contributes.configuration`:

- `promptLSP.enable` — Enable/disable the extension (default: `true`)
- `promptLSP.trace.server` — Trace LSP communication (`off` | `messages` | `verbose`)

Commands (available via Command Palette):

- `Prompt LSP: Analyze Prompt` — Trigger full analysis (including LLM) on the active file
- `Prompt LSP: Show Token Count` — Show accurate token count for the active file
- `Prompt LSP: Clear Analysis Cache` — Invalidate all cached analysis results

## Dependencies

- `vscode-languageserver` / `vscode-languageserver-textdocument` — LSP protocol
- `tiktoken` — Accurate token counting
- `crypto-js` — Hashing (legacy; `src/cache.ts` uses Node's built-in `crypto`)
