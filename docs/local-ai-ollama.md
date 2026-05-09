# Local AI / Ollama Option

## Recommendation

Do not make Ollama a default dependency for Phase 2. Add it as an optional local assistant module.

Sales answers should come from SQLite and Commander data first. A local model can help with natural-language phrasing, offline Q&A over docs, or fallback explanations, but it should not be required for setup, sync, marketplace registration, or message routing.

## Smallest Practical Model

Use the smallest Ollama model only as an optional profile:

```text
OLLAMA_ENABLED=false
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=tinyllama
```

For better quality on stronger hardware, allow a larger model by configuration. Do not auto-download models during installation without an explicit user choice.

## Pros

- Local fallback when cloud AI is unavailable.
- Store data can stay local for simple natural-language summaries.
- Useful for support triage and explaining diagnostics without remote calls.
- Can reduce cloud cost for low-risk phrasing tasks.
- Good fit for local-first positioning.

## Cons

- Adds install size, download time, and support burden.
- CPU-only inference can be slow on older store PCs.
- Model quality may be weak for sales analytics unless prompts are tightly grounded in local data.
- Another service must be monitored, upgraded, and secured.
- Local models can hallucinate; SQL/SQLite facts must remain the source of truth.
- Some stores may not allow AI runtimes on POS/backoffice machines.

## Safe Integration Pattern

```text
message -> intent classifier -> local SQLite facts -> optional Ollama phrasing -> audited response
```

Rules:

- Never let Ollama directly write to Commander.
- Never use Ollama as the source of sales facts.
- Ground prompts with explicit local query results.
- Keep the feature disabled by default.
- Add health checks for Ollama only when enabled.

## Future API Shape

```http
GET /api/local-ai/status
POST /api/local-ai/summarize
```

The first implementation should only summarize already-computed local results.
