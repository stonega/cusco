# Real provider responses jumped at completion

Date: 2026-08-19

Affected release: Unreleased development builds after 0.5.38

## Summary

Long assistant responses revealed smoothly at first, then stopped animating and jumped to the complete answer when real provider streaming ended. Replaying the same Markdown in the Stream Replay debug window worked correctly.

The text smoother and renderer were behaving as designed. The real chat lifecycle rebuilt the active transcript before the message presentation had finished draining its queued text. That rebuild replaced the live streaming widget with a static row containing the already-persisted canonical response.

## Impact

- Long responses could jump over a substantial unrevealed tail when provider delivery finished faster than the configured visual pacing.
- The apparent jump point varied with response length, language, provider chunk timing, and system load; it was not a fixed halfway threshold.
- Stream Replay could not reproduce the defect because it exercised the renderer but not the application's turn-completion lifecycle.
- Persisted response content remained correct. The defect affected presentation only.
- Cancelling a response still intentionally flushed the visible content.

## Root cause

Cusco keeps canonical provider state separate from visible presentation state. Provider snapshots are persisted immediately, while `StreamingTextSmoother` reveals the visible prefix at a controlled pace. When provider delivery ends, `finish_stream()` returns a promise that resolves only after the queued presentation tail and active text effects settle.

There are also two active-turn ownership paths:

- Direct response actions let `AssistantStreamRunner` create and finish the turn itself.
- Normal and queued sends create the turn in `TurnSubmission`, then lend its cancellable to `AssistantStreamRunner`.

The direct path already told `TurnCoordinator` to defer the final transcript rebuild while a presentation promise existed. The borrowed path did not expose that promise to `TurnSubmission`. After `_streamAssistantResponse()` returned, the outer `finally` called `_finishActiveTurn(cancellable)` without `deferActiveConversationRender`.

`TurnCoordinator.finish()` then removed the busy state and immediately called `renderActiveConversation({ forceRebuild: true })`. Because the complete canonical response had already been persisted, the rebuilt row showed the entire answer and replaced the still-revealing widget. Unrooting the old widget disposed its smoother, making the jump permanent.

## Why tests missed it

The streaming-text tests correctly verified that `finish()` drains one reveal unit per scheduled tick. Message-view and animation tests also verified that `finishStreaming()` waits for pending presentation work.

Stream Replay explicitly waits for `finishStreaming()` before declaring the replay complete, so it modeled the correct renderer lifecycle and never invoked `TurnCoordinator` or rebuilt a conversation transcript.

The existing turn-coordinator regression verified that `deferActiveConversationRender: true` suppresses an early rebuild. It did not cover the normal borrowed-turn boundary where `AssistantStreamRunner` owned the presentation promise but `TurnSubmission` owned turn cleanup.

This left every individual subsystem covered while the ownership handoff between them remained untested.

## Detection and diagnosis

The key observation was that the exact response worked in Stream Replay but failed during real provider usage. That made provider text segmentation, Markdown stabilization, and the animation implementation less likely causes and pointed to application-only lifecycle work.

Tracing provider completion showed that `AssistantStreamRunner` started `finish_stream()` without awaiting it, intentionally allowing the composer and turn state to become responsive while the visual tail continued. The runner deferred its own turn cleanup, but normal sends used an externally owned turn.

Tracing the caller revealed the conflicting outer `finally`: `TurnSubmission` immediately finished the borrowed turn with the default rebuild behavior. The timing matched the report exactly—the jump occurred when provider delivery completed, regardless of how much of the canonical response the smoother had made visible.

## Resolution

- `AssistantStreamRunner` now exposes the settling presentation promise in its result.
- It also reports the promise through an `onPresentationSettling` callback, ensuring the outer owner receives it even when provider processing later throws and no normal result is returned.
- Normal sends and queued sends capture that promise and finish their borrowed turns with `deferActiveConversationRender: true`.
- The final forced rebuild is scheduled on the next GLib idle turn after presentation settlement. This lets borrowed-turn cleanup run first even when the presentation promise was already resolved.
- The existing busy and active-conversation guards still prevent a stale completion from rebuilding over a newer turn or another selected conversation.
- Starting a new turn continues to flush the preceding presentation tail so visual ordering remains deterministic.

## Verification

- Added a regression for an already-settled presentation racing borrowed-turn cleanup.
- Added a normal-send regression requiring an active presentation tail to defer transcript rebuilding.
- Streaming text, message view, native stream animation, Stream Replay, background synchronization, chat management, Agent Mode, provider fallback, import, and schema checks pass.
- `git diff --check` reports no whitespace errors.
- The complete repository check currently stops at an unrelated pre-existing symbolic-color assertion for `usage-symbolic.svg`; it does not reach the remaining suites.

## Follow-up

- Treat provider completion, presentation completion, and turn completion as separate lifecycle events in tests and APIs.
- Add integration coverage whenever ownership of an asynchronous resource crosses between coordinators.
- Extend Stream Replay with an optional real-chat lifecycle mode that persists the canonical message, releases a borrowed turn, and rebuilds the transcript.
- Cover normal, queued, cancelled, and error responses when testing presentation settlement handoffs.
- Keep transcript rebuilding off the synchronous completion path whenever a live message view still owns pending presentation work.
