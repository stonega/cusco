---
name: add-model
description: Add, upgrade, replace, or retire AI models and provider catalog entries in Cusco. Use whenever a user asks to support any model, change a provider's default model, update model capabilities or token limits, add reasoning levels, migrate model IDs, or integrate an OpenAI, Anthropic, Gemini, Kimi, DeepSeek, Grok/xAI, Z.ai, or compatible model—even when the request only names a provider and model.
metadata:
  short-description: Add production-ready model support to Cusco
---

# Add a Model to Cusco

Treat model support as a product contract spanning official API facts, Cusco's
catalog and request adapter, persisted selections, tests, and user-facing docs.
A picker entry alone is incomplete if its capabilities or wire format are
wrong.

## 1. Establish the current state

1. Read the repository instructions and inspect the dirty worktree. Preserve
   existing changes, especially when they touch provider files.
2. Use CodeGraph for symbols and relationships before reading targeted source
   ranges. The main catalog lives in `src/providers/config.js`; transport and
   response normalization live in `packages/providerRuntime/remoteProvider.js`.
3. Identify whether the request is:
   - a catalog-only addition to an existing provider;
   - an existing provider that needs new request or stream behavior;
   - a new provider and credential/endpoint integration; or
   - a model replacement or retirement that needs persisted-state migration.

## 2. Research before editing

Use primary, current documentation. Record these facts explicitly:

- canonical API model ID and any useful legacy/user-entered aliases;
- API format, base URL, auth environment variable, and endpoint path;
- context window and documented output limit;
- text, image, audio, and file input/output modalities;
- reasoning controls, exact accepted values, default, and whether reasoning can
  be disabled;
- function calling, native search, citations, streaming, structured output,
  and provider-specific request fields;
- deprecations or migration behavior affecting existing selections.

Do not infer a capability from the model's marketing description. When a limit
is undocumented or explicitly unlimited, omit the metadata field instead of
inventing a number. Keep source URLs in the user documentation.

For Grok or xAI work, read [references/grok.md](references/grok.md) before
editing. It describes Cusco's provider integration and the official entry
points to re-check for whichever Grok model the user requests.

For Gemini work, read [references/gemini.md](references/gemini.md) before
editing. It separates Cusco's stable Google integration from model-specific
capabilities that must be verified for every Gemini release.

## 3. Implement the smallest complete change

For an existing provider, update the relevant parts of
`src/providers/config.js`:

- `PROVIDER_MODEL_ID_ALIASES` when users or persisted state may use another ID;
- `PROVIDER_SUPPORTED_MODEL_IDS` so stale discovery cannot reintroduce removed
  models;
- the provider's model metadata (`id`, display name, description, context,
  output limit when documented, and `thinking`);
- `PROVIDER_MODEL_CONTEXT_WINDOW_TOKENS` when discovery must be enriched;
- `DEFAULT_PROVIDER_CONFIGS` ordering and `defaultModelId`.

Model order is picker order. Put the current recommended model first, retain
older supported models deliberately, and do not silently change a user's valid
persisted selection merely because the built-in default changed.

Only change `packages/providerRuntime/remoteProvider.js` when official docs show
that the existing adapter cannot express the model's request or stream format.
Reuse existing formats and capability metadata where possible. Provider quirks
belong behind the provider interface, not in GTK views.

## 4. Cover behavior, not just constants

Update focused smoke coverage as applicable:

- `tests/provider-config-smoke.js`: canonical/alias resolution, supported model
  ordering, default, token limits, reasoning levels/defaults, and stale state;
- `tests/chat-management-smoke.js`: provider catalog presented to chat;
- `tests/remote-provider-adapters-smoke.js`: request fields, modalities,
  reasoning, tools, and response normalization;
- `tests/remote-provider-http-smoke.js`: end-to-end streaming only when the
  endpoint or transport behavior changes;
- settings/UI tests only when configuration or picker behavior changes beyond
  the catalog data.

Then update `docs/user/provider-models.md` and add a concise entry under the
correct `CHANGELOG.md` Unreleased heading. Documentation must state actual IDs,
defaults, limits, reasoning choices, and official sources.

## 5. Verify and hand off

Run the focused checks first, followed by the project import smoke:

```sh
gjs -m tests/provider-config-smoke.js
gjs -m tests/chat-management-smoke.js
gjs -m tests/remote-provider-adapters-smoke.js
gjs -m tests/remote-provider-http-smoke.js  # when transport changed
gjs -m tests/import-smoke.js
```

Also run `git diff --check` and review the final diff against the official
facts. Report what changed, the authoritative sources, and exactly which tests
passed. Do not install Cusco unless the user explicitly requests installation.
