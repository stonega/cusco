# Chat turn boundaries still stalled after content appeared

Date: 2026-08-31

Affected release: Unreleased development builds after 0.5.41

## Summary

Cusco visibly acknowledged a newly submitted message and smoothly revealed streamed assistant text, but the window could still pause immediately after the user row appeared and again immediately after the final provider chunk became visible.

The network stream was not blocking. Both pauses happened at local lifecycle boundaries where Cusco concentrated synchronous persistence, list-model replacement, Markdown finalization, and transcript reconstruction on the GTK main thread. Earlier fixes had made the correct state visible before this work, which changed the failure from a feedback gap or content jump into a conspicuous post-paint stall.

## Impact

- A sent message appeared promptly but could be followed by a noticeable frozen frame before provider activity continued.
- The final assistant text could already be visible while scrolling, selection, and other window input briefly stopped responding.
- The completion pause grew with transcript length, Markdown complexity, artifact content, loaded sidebar rows, and storage latency.
- Repeated full sidebar replacement recreated visible rows and their menus even when only the active conversation's busy state or timestamp changed.
- Message data remained correct and provider streaming remained asynchronous. The defect was main-thread scheduling and redundant UI work.

## Root cause

The send boundary intentionally yielded once so GTK could paint the cleared composer, optimistic user row, and assistant activity. Immediately after that paint, `TurnSubmission` refreshed the conversation sidebar, ran preflight hooks, appended the durable user message, and persisted the conversation. Persistence normalized and serialized the full hydrated transcript, wrote a pending-index marker, atomically replaced the transcript record, rewrote the conversation index, and updated selection state through synchronous filesystem calls.

The sidebar refresh also replaced the complete `Gtk.StringList` contents with one `splice(0, length, ids)` call. Even when the IDs were unchanged, GTK unbound and rebound visible rows, recreating labels, busy indicators, hover controllers, popovers, and action buttons.

The completion boundary performed several more main-thread operations in sequence:

- materialize and attach final artifacts;
- synchronously persist the canonical assistant message;
- replace the complete sidebar model again;
- finish streaming and force a second complete Markdown render to change streaming/selectable state;
- after presentation settlement, call `renderActiveConversation({ forceRebuild: true })`;
- synchronously recreate the current transcript page, up to 32 message rows, in one main-loop callback.

The forced transcript rebuild had originally been introduced to replace a live streaming row with a canonical transcript row after presentation settlement. By this point the live row already contained the canonical text, reasoning, usage, duration, tool results, and actions. Rebuilding the entire page was no longer required for ordinary completion.

## Why tests missed it

Earlier regressions verified semantic ordering rather than frame cost:

- Send tests required the optimistic user row and assistant activity to exist before hooks and provider work, but did not constrain the amount of synchronous work immediately after the first paint.
- Presentation tests required the final rebuild to wait until the reveal tail settled. They encoded the rebuild itself as correct behavior instead of asserting that the live row could become canonical in place.
- Message-view tests verified final content and selectability, but not widget identity across `finishStreaming()`.
- Conversation-store tests expected mutations to be durable immediately and therefore exercised only synchronous persistence.
- Sidebar tests checked ordering, filtering, and selection, but did not inspect the size of list-model changes.

Each subsystem produced the correct final state, so correctness tests passed while the combined main-thread workload exceeded a smooth frame budget.

## Detection and diagnosis

The timing of the pauses was the primary clue. The first occurred after the optimistic row had painted but before provider work became observable. The second occurred after the last chunk was already visible. That made provider latency and chunk delivery unlikely causes and pointed to work scheduled directly after those presentation boundaries.

Tracing the send path showed an explicit presentation yield followed by sidebar refresh and synchronous persistence. Tracing stream completion showed persistence and sidebar refresh before `finish_stream()`, followed by both a message-level forced render and a transcript-level forced rebuild.

The completion rebuild was the most deterministic source of the second pause: it discarded the working message tree and synchronously recreated the current transcript page. The shared synchronous persistence path explained why both send and completion pauses grew with conversation size.

## Resolution

- Finalize the live assistant row in place after presentation settles. The transcript cache now adopts the conversation's current fingerprint instead of forcing a rebuild.
- If the live view cannot be adopted, use the existing incremental transcript renderer as the fallback rather than rebuilding all visible messages in one callback.
- Preserve Markdown block widgets when complete streamed Markdown is already canonical. Finalization changes selectability in place and only performs a canonical re-render when streaming stabilization actually changed incomplete Markdown syntax.
- Push finalized artifact metadata into the live message view so artifact presentation does not depend on a transcript rebuild.
- Replace full sidebar model resets with minimal prefix/suffix splices. Rows whose metadata changed are rebound individually using lightweight fingerprints.
- Add ordered asynchronous conversation persistence backed by `Gio.File.replace_contents_async`, retaining atomic replacement, private file permissions, pending-index recovery markers, and deletion ordering.
- Yield to a low-priority GLib turn before each persistence batch so the accepted send or completed response can paint first.
- Track per-conversation persistence versions so mutations arriving during an asynchronous write remain dirty and are written by a later batch instead of being incorrectly marked durable.
- Hold window close until the asynchronous persistence queue flushes, preserving the previous close-time durability guarantee.

A standalone provider or storage process was considered but was not introduced. Moving provider networking alone would not address GTK widget reconstruction, and GLib/Gio asynchronous writes remove the blocking filesystem work with substantially less lifecycle and IPC complexity. A separate long-lived worker remains an option if profiling shows that transcript normalization or `JSON.stringify` alone still exceeds the frame budget.

## Implementation pitfall

The first persistence-pump implementation exposed a re-entry race in its new smoke test. A batch resolved its waiters and finished its drain loop, but its promise `finally` had not yet cleared the active-pump reference. A continuation queued another write during that interval, observed a non-null pump, and did not start a replacement. The new waiter then remained unresolved.

The pump finalizer now clears its own reference and immediately checks for newly pending work. The regression also deletes a conversation while asynchronous persistence is active and verifies that an older queued write cannot resurrect it.

## Verification

- Added coverage requiring settled presentations to finalize their current transcript view without `forceRebuild`.
- Added a GTK regression that retains the same Markdown widget across ordinary stream finalization and makes it selectable in place.
- Added pure sidebar-diff coverage for minimal insertion and single-row refresh splices.
- Added asynchronous persistence coverage proving that writes yield to the main loop before touching disk.
- Added persistence ordering coverage proving that deleting a conversation during an active write does not resurrect it.
- Conversation-store, window background synchronization, automation sidebar, message-view, streaming-text, and import smoke tests pass.
- `git diff --check` reports no whitespace errors.
- The repository-wide `scripts/check.sh` currently stops at an unrelated in-progress Mail plugin discovery assertion in `tests/plugins-smoke.js`; the affected chat and persistence suites pass independently.

## Follow-up

- Add frame-duration instrumentation around send acknowledgement, persistence scheduling, stream finalization, and transcript adoption.
- Record persistence queue depth and batch duration in debug builds so coalescing and slow-storage behavior can be inspected without adding user-visible logging.
- Add a long-transcript benchmark that separately measures normalization, JSON serialization, async filesystem replacement, Markdown finalization, and GTK layout.
- Move serialization to a long-lived worker process only if measurements show CPU serialization still causes missed frames after asynchronous I/O and in-place UI finalization.
- Prefer row-level or message-level state adoption over full model replacement whenever a live view already represents canonical state.
- Keep lifecycle regressions focused on both final correctness and widget identity/main-loop work at presentation boundaries.
