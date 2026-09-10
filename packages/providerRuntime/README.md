# Provider runtime

Provider-neutral chat message types, request limits, thinking and usage
normalization, plus the GJS HTTP adapters for OpenAI, Anthropic, Gemini, and
OpenAI-compatible services.

Application provider catalogs, settings, secrets, icons, and image-generation
tool integration remain in `src/providers/`.

OpenAI subscription streams can deliver output items before a terminal response
whose `output` array is empty. The adapter retains those items and requires a
terminal response before returning tool calls. OpenAI response items travel in
a provider-scoped `openai_response` envelope through `providerParts`, preserving
encrypted reasoning, message phases, and call IDs for stateless tool follow-ups.
Saved messages use `metadata.providerParts`; legacy Gemini context remains
readable from `metadata.geminiProviderParts`. Context is not replayed across
providers or models, over edited answers, or as orphaned tool calls.
