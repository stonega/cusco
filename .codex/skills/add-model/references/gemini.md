# Google Gemini model reference

Read this reference for any change to the built-in `gemini` provider. It
captures the stable integration shape, not a model-version snapshot. Re-check
the requested model's official page every time because lifecycle, model IDs,
token limits, modalities, thinking levels, and API compatibility vary across
Gemini releases.

## Cusco integration profile

| Property | Current integration |
| --- | --- |
| Cusco provider ID | `gemini` |
| Provider | Google |
| Base URL | `https://generativelanguage.googleapis.com/v1beta` |
| API key environment variable | `GEMINI_API_KEY` |
| Chat adapter | `gemini-generate-content` |
| Image adapter | `gemini-interactions` |
| Native tools | `google_search`, `url_context` |

Cusco's Gemini chat adapter already handles multimodal inline data, client
function tools, Google Search, URL Context, citations, streaming, thought
summaries, thought signatures, and function-call IDs. A new Gemini release is
usually a catalog/capability change when it still supports `generateContent`.
Do not assume compatibility merely because an announcement demonstrates the
Interactions API; confirm `generateContent` support before reusing the adapter.

For every requested Gemini model, verify:

- canonical model code and whether it is stable, preview, latest, or dated;
- exact input and output token limits and supported data types;
- exact thinking levels, the default, whether `minimal` or `off` is rejected,
  and whether omission has provider-defined behavior;
- function calling, Search grounding, URL Context, structured output, code
  execution, caching, and model-specific tool-combination limits;
- migration requirements such as removed sampling parameters, prefilled model
  turns, thought-signature preservation, or function-response IDs.

Represent only documented thinking choices in the model metadata. `Auto` is a
Cusco/provider-default choice and should appear only when omitting the explicit
thinking level is intentional for that model. Keep a valid persisted selection
on an older supported Gemini model; migrate only aliases or retired IDs.

## Official documentation entry points

- Model catalog: https://ai.google.dev/gemini-api/docs/models
- Latest model guide: https://ai.google.dev/gemini-api/docs/latest-model
- Generate content API:
  https://ai.google.dev/api/generate-content
- Thinking: https://ai.google.dev/gemini-api/docs/thinking
- Function calling: https://ai.google.dev/gemini-api/docs/function-calling
- Google Search grounding:
  https://ai.google.dev/gemini-api/docs/google-search
- URL Context:
  https://ai.google.dev/gemini-api/docs/generate-content/url-context
- Tool combinations:
  https://ai.google.dev/gemini-api/docs/generate-content/tool-combination
- Interactions API: https://ai.google.dev/gemini-api/docs/interactions

When the user supplies a model-specific page or announcement, treat it as the
primary source for that model and retain its URL in
`docs/user/provider-models.md`.
