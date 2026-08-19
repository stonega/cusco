# Grok / xAI model reference

Read this reference for any change to the built-in `grok` provider. It captures
the stable integration shape, not a model-version snapshot. Re-check the
official model page every time because IDs, token limits, modalities,
reasoning controls, and tool support can differ between Grok releases.

## Cusco integration profile

| Property | Current integration |
| --- | --- |
| Cusco provider ID | `grok` |
| Provider | xAI |
| Base URL | `https://api.x.ai/v1` |
| API key environment variable | `XAI_API_KEY` |
| Chat adapter | `openai-responses` |
| Image adapter | `openai-images` |
| Native search tools | `web_search`, `x_search` |

Cusco's xAI provider already supplies Responses requests, image attachments,
client function tools, native Web/X search, citations, streaming, and
`reasoning.effort`. A new Grok release is usually a catalog/capability change.
Change the transport only when the requested model's official docs prove that
the existing adapter cannot express its contract.

For every requested Grok model, verify its canonical ID, context and output
limits, input modalities, reasoning values and default, supported APIs, tools,
and any caching or compaction guidance. Do not copy capability metadata from a
different Grok version merely because the names are similar.

Provider guidance such as `prompt_cache_key` or `x-grok-conv-id` is a transport
feature, not model metadata. Add it only with a stable conversation-scoped
value and focused request tests.

## Official documentation entry points

- Model catalog: https://docs.x.ai/developers/models
- Responses and Chat Completions reference:
  https://docs.x.ai/developers/rest-api-reference/inference/chat
- Reasoning controls:
  https://docs.x.ai/developers/model-capabilities/text/reasoning
- Function calling: https://docs.x.ai/developers/tools/function-calling
- Web Search: https://docs.x.ai/developers/tools/web-search
- X Search: https://docs.x.ai/developers/tools/x-search
- Image generation:
  https://docs.x.ai/developers/rest-api-reference/inference/images

When the user supplies a model-specific guide or announcement, treat it as the
primary source for that model and retain its URL in
`docs/user/provider-models.md`.
