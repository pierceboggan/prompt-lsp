# Prompt LSP

[![CI](https://github.com/pierceboggan/prompt-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/pierceboggan/prompt-lsp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Language Server Protocol implementation for analyzing, validating, and improving AI prompt files. Works with `.prompt.md`, `.agent.md`, `.system.md`, `.instructions.md`, and skill files — providing real-time diagnostics, token counting, and LLM-powered semantic analysis directly in VS Code.

## Features

### Static Analysis (instant, every keystroke)

- **Variable/Placeholder Validation** — Flags undefined `{{variables}}` and empty placeholders
- **Instruction Strength** — Warns when critical constraints use weak language ("try to", "consider")
- **Ambiguity Detection** — Catches vague quantifiers ("a few"), unresolved references ("as mentioned above"), and undefined terms
- **Structure & Style Linting** — Detects mixed XML/Markdown conventions and unclosed XML tags
- **Redundancy Detection** — Finds duplicate instructions and subsumed constraints
- **Example Sufficiency** — Warns when output format is specified but no examples are provided
- **Token Counting** — Accurate token counts via [tiktoken](https://github.com/openai/tiktoken), with per-section breakdowns and context window budget warnings
- **Frontmatter Validation** — File-type-aware validation for agent, prompt, instructions, and skill frontmatter fields
- **Composition Link Checking** — Validates that markdown links to other prompt files resolve correctly

### LLM-Powered Analysis (on save, via GitHub Copilot)

- **Contradiction Detection** — Finds logical, behavioral, and format conflicts
- **Semantic Ambiguity** — Deeper ambiguity analysis with rewrite suggestions
- **Persona Consistency** — Detects conflicting personality traits and tone drift
- **Cognitive Load Assessment** — Warns about overly complex prompts with too many nested conditions
- **Output Shape Prediction** — Predicts response length, format compliance, and refusal probability
- **Semantic Coverage** — Identifies gaps in intent handling and missing error paths
- **Composition Conflict Analysis** — Detects conflicts across linked/composed prompt files

### Editor Integration

- **CodeLens** — Issue count and per-section token counts displayed inline
- **Hover Information** — Variable details and instruction strength explanations on hover
- **Quick Fixes** — One-click fixes for ambiguous quantifiers, weak instructions, empty variables, and missing frontmatter
- **Go to Definition** — Navigate to variable definitions and linked prompt files
- **Document Symbols** — Outline view of prompt sections
- **Status Bar** — Live token count in the status bar

## Supported File Types

| Pattern | Type |
|---|---|
| `*.agent.md` | Agent |
| `*.prompt.md` | Prompt |
| `*.system.md` | System prompt |
| `*.instructions.md` | Instructions |
| `agents.md` | Agents config |
| `copilot-instructions.md` | Copilot instructions |
| `**/skills/**/SKILL.md` | Skill |

## Installation

```bash
git clone https://github.com/pierceboggan/prompt-lsp.git
cd prompt-lsp
npm install
npm run build
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Usage

1. Open any supported prompt file in VS Code
2. **Static diagnostics** appear instantly as you type
3. **LLM diagnostics** run automatically on save (requires GitHub Copilot)
4. Use the **Problems panel** (`Ctrl+Shift+M`) to see all issues

### Commands

| Command | Description |
|---------|-------------|
| `Prompt LSP: Analyze Prompt` | Force full re-analysis (including LLM) |
| `Prompt LSP: Show Token Count` | Show accurate token count for the active file |
| `Prompt LSP: Clear Analysis Cache` | Clear cached analysis results |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `promptLSP.enable` | `true` | Enable/disable the extension |
| `promptLSP.trace.server` | `off` | Trace communication between VS Code and the language server |

### LLM Analysis

LLM-powered analysis uses **GitHub Copilot's `vscode.lm` API** — no API keys needed. Just sign in to GitHub Copilot in VS Code and the semantic analyses activate automatically.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Prompt Document                         │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│  Layer 1: Static Analysis│  │ Layer 2: LLM Analysis        │
│                          │  │                              │
│  • Variables & structure │  │ • Contradictions & persona   │
│  • Strength & ambiguity  │  │ • Coverage & output shape    │
│  • Tokens & frontmatter  │  │ • Cognitive load & conflicts │
│  • Composition links     │  │ • Composition conflicts      │
│                          │  │                              │
│  Runs: every keystroke   │  │ Runs: on save                │
│  Cost: free              │  │ Cost: Copilot subscription   │
└──────────────────────────┘  └──────────────────────────────┘
                    │                   │
                    └─────────┬─────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Analysis Cache                          │
│  Content-hash keyed • TTL-based expiry • 100 entry max     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       LSP Interface                         │
│  Diagnostics • CodeLens • Hover • Quick Fixes • Go-to-Def  │
└─────────────────────────────────────────────────────────────┘
```

For a deeper walkthrough, see [How It Works](docs/HOW_IT_WORKS.md).

## Project Structure

```
src/
├── server.ts              # LSP server entry point, document lifecycle, diagnostics
├── types.ts               # Shared TypeScript types and interfaces
├── cache.ts               # Content-hash analysis cache with TTL
├── parsing.ts             # Document parsing, frontmatter, composition links
├── lspFeatures.ts         # CodeLens, Go-to-Definition, variable lookup helpers
├── analyzers/
│   ├── static.ts          # All static analysis rules
│   └── llm.ts             # All LLM-powered analysis rules
└── __tests__/
    ├── static.test.ts     # Static analyzer tests
    ├── llm.test.ts        # LLM analyzer tests
    ├── cache.test.ts      # Cache tests
    ├── parsing.test.ts    # Parsing tests
    └── lspFeatures.test.ts # LSP features tests

client/
├── src/extension.ts       # VS Code extension activation, LLM proxy, status bar
├── syntaxes/              # TextMate grammar for syntax highlighting
└── package.json           # Extension manifest with configuration schema

examples/                  # Sample prompt files for manual testing
docs/                      # Design specs and guides
```

## Development

```bash
npm run compile      # Build server only
npm run build        # Build server + client
npm test             # Run tests (vitest)
npx vitest           # Run tests in watch mode
npm run watch        # Watch server changes
npm run lint         # Run ESLint
```

Press `F5` in VS Code to launch the Extension Development Host for manual testing.

## Documentation

- [How It Works](docs/HOW_IT_WORKS.md) — Detailed walkthrough of the analysis pipeline
- [Design Specification](docs/SPEC.md) — Full analysis tier details and design decisions
- [Contributing Guide](CONTRIBUTING.md) — How to set up, build, test, and contribute
- [Agent Prompts Guide](docs/agents.md) — Best practices for writing `.agent.md` files

## Examples

The `examples/` directory contains sample prompt files for testing:

- [`sample.prompt.md`](examples/sample.prompt.md) — A well-structured prompt demonstrating common patterns
- [`problematic.agent.md`](examples/problematic.agent.md) — An intentionally flawed prompt that triggers many diagnostics
- [`self-verification.agent.md`](examples/self-verification.agent.md) — Self-verification pattern for agents
- [`tdd.agent.md`](examples/tdd.agent.md) — TDD workflow agent

## License

MIT
