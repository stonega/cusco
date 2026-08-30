# Mail through GNOME Online Accounts

Cusco's Mail plugin reads non-Google mail accounts already configured in GNOME
Online Accounts (GOA). It covers Microsoft, Microsoft 365, Exchange, and generic
IMAP/SMTP profiles when GOA exposes a secure IMAP endpoint. Google accounts stay
in the Gmail plugin because Gmail search, labels, message IDs, and threads use
provider-specific IMAP extensions.

## Runtime flow

1. The Mail plugin declares a Cusco connector of type
   `gnome-online-accounts`, runtime `mail-goa`, service `mail`.
2. **Plugins → Mail → Connect** enumerates GOA accounts that expose Mail plus
   OAuth2Based or PasswordBased. Google accounts, profiles without IMAP, plain
   text endpoints, and profiles configured to accept invalid certificates are
   excluded.
3. Cusco calls `EnsureCredentials`, obtains either a short-lived OAuth2 token or
   the logged `imap-password` credential from GOA, and verifies the account over
   implicit TLS or STARTTLS. OAuth2 accounts authenticate with SASL XOAUTH2;
   password accounts use IMAP LOGIN only after the secure channel exists.
4. Cusco persists only the opaque GOA account ID in
   `~/.config/io.github.stonega.Cusco/mail-goa.json`, mode `0600`. Tokens and
   passwords exist only for the active request and never enter connector state,
   plugin metadata, model output, or logs.
5. Agent Mode registers Mail tools only while the Mail plugin is installed,
   enabled, and bound to an account that GOA still exposes.

GOA provides account discovery and credentials, while Cusco implements the
mail protocol. This follows GOA's consumer model: filter `GoaObject` instances
by the service interface, retain `GoaAccount:id`, ensure credentials, then use
the account's OAuth2Based or PasswordBased interface.

See the official [GOA client overview](https://gnome.pages.gitlab.gnome.org/gnome-online-accounts/overview.html),
[provider/service matrix](https://gnome.pages.gitlab.gnome.org/gnome-online-accounts/services.html),
[Mail interface](https://gnome.pages.gitlab.gnome.org/gnome-online-accounts/dbus-org.gnome.OnlineAccounts.Mail.html),
and [PasswordBased interface](https://gnome.pages.gitlab.gnome.org/gnome-online-accounts/dbus-org.gnome.OnlineAccounts.PasswordBased.html).

## Mail tools

The native surface is read-only and inbox-scoped:

- `read_latest_mail`: read the newest matching inbox message in one bounded
  IMAP session.
- `search_mail`: search by free text, sender, recipient, subject, date range,
  unread state, or flagged state; return bounded metadata and snippets.
- `search_mail_ids`: return only matching numeric IMAP UIDs for a later read.
- `batch_read_mail`: read bounded bodies and attachment metadata for at most 20
  UIDs previously returned by the connector.

Every invocation uses Cusco's `ask` permission policy. Searches return at most
50 results. Message previews and bodies are capped before they enter model
context, and attachment payloads are never returned.

The connector deliberately does not expose send, reply, delete, archive, move,
or flag operations. It also does not synthesize conversation threads: unlike
Gmail's extension IDs, standard IMAP does not provide a portable thread
identity.

## Failure handling

- No compatible account: direct the user to **Settings → Online Accounts** and
  enable Mail for Microsoft, Microsoft 365, Exchange, or IMAP/SMTP.
- Missing or stale account: keep the plugin disconnected until the user selects
  an available account.
- Credential failure: direct the user back to GNOME Online Accounts; never read
  secrets through shell or D-Bus fallbacks.
- Insecure endpoint or accepted certificate errors: do not offer the profile to
  Cusco.
- Authentication rejection: request GOA account reconnection; do not persist or
  retry with a copied credential.
- Oversized message data: stop at Cusco's literal and body bounds.

## Verification

Run:

```sh
gjs -m tests/mail-goa-smoke.js
gjs -m tests/gmail-goa-smoke.js
gjs -m tests/plugins-smoke.js
gjs -m tests/import-smoke.js
```

The Mail smoke test uses fake GOA and IMAP boundaries. It covers OAuth2 and
password credential flow, STARTTLS, structured search escaping, pagination,
account-state minimization, tool permissions, and plugin lifecycle without
contacting a real mailbox.
