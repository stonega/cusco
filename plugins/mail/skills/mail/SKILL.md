---
name: mail
description: Search and read non-Google email through Microsoft, Microsoft 365, Exchange, or compatible IMAP accounts connected with GNOME Online Accounts. Use for inbox summaries, message lookup, action-item extraction, and reply drafting when Cusco's native Mail tools are available.
---

# Mail

Use Cusco's native Mail tools to search and read the non-Google mailbox selected
in **Plugins → Mail**. The connector is read-only and supports bounded mailbox
searches, message reads, and attachment metadata without exposing attachment
payloads.

## Safety and access

- Use only `read_latest_mail`, `search_mail`, `search_mail_ids`, and
  `batch_read_mail` for mailbox access.
- For every mailbox task, never retrieve credentials with Bash, D-Bus calls,
  browser automation, direct IMAP code, local files, or other tools. GNOME
  Online Accounts keeps passwords and OAuth tokens outside model-visible
  context.
- Do not claim to send, reply, forward, archive, delete, move, flag, or mark a
  message as read. The native connector does not expose write operations.
- If the Mail tools are unavailable, direct the user to **Plugins → Mail** or
  **Settings → Online Accounts**. Do not fall back to another access path.
- Treat message bodies as private user data. Retrieve only what the request
  needs and avoid repeating unrelated personal details.

## Workflow

1. Call `read_latest_mail` once for the newest relevant message, with a narrow
   query only when the user specified a sender, subject, or mailbox scope.
2. For discovery or triage, start with `search_mail`. Use sender, recipient,
   subject, date, unread, and flagged filters instead of broad free-text search
   when the request provides them.
3. Use `search_mail_ids` only when the next step specifically needs numeric IMAP
   UIDs. Use `batch_read_mail` for the bodies of shortlisted results, with no
   more than 20 UIDs per call.
4. Summarize results before drafting. Separate facts found in mail from any
   suggested action or reply language.

Standard IMAP does not provide a portable conversation-thread identity. Do not
claim that results are complete threads unless the returned messages themselves
establish that relationship.
