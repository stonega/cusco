# OpenAI and DeepSeek Responses API plan

Research date: 2026-08-18

This document records the API findings, the current Cusco baseline, and the
implementation sequence for running both OpenAI and DeepSeek through the
Responses API. It is a plan; it does not describe work that is already
implemented unless the current-state section says so.

## Recommendation

Keep `OpenAiResponsesProvider` as the shared transport and make its request,
history, and response handling capability-driven. OpenAI already uses this
provider. DeepSeek should move from `OpenAiCompatibleChatProvider` to the same
Responses provider after the shared adapter handles DeepSeek's stateless,
text-only compatibility profile.

Cusco should own conversation state for both providers:

- send `store: false` to OpenAI;
- omit unsupported state parameters for DeepSeek;
- never depend on `previous_response_id` or the Conversations API; and
- persist and replay the provider output Items required for reasoning, tool
  calls, and server-side search alongside Cusco's canonical transcript.

This gives both providers one local-first state model, avoids remote response
IDs becoming part of Cusco's conversation format, and remains compatible with
DeepSeek's always-stateless endpoint.

## Verified API behavior

| Concern | OpenAI | DeepSeek | Cusco consequence |
|---|---|---|---|
| Endpoint | `POST https://api.openai.com/v1/responses` | `POST https://api.deepseek.com/responses` | The existing URL normalization and bearer authentication can serve both. |
| Supported models | Current OpenAI Responses-capable models | `deepseek-v4-flash` and `deepseek-v4-pro` | Both built-in DeepSeek models can change wire format together. |
| State | Responses are stored by default; `store: false`, `previous_response_id`, and Conversations are supported | Always stateless; `store`, `previous_response_id`, and `conversation` are unsupported | Use client-owned history and make OpenAI storage opt-out explicit. |
| Multi-turn input | A string or typed input Items; when stateless, replay every prior output Item | A string or typed input Items; full history is required on every request | Preserve typed Items rather than rebuilding only text messages. |
| Streaming | Typed SSE such as `response.output_text.delta`, reasoning deltas, and terminal response events | The same event family, including `response.reasoning_text.delta`; no `[DONE]` marker | The existing Responses stream state is reusable, with provider fixtures for both variants. |
| Reasoning | `reasoning.effort`, summaries, encrypted reasoning Items in stateless mode, and reasoning context controls | `reasoning.effort`; summary is accepted but no summary is generated; final reasoning is in `reasoning.content[]` | Request only supported fields and extract both summaries and content. |
| Function tools | Responses-style `function` tools and `function_call` / `function_call_output` Items | The same core shapes are supported; parallel calling is always enabled | Cusco's current Responses function schema and `call_id` mapping can be shared. |
| Hosted tools | OpenAI web search and other built-in tools | `web_search` is supported; file search, code interpreter, computer use, MCP, and most other hosted tools are ignored | Advertise only tools declared by each provider's capability profile. |
| Image and file input | Supported by applicable models | Not supported; image parts are silently replaced by placeholder text | Preserve `supportsImageAttachments: false` when DeepSeek changes transport. |
| Unsupported fields | Validated according to the OpenAI schema | Many unsupported fields are silently ignored | Body-shape tests are required; a successful request does not prove a control took effect. |
| Context overflow | Supports API context controls depending on model and request | `truncation` is unsupported and overflow returns HTTP 400 | Keep compaction and capacity decisions in Cusco and provide a clear overflow error. |

Sources:

- OpenAI, [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- OpenAI, [Preserve reasoning without stored responses](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)
- DeepSeek, [Using the Responses API](https://api-docs.deepseek.com/guides/responses_api)
- DeepSeek, [Responses API reference](https://api-docs.deepseek.com/api/create-response)
- DeepSeek, [Codex integration and current model capabilities](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)

## Current Cusco baseline

Cusco is not starting from zero:

- `packages/providerRuntime/remoteProvider.js` already contains
  `OpenAiResponsesProvider`, `buildOpenAiResponsesBody`, typed SSE handling,
  Responses output extraction, usage normalization, function calls, and native
  search parsing.
- `src/providers/config.js` already routes OpenAI and Grok through
  `apiFormat: 'openai-responses'`.
- DeepSeek currently uses `apiFormat: 'openai-chat-completions'`,
  `/chat/completions`, and a Chat Completions-specific `thinking` object.
- Cusco already sends its locally stored transcript on every Responses request,
  which is the right top-level state strategy for DeepSeek.
- Adapter and HTTP smoke tests already cover the OpenAI Responses request,
  reasoning-summary delta, output text deltas, usage, tool calls, incomplete
  output, and terminal response handling.

The current adapter still has migration gaps:

1. `openAiMessages()` always serializes supported image attachments. Merely
   changing DeepSeek's `apiFormat` would bypass its current text-only guard.
2. DeepSeek's current thinking metadata builds a Chat Completions `thinking`
   object, while `/responses` expects `reasoning.effort`.
3. `extractOpenAiReasoning()` reads OpenAI summaries but not DeepSeek's
   `reasoning.content[]` text.
4. Cusco reconstructs prior text and function Items but does not preserve every
   returned output Item. That loses encrypted OpenAI reasoning state and
   DeepSeek reasoning or hosted-search context between turns.
5. OpenAI requests do not currently make the storage decision explicit, so the
   provider's default storage behavior applies.
6. DeepSeek has no Responses-specific HTTP fixture, body assertions, or
   restart-and-replay coverage.

## Target design

### Provider capabilities

Add a small Responses capability block to provider configuration instead of
branching on provider IDs inside the adapter. It should describe wire-level
differences that are not already represented by existing fields such as
`supportsImageAttachments` and `nativeSearch`.

The provider/model capability metadata needs to express at least:

- state mode: client-owned or provider-chainable;
- whether `store: false` is supported and should be sent;
- whether reasoning summary and reasoning context controls are supported by
  the selected model;
- which response output Item types may be replayed;
- which hosted tool types are supported; and
- whether request fields unsupported by that provider must be omitted.

OpenAI's profile should use client-owned state, explicitly send `store: false`,
preserve all replayable output Items, and allow reasoning summaries/context.
DeepSeek's profile should use client-owned state, omit all state fields, disable
reasoning summaries/context, keep image input disabled, and restrict hosted
tools to `web_search`.

Model metadata should also be checked against the current DeepSeek catalog.
The current official integration metadata exposes `low`, `high`, and `max`
reasoning with `high` as the default for both V4 models. Cusco should update the
picker only after a direct request test confirms whether the Responses endpoint
also accepts a true no-reasoning mode; do not keep `Off` or `Auto` based only on
the old Chat Completions contract.

### Client-owned history

Keep Cusco's normalized messages as the canonical, provider-portable record,
but attach a bounded, validated copy of the exact Responses `output` Items to
the assistant turn that produced them.

Each stored Item group should be tagged with its provider and model. Replay the
exact Items only when the next request uses a compatible Responses provider;
otherwise fall back to the portable user/assistant/tool transcript. This avoids
sending OpenAI encrypted reasoning blobs to DeepSeek or DeepSeek plain
reasoning Items to OpenAI after a provider switch.

Preserving all output Items is important for two flows:

- OpenAI `store: false` responses return encrypted reasoning Items that must be
  replayed to retain reasoning state across turns.
- DeepSeek requires the full local history and accepts reasoning,
  `function_call`, `function_call_output`, and `web_search_call` Items.

The persisted representation must be JSON-only, size-bounded, and schema
checked. Unknown Item types should remain in the portable transcript but should
not be replayed until explicitly supported. Do not persist bearer tokens,
request headers, or full HTTP envelopes.

### Request building

Refactor `buildOpenAiResponsesBody()` and `openAiMessages()` so they receive the
provider capability profile and produce a provider-valid body:

1. Build `input` from the canonical transcript. When an assistant turn has
   compatible stored output Items, replay those Items in place of that turn's
   reconstructed assistant text and function calls so content is not
   duplicated. Fall back to reconstruction when the Items are absent or
   incompatible.
2. Respect `supportsImageAttachments` for ordinary messages and tool-result
   screenshots.
3. Use `reasoning.effort` for both providers, but add `summary` or `context`
   only when supported.
4. Send `store: false` to OpenAI and omit `store`, `previous_response_id`, and
   `conversation` for DeepSeek.
5. Keep `max_output_tokens`, function tool definitions, and `tool_choice` in
   the shared builder.
6. Filter hosted tools through provider capability metadata. Do not rely on
   DeepSeek silently ignoring unsupported tools.
7. Keep the current local compaction path; do not send DeepSeek's unsupported
   `truncation` field.

### Response and stream handling

Extend the shared Responses extractor rather than create a DeepSeek parser:

- final text comes from `output_text` or `message.content[].output_text`;
- visible reasoning prefers summary text when present, then falls back to
  `reasoning.content[].reasoning_text`;
- streaming accepts both `response.reasoning_summary_text.delta` and
  `response.reasoning_text.delta`;
- `response.completed`, `response.incomplete`, and `response.failed` are the
  only terminal events required—`[DONE]` must not be required;
- usage continues to normalize input, cached input, output, reasoning, and
  total tokens; and
- the final response returns sanitized replay Items to the chat layer in
  addition to text, reasoning, usage, tools, and hosted-search results.

The normal chat stream and the Agent Mode tool loop must both retain those
Items. In-flight function-call turns need them before the next tool-result
request; final assistant turns need them written to conversation storage so a
restart does not alter the next request.

### DeepSeek native web search

Do the transport migration before enabling hosted search. Keep Cusco's current
client-side `search` tool during the first integration stage so text,
reasoning, and function calls can be compared without another behavior change.

After the base migration is stable, add DeepSeek `nativeSearch` metadata with
only `web_search`. Do not request OpenAI's `include` source expansion because
DeepSeek does not support `include`; derive visible sources from the returned
`web_search_call.action.sources` and text annotations. Keep the client-side
search tool as a fallback when native search is unavailable or disabled.

## Implementation sequence

### 1. Freeze the shared contract with tests

Before changing provider selection, extend
`tests/remote-provider-adapters-smoke.js` with separate OpenAI and DeepSeek
request snapshots. Assert the presence and absence of state, reasoning,
summary, image, hosted-tool, and unsupported fields. Add final-response fixtures
for OpenAI encrypted reasoning Items and DeepSeek plain reasoning content.

This stage prevents DeepSeek's silent-ignore behavior from hiding incorrect
requests.

### 2. Add provider-aware Responses capabilities

Update `src/providers/config.js` with explicit Responses capability metadata.
Keep OpenAI on `openai-responses`; do not switch DeepSeek yet. Refactor the
request helper in `packages/providerRuntime/remoteProvider.js` to consume those
capabilities, while retaining current behavior for OpenAI and Grok.

Update `tests/provider-config-smoke.js` to cover the capability profiles and
the verified DeepSeek reasoning levels/default.

### 3. Preserve and replay response Items

Carry sanitized output Items through:

- `packages/providerRuntime/remoteProvider.js` response normalization;
- `src/chat/providerStream.js` stream aggregation;
- `src/chat/streamingAssistantView.js` normal chat persistence;
- `src/chat/agentRuntime.js` in-flight tool-call history; and
- `src/chat/conversation.js` plus `src/storage/conversationStore.js` validation
  and reload.

Add a storage test that writes, reloads, and replays an assistant turn with
encrypted reasoning, a function call, and a server-side search Item. Add a
provider-switch test proving incompatible raw Items are omitted while the
portable transcript remains intact.

### 4. Harden shared Responses streaming and extraction

Teach the final reasoning extractor to support both summary and content shapes.
Retain output Items from `response.output_item.done` and the terminal response,
including cases where network chunk boundaries split UTF-8 or SSE records.
Verify failed and incomplete terminal responses, cancellation, usage delivery,
parallel function calls, and a stream that ends without `[DONE]`.

### 5. Switch DeepSeek to Responses

Change the built-in DeepSeek configuration to:

- `apiFormat: 'openai-responses'`;
- the shared `/responses` path;
- the verified Responses reasoning metadata; and
- text-only input.

Remove Chat Completions-only options such as `supportsStreamUsageOptions` and
the DeepSeek `thinking` request shape once no built-in DeepSeek flow uses them.
Do not remove `OpenAiCompatibleChatProvider`; Kimi, Z.ai, and custom providers
still need it.

Do not automatically retry a failed Responses request through Chat Completions:
an ambiguous network failure could duplicate a billed or tool-producing turn.
A rollback should be a deliberate provider-configuration change.

### 6. Enable DeepSeek hosted search

Add the `web_search` capability and verify source extraction, transcript tool
activity, follow-up history, and the client-side search fallback. Keep all
other DeepSeek hosted tool types disabled.

### 7. Finish user-facing and release work

Update `docs/user/provider-models.md` to state that OpenAI and DeepSeek use the
Responses API, document DeepSeek's text-only limitation and current reasoning
levels, and mention native search if stage 6 ships.

Because changing DeepSeek's transport and capabilities is user-visible, add a
concise `CHANGELOG.md` entry under `## [Unreleased]` when the implementation is
committed. No settings or secret migration should be necessary; provider IDs,
API keys, model IDs, and base URLs remain stable.

## Validation matrix

The implementation is complete only when all of these pass for both OpenAI and
DeepSeek where the provider supports the feature:

- streaming and non-streaming text;
- reasoning request shape, live reasoning, final extraction, persistence, and
  next-turn replay;
- a normal multi-turn conversation after an application restart;
- one and multiple function calls with matching `call_id` results;
- incomplete, malformed, and output-limited function calls;
- usage including cached and reasoning tokens;
- cancellation, provider errors, incomplete responses, and streams without a
  `[DONE]` marker;
- DeepSeek requests never containing image data, including tool screenshots;
- OpenAI requests always using `store: false` and replaying encrypted reasoning
  Items;
- provider switching without cross-provider raw Item leakage;
- DeepSeek context overflow producing a clear, actionable error; and
- hosted search plus source extraction after the separate search stage lands.

Run at least:

```sh
gjs -m tests/remote-provider-adapters-smoke.js
gjs -m tests/remote-provider-http-smoke.js
gjs -m tests/provider-config-smoke.js
gjs -m tests/conversation-store-smoke.js
gjs -m tests/agent-mode-smoke.js
gjs -m tests/usage-smoke.js
gjs -m tests/import-smoke.js
```

Add opt-in live smoke checks using user-supplied OpenAI and DeepSeek keys. They
should cover one text turn, one reasoning turn, one function-call round trip,
and one two-turn restart/replay flow. Never put those keys in fixtures, logs,
or the repository.

## Delivery checkpoints

1. Shared adapter refactor passes existing OpenAI and Grok tests with no
   provider configuration change.
2. Stateless Item persistence and replay pass synthetic restart tests.
3. DeepSeek Responses fixtures pass while DeepSeek is still configured for
   Chat Completions.
4. DeepSeek switches to Responses and all offline checks pass.
5. Opt-in live checks confirm both providers before the changelog and user
   documentation are finalized.
6. DeepSeek hosted search ships only after the base transport checkpoint is
   stable.
