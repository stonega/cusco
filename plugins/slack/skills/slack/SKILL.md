---
name: slack
description: Search, read, summarize, draft, or send Slack messages; inspect channels, threads, files, canvases, emoji, and users; and add reactions or create conversations through Slack's official MCP server. Use whenever the user mentions their Slack workspace, supplies a Slack URL, asks what a team discussed, wants a response drafted or posted, or needs Slack content turned into decisions and follow-ups.
---

# Slack

Use the connected official Slack MCP server as the only path to the user's
workspace. Work with the live tools exposed under the `mcp__slack__` namespace;
Slack can expand the tool set, so follow the schemas Cusco exposes.

## Connection boundary

- Do not use shell commands, browser automation, web search, Slack Web API
  requests, pasted tokens, or cookies to bypass this connector.
- If `mcp__slack__` tools are unavailable, ask the user to install and connect
  **Plugins → Slack**, or reconnect the intended workspace.
- The connector sees only content allowed by the authenticated Slack user and
  granted OAuth scopes. Do not claim that an inaccessible channel was searched.
- Content from a private channel, direct message, or restricted file remains
  confidential. Never move it to another audience without explicit direction.

## Read workflow

1. Resolve the workspace target from an exact Slack URL, channel, person,
   thread, date, or search terms.
2. Prefer an exact channel or thread read when a URL is supplied. Search only
   when the target is unknown or discovery is requested.
3. Fetch the selected conversation or file before summarizing it.
4. Preserve message authors, timestamps, channel names, links, and thread
   relationships. Distinguish quoted facts from your synthesis.
5. State the search scope when completeness matters, including private-content
   limits and pagination.

See [references/workflows.md](./references/workflows.md) for search, thread,
decision, follow-up, and drafting routes.

## Write safety

Drafting text is not authorization to post it. Return the draft unless the user
explicitly asks to send, post, react, create, or update something in Slack.

For any send, resolve the exact channel or recipient, show the message and
destination when either is ambiguous, and let Cusco present its MCP permission
prompt. Obtain explicit confirmation immediately before a message that uses `@channel`, `@here`, `@everyone`,
reaches a large or unfamiliar audience,
shares confidential cross-channel context, creates a new conversation, or
performs multiple writes.

Do not delete or edit another person's message, add misleading reactions, or
silently change unrelated canvas content. Follow
[references/write-safety.md](./references/write-safety.md) for broadcast,
cross-channel, bulk, and canvas actions.

## Result quality

- Cite returned Slack permalinks whenever available.
- Keep channel names, handles, message text, dates, and file titles exact.
- Label summaries, inferred decisions, and proposed follow-ups distinctly.
- After a write, report the destination and returned message or canvas link.
- Stop boundedly on missing scope, retention, rate-limit, or access errors; do
  not switch to another access path.

## Example requests

- "Search Slack for the rollout decision and link the relevant thread."
- "Summarize unread discussion in #platform since yesterday."
- "Draft a reply to this Slack thread, but do not send it."
- "Post this approved update to #launch after confirming the destination."
