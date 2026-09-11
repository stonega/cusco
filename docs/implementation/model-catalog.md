# JSON model catalog and GitHub updates

Cusco manages its default chat and image model lists in
`data/model-catalog.v1.json`. The app loads a compatible local snapshot immediately
and checks the same file on `stonega/cusco`'s `main` branch in the background.

## Components

| Component | Responsibility |
| --- | --- |
| `data/model-catalog.v1.json` | Ordered models, defaults, aliases, exclusions, limits, reasoning, capabilities, parameters, and source metadata |
| `data/model-catalog.schema.json` | Bundled structural contract; never replaced by a network response |
| `packages/modelCatalog/validation.js` | Schema vocabulary, semantic constraints, compatibility, and revision/retirement validation |
| `packages/modelCatalog/snapshot.js` | Immutable catalog records, inherited defaults, canonical IDs, and discovery eligibility |
| `packages/modelCatalog/parameters.js` | Typed parameter validation and code-owned wire mappings |
| `packages/modelCatalog/service.js` | Shared refresh operation, local recovery, update scheduling, and notifications |
| `packages/modelCatalog/io.js` | Bounded asynchronous HTTP reads and atomic local persistence |
| `src/providers/catalog.js` | Source/installed/GResource lookup and the application's shared service |
| `src/providers/providerDefinitions.js` | Application-owned endpoints, transport formats, and authentication definitions |
| `src/providers/config.js` | User settings, discovery facts, model resolution, and per-turn snapshots |

See [the package documentation](../../packages/modelCatalog/README.md) for the
field coverage table and instructions for publishing catalog changes.

## Runtime flow

1. Module loading reads the bundled JSON/schema without network access. The
   service constructor validates local cache candidates and selects the newest
   compatible revision, falling back to the bundle.
2. Application startup schedules a check after at least five seconds, when due.
   Automatic checks run daily while Cusco is open. Settings offers an opt-out,
   manual refresh, revision, last successful check, and error status.
3. The downloader uses GitHub's public Contents endpoint, raw media type, and
   `If-None-Match`. It sends no provider credentials or conversation data.
   See [GitHub repository contents](https://docs.github.com/en/rest/repos/contents#get-repository-content).
4. A request has a 15-second overall deadline, a 1 MiB limit enforced during reads,
   and at most three redirects restricted to approved GitHub HTTPS hosts. Invalid
   payloads, incompatible adapters/schema versions, and old revisions are rejected.
5. Accepted JSON, ETag, and acceptance time are committed together before the new
   snapshot is announced. The prior accepted entry remains available for recovery.
   A missing/corrupt cache triggers an unconditional download instead of trusting
   a response without a body.
6. Errors retain the active snapshot and persist retry state. Backoff respects
   server retry headers, including manual refreshes during a rate limit. See
   [GitHub conditional-request and rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
7. Settings and chat pickers refresh through subscriptions. Shutdown cancels the
   request and timer; imports, constructors, and opening settings do not fetch.

## Data ownership and migration

Catalog records completely own built-in model metadata. Legacy persisted
reasoning or other resolved fields cannot override a corrected catalog or restore
fields removed upstream. Discovery preserves catalog models and adds eligible
extra IDs for providers with open discovery. Exclusions and retirement records
prevent removed models from returning through discovery.

Custom APIs, endpoints, credentials, enabled state, and valid explicit defaults
remain user-owned. New recommended defaults apply when no explicit default is
saved. The legacy format did not distinguish automatically persisted defaults
from explicit choices, so valid legacy defaults are conservatively preserved.

Canonical aliases and declared replacements resolve saved IDs. Chat requests
for removed models without replacements fail before HTTP with a visible message
asking for a new selection; this error does not trigger provider fallback.
Historical message IDs are not rewritten.

A shared cancellable identifies an agent turn. The provider store snapshots its
models and selections at turn start; tool calls, continuations, image generation,
and fallback requests use that same snapshot. Provider object identity remains
stable for credential and settings operations that are awaiting I/O.

## Parameter contract

All pre-migration provider/model fields are covered by an independent migration
fixture, including provider-inherited reasoning, native search, image rules, and
streaming flags. The schema also represents modalities, attachment limits,
structured output, sampling controls, image generation controls, and additional
typed provider parameters. These fields survive catalog loading and replacement.

Parameters distinguish API support from implemented request mappings. Unsupported
or unknown controls are not sent. Known runtime controls validate defaults and
explicit choices, ranges, allowed values, and reasoning-mode restrictions before
mapping to the provider's wire format. Metadata-only capabilities do not enable
new protocols or add a generic advanced-parameter UI.

The initial migration preserves existing model facts and marks previously
unrecorded parameters unknown. It does not claim a fresh audit of every provider
API. Undocumented numeric limits stay omitted in JSON; Cusco's fallback output
budget remains application policy. New protocols and authentication behavior
require an app release rather than a catalog update.

## Validation and publication

Run `scripts/check.sh` for catalog, provider, UI, HTTP, import, and build checks.
The catalog-specific suites are `model-catalog-smoke.js`,
`model-catalog-http-smoke.js`, `model-catalog-settings-smoke.js`, and
`model-catalog-resource-smoke.js`. CI also
validates the revision against the previous repository version and runs the
catalog settings test with a virtual display.

The JSON must be committed and published at the configured GitHub path before
network refresh can retrieve it. This implementation does not install Cusco or
publish repository changes. Once published, future compatible catalog revisions
reach clients without rebuilding the application.
