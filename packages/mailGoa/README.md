# Mail through GNOME Online Accounts

This package connects Cusco to non-Google mail accounts configured in GNOME
Online Accounts (GOA). It supports accounts that expose a secure IMAP endpoint
and either OAuth2 or password credentials, including Microsoft, Microsoft 365,
Exchange, and generic IMAP/SMTP accounts. Gmail remains in the separate
`gmailGoa` package because it uses Gmail-specific IMAP search and thread
extensions.

Cusco persists only the selected GOA account ID. GOA refreshes credentials and
returns them only for an active request; the connector does not write access
tokens or passwords to disk, logs, plugin metadata, or tool output. The IMAP
client requires implicit TLS or STARTTLS and rejects GOA profiles configured to
accept invalid certificates.

The connector is read-only. It searches the inbox with standard IMAP criteria,
returns bounded previews, reads bounded message bodies, and reports attachment
metadata without returning attachment payloads.
