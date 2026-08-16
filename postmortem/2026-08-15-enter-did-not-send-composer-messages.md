# Message submission stalled after Enter

Date: 2026-08-15

Affected release: 0.5.38

## Summary

Pressing Enter cleared the message composer, but no user message appeared and no provider request started. Submission stalled at the first asynchronous boundary because Cusco entered GTK's blocking application loop with `application.run()` instead of GJS's promise-aware `runAsync()` API.

## Impact

- Users could type messages but could not send them.
- The composer cleared as though the message had been accepted, while the conversation remained unchanged.
- The application displayed no error because the submission promise remained pending rather than rejecting.
- No conversation data was lost or corrupted; the message was never committed.

## Root cause

The application entry point called the synchronous `Gio.Application.run()` method from an ES module even though Cusco's UI workflows depend heavily on JavaScript promises. On the affected GJS runtime, GTK continued processing native events while JavaScript promise continuations did not resume until the blocking application loop exited. The supported `await application.runAsync()` entry point keeps the GJS promise job queue integrated with the running application.

`_sendMessage()` reached `await waitForUiPresentation()` before provider validation, active-turn creation, provisional-row rendering, hook execution, and message persistence. The submit handler had already cleared the composer synchronously, so the visible result was an empty composer and an unchanged message list. The same entry-point defect could also stall other asynchronous UI workflows after their first pending promise.

Version 0.5.38 made the send failure immediately visible by clearing the composer and yielding before constructing the provisional user row. The synchronous application entry point predated that change, but existing flows did not expose it with this exact symptom.

## Why tests missed it

The existing `_sendMessage()` smoke coverage ran as an ES-module test with top-level `await`, where the promise job queue was serviced normally. It covered provider validation, hooks, message commitment, background sending, and error handling without launching Cusco through its real entry point.

The import smoke test imported application classes but did not execute or inspect `src/main.js`. Composer tests exercised key handling and send branching without running a visible `Gtk.Application`, so none of them covered the boundary between GJS's module job queue and the GTK application loop.

## Detection and diagnosis

The original report described Enter as doing nothing, which initially pointed diagnosis toward keyboard event propagation. A live controller probe found both Cusco and `GtkTextView` key controllers in the bubble phase, leading to a capture-phase change. The user retest failed. Moving the controller to an ancestor also failed.

The decisive observation was that Enter cleared the composer while the message list and persisted conversation remained unchanged. This proved the key event and submit callback were working and moved investigation downstream.

A captured diagnostic run logged submission stages without recording message content. Two attempts both reached `_sendMessage()` and then stopped before the log immediately following its first `await waitForUiPresentation()`. The process remained responsive and accepted the second attempt, demonstrating a stalled JavaScript continuation rather than a crash, provider error, hook rejection, or busy-conversation state.

Changing the presentation helper from an idle callback to a timeout and then to a frame-clock boundary did not fix the live app. A minimal visible GTK test finally isolated the application-loop boundary: with `application.run()`, a resolved promise resumed only after the test forced the application to quit; with `await application.runAsync()`, the same GTK frame handoff resumed in about 1 ms.

The speculative key-controller and presentation-helper changes were then reverted.

## Resolution

- `src/main.js` now starts the application with top-level `await application.runAsync(...)`.
- The import smoke test rejects a return to synchronous `application.run()` so the real entry-point requirement is covered even in headless checks.
- The original presentation helper and composer key controller were retained; neither was the cause.
- Temporary diagnostic logging was removed after isolating the stalled await.

## Verification

- A minimal visible `Gtk.Application` test confirmed the promise continuation completes immediately with `runAsync()` and stalls with `run()`.
- The import and composer smoke suites pass.
- An interactive source retest confirmed that the submitted user message appears in the message list.

## Follow-up

- Run promise-based GJS applications through the async main-loop API and await it from the module entry point.
- Cover application entry-point semantics, not only importability and component behavior.
- Diagnose UI symptoms across the complete event-to-persistence path before treating the first suspicious layer as the root cause.
- Keep temporary stage logging content-free and remove it once a silent asynchronous stall is isolated.
