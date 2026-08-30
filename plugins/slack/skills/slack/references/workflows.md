# Slack workflows

## Search and summarize

Use the narrowest available search with the user's keywords, people, channel,
and date hints. Read the selected channel or full thread before reporting a
decision. Link the returned messages and state any pagination or access limits.

## Draft a reply

Fetch the target message and thread, then return a draft that matches the
requested tone. Do not post unless the user explicitly asks to send it.

## Send a message

Resolve the exact channel or person and preserve the reviewed text. Confirm
ambiguous recipients, broadcasts, cross-channel disclosure, and multi-message
operations immediately before the write.

## Extract decisions and follow-ups

Keep explicit decisions separate from proposals and inference. Include owners
and dates only when the source states them; otherwise mark them unassigned.

## Files and canvases

Read only the necessary file or canvas sections. Preserve unrelated content on
updates and never expose a restricted source in a broader channel by default.
