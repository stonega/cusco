# Streaming text

Text reveal-unit planning and adaptive stream smoothing independent of the GTK
animation view that consumes it.

`StreamingTextSmoother` keeps a canonical target separate from visible text. It
reveals one language-aware unit at a natural cadence while the queue is short,
uses provider-rate and backlog pressure to reveal phrase-sized batches, and
drains completed responses against a fixed deadline. Oversized bursts expose
their older prefix without animation so only the newest tail consumes the
presentation budget.

The timing controller accepts injected `schedule`, `cancel`, and `now`
functions for deterministic testing. Its main tuning options are
`targetLagMs`, `recoveryMs`, `finishDrainMs`, `maxLiveLagMs`, and
`maxBatchUnits`.
