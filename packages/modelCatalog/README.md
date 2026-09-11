# Model catalog

`data/model-catalog.v1.json` manages all default chat and image models. Its bundled
JSON Schema is the structural validation contract. `validation.js` implements
only the schema vocabulary used here and adds semantic validation; use the same
validator in the application and CI. Unknown catalog keys are errors.

`src/providers/catalog.js` handles source/installed/resource lookup and the
application's shared service. Provider transport origins and authentication live
in `src/providers/providerDefinitions.js` and cannot change through this feed.

## Editing the catalog

1. Verify the canonical model ID, capabilities, limits, and accepted parameters
   against official provider documentation. Add source URLs and `verifiedAt`
   when verifying a record. The initial records preserve the existing catalog;
   their migration notes explicitly distinguish this from a fresh API audit.
2. Edit models in picker order. Provider `modelDefaults` and `imageModelDefaults`
   supply shared metadata. An individual model overrides those defaults. Parameter
   maps merge by name; each descriptor and each array replaces its inherited value.
   `thinking: false` and `nativeSearch: false` explicitly disable inheritance.
3. Update defaults and aliases deliberately. Aliases point directly to available
   canonical records. To remove a record, retain it as `status: "retired"` or
   add its ID to the corresponding exclusion list; a replacement alias is also
   allowed. Exclusions prevent open discovery from resurrecting removed models.
4. Increase `revision` for every content change. Roll back by publishing the prior
   data with a higher revision. Retain exclusions and aliases needed by old clients.
5. Run `gjs -m scripts/validate-model-catalog.js` and
   `gjs -m tests/model-catalog-smoke.js`, then relevant provider smoke checks.
   Pass a previous catalog file to the validator to check upgrade rules.

Default JSON is bundled in source and installed builds. An update can change data
under existing adapter semantics. New reasoning APIs, wire fields, authentication,
or endpoint routing require an application release and appropriate compatibility
requirements. The app never downloads replacement JavaScript or a remote schema.

## Parameters and coverage

Every existing field is preserved by the migration fixture in
`tests/fixtures/model-catalog-baseline.json`. Additional metadata is retained
through resolution and store updates rather than reconstructed from a small
field allowlist. These are the catalog-to-runtime boundaries:

| JSON metadata | Consumer / behavior |
| --- | --- |
| IDs, names, description, defaults, aliases, status, exclusions | Catalog snapshot and provider store; picker order, saved selection resolution, discovery filtering |
| `contextWindowTokens`, `maxInputTokens`, `maxOutputTokens`, `requestDefaults.maxOutputTokens` | Provider output budgeting; documented maximum remains separate from app request default/fallback |
| Every `thinking` property | Existing reasoning resolver and request adapters; preserves levels, budgets, always-on, summary/display, thought inclusion, keep, off effort, token field |
| `nativeSearch` | Existing provider tool configuration, search tools, versions, source inclusion, counts |
| `supportsImageAttachments`, `supportedImageMimeTypes` | Existing attachment delivery rules |
| `supportsStreamUsageOptions`, `supportsToolStreaming`, `supportsReasoningContentItems` | Usage streaming, tool streaming, and replayed reasoning; supports model overrides |
| `supportsFunctionCalling`, `supportsStreaming` | Request capability validation |
| `parameters` | Typed descriptors, runtime defaults and explicit request choices via `options.parameters`; mappings are in `parameters.js` |
| `modalities`, `attachmentLimits`, `capabilities`, provenance | Descriptive model facts retained in full; only existing runtime integrations imply operational support |

A descriptor contains `support` (`supported`, `unsupported`, `unknown`), `type`,
and `runtime` (whether this Cusco adapter can send it). Optional keys include
`default`, `minimum`, `maximum`, `allowedValues`, `maxItems`,
`onlyWithoutThinking`, `sources`, and `notes`. Unknown support has no default.
For example, a verified optional temperature control can use:

```json
{
  "support": "supported",
  "type": "number",
  "runtime": true,
  "minimum": 0,
  "maximum": 1,
  "default": 0.4,
  "onlyWithoutThinking": true
}
```

This example is illustrative, not a limit asserted for every model. The initial
catalog marks previously unrecorded sampling controls unknown and does not start
sending new parameters. Provider-specific fields not implemented by the runtime
can be documented with `runtime: false`; attempts to send them fail explicitly.
There is no generic settings editor for newly described API controls.

## Update lifecycle

`CatalogService` has injected storage, HTTP, clock, and randomness for tests. Its
constructor only reads local files. `start()` schedules checks after startup;
`stop()` cancels scheduling and the current request. One refresh promise is shared
by all windows. Subscribers receive status and an explicit snapshot-change flag.

Downloads use the public GitHub Contents endpoint with conditional ETags, bounded
GitHub HTTPS redirects, a 15-second overall deadline, and a 1 MiB limit enforced
while reading. No model API key, account token, or conversation data is attached.
Validation and an atomic cache write precede publishing a snapshot. The cache
stores the accepted payload/ETag together and keeps the previous accepted entry.
Failed updates retain the current snapshot and back off, respecting rate limits.

The cache is under `$XDG_CACHE_HOME/cusco/model-catalog/`. Automatic-update
preferences and retry state use `$XDG_CONFIG_HOME/cusco/catalog-updates.json`.
Removing the cache does not reset the automatic-update setting.

The store subscribes to the shared service and replaces built-in defaults while
retaining explicit user settings. `forRequest(cancellable)` holds model and
selection snapshots for an entire agent turn, including tool calls and fallback
requests. A removed model without a replacement raises `CUSCO_MODEL_UNAVAILABLE`
before network transmission and does not trigger provider fallback.
