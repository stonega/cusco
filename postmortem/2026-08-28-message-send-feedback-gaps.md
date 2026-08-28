# Message sending had two visible feedback gaps

Date: 2026-08-28

Affected release: 0.5.40 and later development builds

## Summary

Sending a message did not produce one continuous visual response. The composer cleared first, then the user message appeared after a noticeable pause. A second pause followed before the assistant displayed “Agent is thinking...”.

The provider had not started responding during either gap. Both delays came from the ordering of local UI presentation and turn preparation. Cusco explicitly deferred the optimistic user row until a GTK idle callback, then deferred assistant activity until after hooks, persistence, tool preparation, and other preflight work.

## Impact

- Sending felt unresponsive even though the click or Enter action had been accepted.
- Clearing the composer without simultaneously showing the sent message created uncertainty about whether the message had been submitted.
- Agent Mode could leave the transcript visually idle while refreshing MCP servers and connectors.
- The second delay varied with hook execution, transcript size, storage speed, enabled MCP servers, connector discovery, and context compaction.
- Message and response data remained correct. The defect affected immediate feedback and perceived responsiveness.

## Root cause

The two pauses had separate sequencing causes.

The submit handler cleared the composer and called `TurnSubmission._sendMessage()`. That method immediately awaited a `GLib.PRIORITY_DEFAULT_IDLE` callback before constructing the provisional user widget. The intent was to let GTK paint the empty composer before provider validation or other work, but it guaranteed a frame in which the input disappeared and no corresponding message existed in the transcript. Under main-loop load, the idle callback could be delayed longer than one frame.

After the provisional user row appeared, Cusco awaited more preparation before creating the assistant view:

- conversation sidebar refresh;
- SessionStart and UserPromptSubmit hooks;
- attachment materialization;
- synchronous transcript and index persistence;
- requested-tool detection and authorization;
- memory and skill context injection;
- MCP tool refresh;
- connector and plugin discovery;
- possible automatic context compaction.

`AssistantStreamRunner` created its streaming assistant view only after those operations. In Agent Mode, the literal “Agent is thinking...” status was set later still, inside the first agent loop iteration.

MCP and connector refreshes also ran sequentially. MCP refresh walks enabled servers and awaits each connection and tool-list operation. Connector refresh could additionally inspect the plugin catalog and refresh GNOME Online Accounts before returning. Their cumulative latency therefore remained completely invisible in the transcript.

## Why tests missed it

The existing normal-send regression intentionally asserted that no send work occurred before the first low-priority main-loop turn. This protected the cleared composer from being blocked by expensive preparation, but it also encoded the incorrect ordering: the optimistic user row was classified as work that should wait.

The same test verified that a provisional user row remained visible while hooks ran. It did not assert that the row existed synchronously when submission began, and it did not require assistant activity to exist before hooks or tool discovery.

Assistant streaming tests covered loading state, response presentation, cancellation, and final transcript rebuilding. They began at or after assistant-view creation, so they did not cover the preflight interval before that view existed. There was also no ordering test proving that MCP and connector refreshes started concurrently.

## Detection and diagnosis

The two distinct pauses indicated two presentation boundaries rather than one provider delay. Tracing the send action showed that the composer was cleared synchronously, while the first visible transcript mutation was placed after an explicit idle await.

Tracing the second boundary showed that `_streamAssistantResponse()` was not called until after prompt approval and message persistence. Inside the runner, assistant-view creation followed another sequence of awaited operations, including live Agent Mode tool discovery. The “Agent is thinking...” label was only applied after the runner reached `_runAgentModeResponse()`.

This established that provider first-byte latency was not responsible: the UI was already idle-looking before the provider request could begin.

## Resolution

- Construct the optimistic user row synchronously, before the first GTK presentation yield, so the composer clear and transcript insertion paint together.
- Include composer references in the provisional message so its initial rendering matches the eventual durable message.
- Create the streaming assistant view immediately after the provider and turn are accepted, and show Agent activity before hooks, persistence, tool discovery, or provider work.
- Keep the optimistic user widget in its original transcript position and promote it in place after hooks approve and persist the message.
- Refresh attachment previews, body content, and message actions during promotion instead of removing and re-appending the row.
- Remove both optimistic widgets and restore the draft when provider validation, turn creation, or prompt hooks reject the submission.
- Pass the already-visible assistant view and original start time into `AssistantStreamRunner` rather than creating a second view after preflight.
- Create assistant activity at the beginning of direct retry and regeneration streams as well.
- Run MCP and connector tool refreshes concurrently. They still complete before the provider request so the Agent receives an authoritative tool list, but their latency is now covered by visible activity.

## Verification

- Updated the normal-send regression to require the user row and “Agent is thinking...” status before deferred hook or persistence work.
- Added coverage proving that an approved message promotes its optimistic row in place without removal or duplicate committed insertion.
- Extended the blocked-prompt regression to require removal of both optimistic rows and restoration of the composer draft.
- Added an Agent preflight regression requiring activity before SessionStart hooks and requiring MCP and connector refreshes to begin concurrently.
- Import, Agent Mode, chat-management, and focused background-sync smoke tests pass.
- The complete `scripts/check.sh` suite passes, including the Meson build.
- `git diff --check` reports no whitespace errors in the changed files.

## Follow-up

- Treat immediate acknowledgement as part of message submission correctness, not as an optional animation or polish concern.
- Keep the first visible state mutation before any idle callback, disk write, subprocess hook, connector lookup, or network operation.
- Preserve widget identity when optimistic state becomes durable so layout position and interaction state do not flicker.
- Keep slow preflight work behind an explicit, already-painted activity state.
- Cache tool discovery where configuration and connection invalidation can remain authoritative; until then, continue refreshing required sources concurrently.
- Add timing-order regressions whenever a workflow clears or disables an input before its result appears elsewhere in the interface.
