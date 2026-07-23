# Lifecycle Hook Architecture

Lifecycle hooks are a provider-neutral harness feature. Provider adapters continue to translate messages and tools only; hook discovery, trust, execution, and decisions live above them.

## Components

- `src/hooks/config.js` discovers only Cusco user and working-directory JSON files, validates event groups and regular-expression matchers, and fingerprints normalized handlers.
- `src/hooks/auditStore.js` keeps a bounded private record of hook event, source, timing, exit, timeout, cancellation, and error metadata without storing prompt or tool payloads.
- `src/hooks/trustStore.js` persists trusted and disabled fingerprints in a private atomic JSON file.
- `src/hooks/runner.js` launches command hooks asynchronously with JSON stdin, working-directory control, cancellation, timeouts, bounded capture, and private oversized-output files.
- `src/hooks/protocol.js` validates event outputs and combines concurrent results with deterministic denial and continuation rules.
- `src/hooks/manager.js` snapshots discovered definitions for each dispatch, skips untrusted or disabled commands, launches all matching commands concurrently, and retains bounded last-run metadata for Settings.
- `src/settings/hooksSettings.js` provides the global switch, per-chat working-directory selector, source diagnostics, definition review, trust revocation, disable controls, and last-run status.

## Runtime order

The turn path is:

1. Lazily run `SessionStart` once for the conversation and selected working directory.
2. Run `UserPromptSubmit` before consuming attachments, storing the message, or proposing memory.
3. Run `PreCompact` and `PostCompact` around automatic context compaction.
4. Assemble base instructions, session hook context, turn hook context, skills, artifacts, and conversation messages.
5. For local tools, run `PreToolUse`, apply and revalidate an allowed rewrite, apply Cusco's permission policy, run `PermissionRequest` if a native approval is pending, execute, then run `PostToolUse`.
6. Run `Stop` after the assistant candidate. A continuation is rechecked with `UserPromptSubmit`, preserves the completed assistant pass, and starts another provider pass. Cusco permits at most three continuations.

Slash tools and Agent Mode share the same hook authorization helpers. Agent runtime messages receive new pre/post-tool context directly because their provider-message list already exists when the tool hook runs. The visible transcript keeps the actual tool outcome even when a post-tool hook replaces the model-facing feedback.

## Security boundaries

- Discovery never reads `.codex` files and never treats the process directory as an implicit project source.
- Workspace discovery requires an explicit absolute working directory stored on the conversation.
- Every executable definition requires exact fingerprint trust; definition changes are skipped.
- Hooks use the existing turn cancellable and never block the GTK main loop.
- Hook commands run with the user's desktop privileges. Trust is an execution-consent boundary, not an operating-system sandbox.
- `transcript_path` remains `null`; Cusco's private conversation database is not a stable hook interface.
- Provider-hosted search and other remote provider tools do not cross the local tool execution seam.
- Hook notices and failures are inspectable without replacing the original transcript audit of a side effect that already occurred.
