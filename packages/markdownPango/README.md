# Markdown to Pango

Streaming-safe Markdown block parsing and inline conversion to escaped Pango
markup and render models for native GTK presentation.

Render models include UTF-8 `mathRanges` for `$…$`, `\(…\)`, `$$…$$`, and
`\[…\]`. Standalone display formulas are `math` blocks. Code spans and fences
remain literal; escape a literal dollar sign as `\$` outside code. Single-dollar
math cannot start/end with whitespace or end immediately before a digit, which
keeps ordinary amounts such as `$5 and $10` literal. Ambiguous dollar pairs can
be escaped explicitly. Incomplete expressions remain source text until closed.
Math ranges retain source text and are excluded from per-word stream animation;
`packages/nativeMath` supplies their GTK rendering.

When display math splits a paragraph before a code block, that code block also
carries `sourceBlockIndex`, preserving the original numbering used by saved
artifact references. Artifact producers and consumers use it instead of the
display block's array index when present.
