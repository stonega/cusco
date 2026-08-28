# Gmail through GNOME Online Accounts

This package binds Cusco's Gmail plugin to a Google account already configured in
GNOME Online Accounts (GOA). GOA remains responsible for account authentication
and credential refresh. Cusco stores only the selected GOA account ID and asks GOA
for a short-lived access token when a Gmail tool runs.

The connector opens the secure IMAP endpoint described by GOA and authenticates
with SASL XOAUTH2. It does not call the Gmail REST API, whose enablement belongs
to GNOME's OAuth client project. Gmail's `X-GM-RAW`, `X-GM-MSGID`, and
`X-GM-THRID` IMAP extensions provide query and thread semantics without a hosted
connector service.

The package registers five read-only tools: `read_latest_email`, `search_emails`,
`search_email_ids`, `batch_read_email`, and `read_email_thread`.
`read_latest_email` resolves and reads the newest inbox message inside one IMAP
session, so the common "read latest mail" request needs one model tool call.
Every invocation uses Cusco's normal per-tool permission prompt. Message fetches
and bodies are bounded, attachment payloads are excluded from tool output, and
OAuth tokens are never included in output or persisted by Cusco.

The Google account must expose Mail, OAuth2, and a secure IMAP configuration in
GOA. If Gmail rejects XOAUTH2 authentication, reconnect the account from GNOME
Settings → Online Accounts so GOA can renew the required grant.
