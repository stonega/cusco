# Streamed messages jumped to the complete response

Date: 2026-08-16

Affected release: 0.5.38

## Summary

Assistant messages initially used the configured streaming animation, then abruptly showed the complete response while the provider was still streaming. The text smoother treated provider revisions as instructions to flush all queued text instead of retargeting the paced reveal.

## Impact

- Responses could animate normally for the first few lines and then jump to the latest complete provider snapshot.
- The behavior made uneven provider delivery visible and defeated the purpose of the streaming animation preference.
- Persisted message content remained correct; the defect affected presentation only.
- Reduced-motion and disabled-animation behavior were unaffected.

## Root cause

`StreamingTextSmoother` maintains two versions of a response: the canonical provider target and the smaller prefix currently visible in the UI. Providers can revise partial output when reconciling streamed deltas with an authoritative response or while continuing an output-limited response.

The smoother originally classified an update as a replacement whenever the new target did not extend the previous target. It handled that replacement by calling `flush({ replace: true })`, which assigned the entire canonical target to the visible text in one update. A provider revision could therefore reveal every queued word at once even though the response was still active.

The first fix changed the comparison from the previous target to the visible prefix. That preserved animation when a revision changed only text that had not appeared yet. It did not handle revisions that diverged within already-visible text: those updates still took the full-flush path. The user's immediate retest exposed that incomplete diagnosis.

## Why tests missed it

The original replacement smoke test explicitly expected an authoritative replacement to become completely visible immediately. That assertion encoded the undesirable jump as intended behavior.

Other streaming tests covered cumulative target growth, completion draining, placeholder replacement, Unicode segmentation, and Markdown delimiter stability. None simulated a provider revising an already-visible prefix while additional text remained queued.

The first regression test covered only an unseen queued-suffix correction. It proved the narrow first fix but did not reproduce the user's remaining visible-prefix case.

## Detection and diagnosis

The initial report said that only the first two lines animated before the complete message appeared. Review of the completion path showed that queued text was supposed to drain one reveal unit per tick, so the first diagnosis focused on the final canonical-response handoff.

After changing unseen-suffix revisions to retain the visible prefix, the targeted smoke suites passed. The user still reproduced the jump and clarified that it occurred during streaming rather than only at completion. That moved the investigation from completion draining to all mid-stream flush paths.

The remaining path was the smoother's handling of a target that no longer began with the visible text. Its unconditional `flush()` exactly matched the observed jump and was reachable when a provider revised already-visible partial output.

A later report appeared to reproduce the same jump at an ASCII quote in a Chinese Kimi response. Replaying the exact persisted response through the workspace source showed one-character updates and active animation ranges before, across, and after the quote. Inspection then showed that the desktop launcher resolved to `/usr/bin/cusco`, which loaded an August 4 build from `/usr/share/cusco`; that installed copy still contained the original unconditional replacement flush. The workspace fix had not been installed, so this report was validation against a stale executable rather than a new source defect.

## Resolution

- Provider revisions no longer flush the complete target.
- The smoother finds the shared prefix between the visible and revised text.
- It replaces the stale portion with at most one corrected reveal unit immediately, then resumes the normal one-unit-per-tick schedule for the remaining response.
- Revisions confined to the unseen queue retain the visible text and continue pacing without a replacement frame.
- The replacement regression now rejects complete-response flushes and verifies that the revised target finishes through scheduled reveal updates.

## Verification

- The streaming-text smoke suite covers both unseen queued-suffix revisions and revisions that replace already-visible text.
- Message-view and native stream-animation smoke tests pass.
- Provider fallback and Agent Mode streaming smoke tests pass.
- The import smoke test passes.
- `git diff --check` reports no whitespace errors.

## Follow-up

- Model streaming tests around presentation invariants, not provider implementation details: no ordinary update may reveal an unbounded queued tail.
- Treat provider snapshots as revisable canonical state while independently pacing visible state.
- Include a regression for every distinct branch in a failed fix before considering the incident resolved.
- Include punctuation-normalization regressions for quoted CJK output, where a provider may reconcile curly and ASCII quotes.
- Confirm the executable and module path used for interactive verification; restarting an older installed build does not exercise workspace changes.
- Fully restart the GJS application before interactive verification because running processes do not reload changed modules.
