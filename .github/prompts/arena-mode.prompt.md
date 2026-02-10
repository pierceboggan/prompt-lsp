---
name: arena-mode
description: Have three models implement the same task independently, then grade and compare their implementations
---
Run an arena-mode coding competition:

1. **Parallel implementation** — Invoke `arena-opus`, `arena-gemini`, and `arena-codex` as three parallel subagents. Give each one the exact same task described below. Each model implements the changes independently.

2. **Collect results** — Gather each model's implementation summary, files changed, trade-offs, and self-score.

3. **Cross-grade** — For each pair of implementations, compare them on these criteria (score each 1-10):
   - **Correctness**: Does the code work? Edge cases handled?
   - **Code quality**: Clean, idiomatic, follows project conventions?
   - **Completeness**: All aspects of the request addressed?
   - **Minimality**: No over-engineering or unnecessary changes?
   - **Testing**: Tests added/updated appropriately?

4. **Pick a winner** — Determine which implementation is best overall. If implementations can be combined (best parts from each), suggest a merged approach.

5. **Output the final scorecard**:

```markdown
## Arena Results

### Contender Scores
| Criteria | Opus | Gemini | Codex |
|----------|------|--------|-------|
| Correctness | /10 | /10 | /10 |
| Code Quality | /10 | /10 | /10 |
| Completeness | /10 | /10 | /10 |
| Minimality | /10 | /10 | /10 |
| Testing | /10 | /10 | /10 |
| **Total** | **/50** | **/50** | **/50** |

### Winner
🏆 **[Model Name]** — One-sentence justification.

### Key Differences
- Difference 1
- Difference 2

### Recommended Final Implementation
Which implementation to keep, or how to merge the best parts of each. Apply the winning (or merged) implementation to the workspace.
```
