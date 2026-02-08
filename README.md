# Prompt LSP

[![CI](https://github.com/pierceboggan/prompt-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/pierceboggan/prompt-lsp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Language Server Protocol implementation for analyzing, validating, and improving AI prompts.

## Features

### Tier 1: Critical Impact
- **Contradiction Detection** - LLM-powered semantic conflict analysis
- **Prompt Injection Surface Analysis** - Detects injection vectors and suggests delimiters
- **Instruction Strength & Positioning** - Warns about weak language in critical constraints, recency bias
- **Variable/Placeholder Validation** - Identifies undefined `{{variables}}`
- **Ambiguity Detection** - Flags vague quantifiers, unresolved references, undefined terms

### Tier 2: High Impact
- **Safety Guardrail Integrity** - LLM analysis of jailbreak vulnerabilities
- **Output Shape Prediction** - Token estimates, format compliance, refusal rate
- **Persona Consistency** - Detects conflicting personality traits/tone drift
- **Cognitive Load Assessment** - Warns about overly complex prompts

### Tier 3: Medium Impact
- **Tokenization Awareness** - Accurate token counting via tiktoken
- **Semantic Coverage Analysis** - LLM identifies coverage gaps/edge cases
- **Example Sufficiency Analysis** - Checks for missing/mismatched examples
- **Redundancy Detection** - Finds duplicate or subsumed constraints

## Installation

```bash
# Clone the repository
git clone https://github.com/pierceboggan/prompt-lsp.git
cd prompt-lsp

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### VS Code Extension

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open any `.prompt.md`, `.system.md`, or `.agent.md` file
4. Diagnostics appear automatically on save/open

### File Associations

The extension automatically recognizes:
- `*.prompt.md` - Prompt files
- `*.system.md` - System prompts
- `*.agent.md` - Agent prompts
- `*.prompt` - Generic prompt files

### Commands

- **Prompt LSP: Analyze Prompt** - Force re-analysis
- **Prompt LSP: Show Token Count** - Display token count
- **Prompt LSP: Clear Analysis Cache** - Clear cached results

### Accessibility

All diagnostics are surfaced through the standard VS Code Problems panel, which supports:
- Screen reader announcements for new diagnostics
- Keyboard navigation through all warnings and errors (`F8` / `Shift+F8`)
- High-contrast theme compatibility for severity indicators
- Hover tooltips with detailed explanations accessible via keyboard (`Ctrl+K Ctrl+I`)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `promptLSP.enable` | `true` | Enable/disable extension |
| `promptLSP.enableLLMAnalysis` | `true` | Enable LLM-powered analysis |
| `promptLSP.llmProvider` | `openai` | LLM provider (`openai` or `anthropic`) |
| `promptLSP.llmModel` | `gpt-4` | Model for LLM analysis |
| `promptLSP.maxTokenBudget` | `4096` | Token budget warning threshold |
| `promptLSP.targetModel` | `auto` | Target model for compatibility |

### LLM Analysis

For full semantic analysis (contradiction detection, safety analysis, etc.), set an API key:

```bash
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Prompt Document                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Layer 1: Static Analysis                  │
│  • Variable validation       • Instruction strength         │
│  • Token counting            • Structure linting            │
│  • Injection detection       • Ambiguity detection          │
│                                                             │
│  Latency: <10ms              Cost: Free                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Layer 2: LLM-Powered Analysis                │
│  • Contradiction detection   • Ambiguity analysis           │
│  • Persona consistency       • Safety scoring               │
│  • Output prediction         • Semantic coverage            │
│                                                             │
│  Latency: 1-3s (cached)      Cost: Moderate                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        LSP Cache                            │
│  • Content-hash keyed        • TTL-based expiry             │
└─────────────────────────────────────────────────────────────┘
```

## Development

```bash
# Watch mode (server)
npm run watch

# Watch mode (client)
cd client && npm run watch

# Run tests
npm test

# Debug in VS Code
# Press F5 with launch.json configured
```

## Project Structure

```
prompt-lsp/
├── src/
│   ├── server.ts          # LSP server entry point
│   ├── types.ts           # Type definitions
│   ├── cache.ts           # Content-hash caching
│   └── analyzers/
│       ├── static.ts      # Static analysis (fast)
│       └── llm.ts         # LLM-powered analysis
├── client/
│   ├── src/
│   │   └── extension.ts   # VS Code extension
│   ├── syntaxes/          # Syntax highlighting
│   └── package.json       # Extension manifest
├── examples/
│   └── sample.prompt.md   # Example prompt file
└── out/                   # Compiled output
```

## License

MIT

## Documentation

- [Contributing Guide](CONTRIBUTING.md) — How to set up, build, test, and contribute
- [Agent Prompts Guide](docs/agents.md) — Best practices for writing `.agent.md` files
- [Design Specification](docs/SPEC.md) — Architecture and analysis tier details

## Examples

The `examples/` directory contains sample prompt files:

- [`sample.prompt.md`](examples/sample.prompt.md) — A well-structured prompt demonstrating common patterns
- [`problematic.agent.md`](examples/problematic.agent.md) — An intentionally flawed prompt that triggers many diagnostics
- [`self-verification.agent.md`](examples/self-verification.agent.md) — An agent prompt demonstrating self-verification (checking its own output before responding)
