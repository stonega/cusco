# Gmail through GNOME Online Accounts

Cusco's Gmail plugin uses the Google account already configured in GNOME Online
Accounts (GOA). It does not require a hosted connector service or a second OAuth
callback server. Google still hosts the mailbox and IMAP endpoint; the removed
piece is the third-party connector intermediary.

## Runtime flow

1. The Gmail plugin declares a Cusco connector of type
   `gnome-online-accounts`, provider `google`, service `mail`.
2. **Plugins → Gmail → Connect** asks GOA for Google accounts that expose both
   Mail and OAuth2 interfaces. With multiple accounts, Cusco shows a native
   account chooser.
3. Cusco reads GOA's IMAP hostname, username, and TLS mode, calls
   `EnsureCredentials`, requests a short-lived OAuth2 access token, and verifies
   it against the configured IMAP endpoint using SASL XOAUTH2.
4. Cusco persists only the opaque GOA account ID in
   `~/.config/io.github.stonega.Cusco/gmail-goa.json`, mode `0600`. GOA remains
   responsible for credentials and refresh. Access tokens are held only for the
   active request and are never placed in plugin metadata, model context, logs,
   or tool output.
5. On each Agent Mode turn, Gmail tools are registered only when the Gmail
   plugin is installed and the selected GOA account still exists.

This follows GOA's documented consumer model: enumerate accounts through
`GoaClient`, retain the stable `GoaAccount:id`, call `EnsureCredentials`, then
obtain the token from the account's OAuth or OAuth2 interface. The application,
not GOA, implements the service protocol. See the official
[GOA client overview](https://gnome.pages.gitlab.gnome.org/gnome-online-accounts/overview.html)
and [Mail interface](https://gnome.pages.gitlab.gnome.org/gnome-online-accounts/dbus-org.gnome.OnlineAccounts.Mail.html).

The connector deliberately uses Gmail's IMAP transport rather than
`gmail.googleapis.com`. A GOA token belongs to GNOME's OAuth client project;
using it against the Gmail REST API can fail with HTTP 403 when that project has
not enabled the API. IMAP/XOAUTH2 is the mail service GOA configures and does not
have that Google Cloud API enablement dependency. See Google's
[XOAUTH2 protocol](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)
and [Gmail IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions).

## Gmail tools

The initial native surface is intentionally read-only:

- `read_latest_email`: resolves and reads the newest inbox message in one
  bounded IMAP session, with an optional Gmail query for a narrower scope.
- `search_emails`: Gmail query syntax, label filters, bounded metadata and
  snippets, and pagination.
- `search_email_ids`: the same bounded search when only IDs are needed.
- `batch_read_email`: bodies and attachment metadata for at most 20 selected
  messages.
- `read_email_thread`: resolves a message ID to its thread, or reads a known
  thread ID, with a bounded message count.

Each invocation uses the existing Cusco `ask` permission policy. Bodies are
bounded before entering model context. Message preview windows are capped before
parsing, attachment payloads are never returned to the model, and attachment
metadata is included only when its MIME headers occur inside that bounded window.

Write operations such as send, trash, archive, and label changes are not
registered by this connector. They need separate tool definitions, narrower
confirmation copy, and explicit behavioral tests before being enabled.

## Failure handling

- No compatible account: direct the user to **Settings → Online Accounts**, add
  Google, and enable Mail.
- Missing or stale account: leave the plugin disconnected and require account
  selection again.
- Credential refresh failure: direct the user back to GNOME Online Accounts.
- IMAP authentication rejection: request GOA account reconnection; never fall
  back to password authentication.
- Missing Gmail message or thread ID: report the failed lookup without widening
  it into an unrelated mailbox search.
- Oversized message data: stop at Cusco's literal and body limits rather than
  buffering an unbounded server response.

GOA's Google provider terms may require coordination for redistributed
third-party applications. Release owners should review the current
[GOA provider documentation](https://gnome.pages.gitlab.gnome.org/gnome-online-accounts/services.html)
and Google's OAuth policies before public distribution.

## Verification

Run:

```sh
gjs -m tests/gmail-goa-smoke.js
gjs -m tests/plugins-smoke.js
gjs -m tests/import-smoke.js
```

The connector smoke test uses fake GOA and IMAP boundaries. It verifies account
binding, state minimization, permission policy, tool registration lifecycle,
query bounds, Gmail ID conversion, MIME parsing, and that the access token is
absent from persisted state. It never contacts a real mailbox.

Meson installs the repository marketplace and bundled plugin directories under
Cusco's application data directory, so the same Gmail manifest and skills are
available when running the locally installed application rather than only from
the source checkout.
