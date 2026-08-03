# Output-heavy tool calls stalled the UI

Date: 2026-08-03

Affected release: 0.5.31

## Summary

Cusco stopped dispatching GTK events while an agent ran output-heavy shell tools. GNOME displayed its “Cusco Is Not Responding” dialog during a HyperFrames build and validation workflow. The tool turn could also remain open after its timeout because descendant processes survived the terminated shell and kept its output pipes open.

## Impact

- The chat window stopped repainting and responding to input during affected tool calls.
- Heavy build, validation, and rendering commands were terminated after an unintended 30-second ceiling.
- Descendant processes could continue consuming CPU, memory, or GPU resources after the parent shell timed out.
- Agent turns could wait for inherited output pipes to close after the command timeout had already fired.
- No conversation data was lost or corrupted.

## Root cause

Cusco read each shell subprocess pipe in 4 KiB chunks at `GLib.PRIORITY_DEFAULT`. Each completed read immediately scheduled the next read and synchronously updated the live GTK output preview. Commands with continuously available output therefore competed with GTK input, rendering, and window-management work at the same main-context priority. Every chunk also replaced the preview text and requested scrolling, multiplying the UI work.

The command timeout had two independent lifecycle defects. `runBashCommand` used `Math.min` with a 30-second default, so the response timeout passed by the window could never extend a shell command beyond 30 seconds. When that timeout fired, `Gio.Subprocess.force_exit()` terminated only the direct Bash process. Child processes inherited its stdout and stderr pipes, remained alive, and prevented the pipe-reading promises from reaching end-of-file.

## Detection and diagnosis

The issue was reported with a screenshot of GNOME’s application watchdog while a HyperFrames check ran through an agent tool call. The execution trace showed that provider and tool awaits were asynchronous, but Bash pipe reads and their preview callbacks shared the GTK main context.

Focused probes then isolated both failure modes:

- A continuous multi-megabyte output stream generated thousands of 4 KiB callbacks and corresponding preview updates.
- A shell that started a sleeping child and then timed out did not return promptly because the child retained the output pipes.
- The Bash timeout normalization always capped configured values at 30 seconds.

## Resolution

- Bash stdout and stderr are now drained at `GLib.PRIORITY_LOW`, below GTK interaction and rendering work.
- Live output is bounded and coalesced into updates no more than once every 100 milliseconds.
- Preview scrolling keeps at most one pending idle callback instead of queueing one per output update.
- Each command runs in an isolated process group. Cancellation or timeout terminates the group rather than only the direct shell.
- Pipe reads use an internal `Gio.Cancellable`, allowing a stopped command to release its turn without waiting for inherited file descriptors.
- Shell commands now have an independent, bounded five-minute timeout instead of reusing the provider-response timeout with a hidden 30-second cap.

## Verification

- A 16 MiB output regression verifies that low-priority UI heartbeats continue and that preview callback delivery remains bounded.
- A process-tree regression starts a five-second child, applies a one-second timeout, verifies the result returns within 2.5 seconds, and confirms the child no longer exists.
- A separate 32 MiB stress run completed in approximately 279 milliseconds while dispatching 27 UI heartbeats and only two preview callbacks.
- The complete smoke suite passed.
- The Meson build completed successfully.

## Follow-up

- Keep continuous background I/O below GTK event and frame priorities.
- Treat live previews as sampled state rather than lossless event logs; the completed tool result remains authoritative.
- Terminate subprocess trees and cancel their I/O together whenever a tool can spawn descendants.
- Keep provider request deadlines separate from long-running local tool deadlines.
- Audit other subprocess-backed features before adding streaming callbacks or recursive asynchronous reads on the GTK main context.
