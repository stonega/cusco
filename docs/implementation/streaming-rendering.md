# Streaming response rendering

Cusco's native implementation adapts the newly-mounted-text behavior of [Vercel Streamdown](https://github.com/vercel/streamdown) to GTK/Pango rather than embedding its React renderer. Cusco keeps provider ingestion, canonical conversation state, and visible text pacing separate. Provider chunks update the in-memory assistant message immediately, while `StreamingTextSmoother` releases complete display units on a steady GLib timer. This prevents provider-specific chunk sizes and pauses from directly controlling the native transcript's cadence.

The smoother reveals the first display unit immediately, then reveals exactly one language-aware unit every 24 milliseconds. Its update is rendered synchronously instead of passing through a second UI throttle, so adjacent units cannot be merged into one visible update. Provider completion keeps the same cadence for any remaining visual tail, while turn cleanup and queued-message handling continue immediately. Authoritative replacement chunks bypass the queue so stale text is never revealed. Persistence, tools, exports, retry decisions, and response hooks always use canonical provider text rather than the paced display prefix.

`createMessageContent()` retains stable completed Markdown blocks and updates only the unfinished tail. The unit slicer keeps paired Markdown delimiters together, and incomplete emphasis, code, and link syntax is held or virtually closed until it can render without flashing raw punctuation. Markdown labels track rendered plain-text byte ranges separately from Markdown source positions, which prevents existing words from animating again when incomplete syntax becomes valid. Inline and fenced code, tables, dividers, artifacts, and tool surfaces are excluded from text effects.

`AnimatedMarkdownLabel` preserves a normal selectable and accessible `Gtk.Label` as the content widget. During a stream it temporarily snapshots newly visible Pango ranges over the label with one frame clock per label. The available effects are:

- `blurIn`: opacity and a four-pixel blur resolve together.
- `fadeIn`: opacity resolves without movement.
- `slideUp`: opacity resolves while the range rises four pixels.
- `none`: visible content is updated without pacing or animation.

The Chat appearance preference controls the effect. Cusco's Reduced motion setting and GNOME's `gtk-enable-animations` setting override it and flush pending visible text immediately across active and cached conversations. If a cached conversation becomes unmapped, its pending reveal and animation ranges are also flushed because GTK does not drive frame callbacks for hidden `Gtk.Stack` children. When a response completes, the paced reveal and active effect ranges finish before the message is converted to its static selectable state; completed messages retain no animation timer or overlay state.

Run these focused checks while changing the pipeline:

```sh
gjs -m tests/streaming-text-smoke.js
gjs -m tests/stream-animation-smoke.js
gjs -m tests/markdown-smoke.js
gjs -m tests/message-view-smoke.js
gjs -m tests/window-provider-fallback-smoke.js
```

`tests/stream-animation-smoke.js` exercises the pure animation model everywhere. When a GTK display is available, it additionally presents a real window and verifies mapped animation completion plus the hidden-`Gtk.Stack` flush path.
