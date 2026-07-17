# Chat Switching Performance

Chat navigation is designed to keep GTK's main loop responsive even when the local conversation database or the selected transcript is large. This document records the performance constraints so future transcript features do not reintroduce selection lag.

## User-visible behavior

- Selecting a conversation changes the active chat immediately and lets GTK paint before an uncached transcript is built.
- The four most recently used conversation views keep their GTK widget trees, so switching back to a recent chat normally reuses the existing view.
- A long conversation initially shows its latest 32 messages. Use **Show earlier messages** above the transcript to load the preceding page. This only windows the presentation; no history is deleted.
- When a page boundary falls inside an Agent Mode reasoning or tool sequence, Cusco includes up to six earlier context messages so the sequence is not shown without its lead-in.

## Root causes and mitigations

| Previous bottleneck | Mitigation |
|---|---|
| Selecting a row serialized and atomically rewrote the complete conversation database. | Active selection is stored in the small `conversations.json.state` sidecar. Selecting the already active chat is a no-op. |
| Every switch rebuilt every message widget, including chats the user had just viewed. | A four-entry least-recently-used view cache retains recent GTK transcript trees. Cache fingerprints invalidate a view when its conversation or visual theme changes. |
| Opening a long chat materialized its entire history synchronously. | Only the latest 32 messages are initially materialized, with explicit backward pagination. |
| An uncached transcript monopolized the GTK main loop while its widgets were created. | Its first render is deferred until GTK gets an idle turn, then widget creation is split into batches with an 8 ms time budget. A stale batch is cancelled when the user selects another chat. |
| Collapsed reasoning/tool bodies, code highlighting, and image previews still performed expensive work during selection. | Collapsed content is lazy, syntax work is queued at low priority, and bounded image previews are decoded asynchronously before texture creation. |
| Streaming text repeatedly rebuilt message content and rewrote durable state for small deltas. | Visible content is coalesced to roughly 33 ms, usage display changes to 100 ms, and streaming deltas remain in memory until a terminal persistence point. |
| An asynchronous cron refresh could restore a selection made before the refresh started. | A monotonically increasing selection serial prevents stale background work from overriding a newer user selection. |

## Persistence boundaries

`conversations.json` remains the authoritative transcript database. Writes are compact JSON and use the existing atomic temporary-file replacement. `conversations.json.state` contains only the active conversation ID and is also written atomically.

Mutations outside an active response stream remain durable immediately. Assistant streaming is the exception: intermediate text, reasoning, artifact, and usage deltas update the normalized in-memory conversation without rewriting the full database. Successful completion or the stopped-response transcript update persists the result, and the window close handler performs a final safety flush. If the process exits abnormally during a response, the newest unflushed partial delta can be lost; completed messages and the already-persisted user message remain durable.

Keep these boundaries intentional. A new navigation-only property belongs in the sidecar or another small state store; it should not force a transcript rewrite. A new streaming field should participate in the completion/stopped-response flush and close safety flush.

## Rendering constraints

The relevant limits are deliberately small and centralized near the top of `src/window.js` and `src/chat/messageView.js`:

- `MAX_CACHED_CONVERSATION_VIEWS = 4`
- `CONVERSATION_MESSAGE_PAGE_SIZE = 32`
- `CONVERSATION_PAGE_CONTEXT_LIMIT = 6`
- `CONVERSATION_RENDER_BATCH_BUDGET_US = 8000`
- `CONTENT_UPDATE_INTERVAL_MS = 33`
- `STREAMING_USAGE_UPDATE_INTERVAL_MS = 100`
- artifact previews decode at `360 × 240` and retain at most 24 cached paintables

Treat these as responsiveness and memory tradeoffs, not arbitrary presentation defaults. Increasing page or cache sizes should be accompanied by measurements on large, media-rich transcripts.

## Verification

Run the normal source checks after changing navigation, persistence, or message rendering:

```sh
scripts/check.sh
```

The smoke coverage verifies that selection does not rewrite the full database, repeated selection is a no-op, deferred streaming updates do not persist synchronously, explicit flushes use the normalized save path, and transcript page boundaries preserve Agent Mode context.

For interactive profiling, use a copy of a real database and alternate between cached and uncached chats containing markdown, code, reasoning, tools, and image artifacts. Measure the row-click handler separately from time-to-visible transcript; a fast handler can still hide expensive idle work.

The optimization pass was checked on a representative 5.6 MB database containing 60 chats and 1,310 messages. On the development machine, row-click handling stayed around 0.98–1.27 ms, uncached chats became visible in 15.3–24.4 ms, and a cached return took about 1.09 ms. These are reference measurements, not portable CI thresholds; compare regressions on the same machine and dataset.
