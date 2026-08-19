# Provider authentication

This package owns OAuth/PKCE flows, refresh-token rotation, Secret Service
storage, and request profiles for built-in remote providers. API keys remain in
Cusco's existing API-key store and are never migrated or copied into OAuth
records.

The ChatGPT, Claude, and Grok subscription profiles use compatibility behavior
reviewed against sub2api at revision
`359fd12b2e0a4ab37143b9ecb7714236a1fc375c`. Those service endpoints and public
OAuth clients are not stable public API contracts and can stop working when an
upstream service changes. Google OAuth instead requires a desktop OAuth client
owned by the Cusco distributor through `CUSCO_GEMINI_OAUTH_CLIENT_ID` (and,
when required, `CUSCO_GEMINI_OAUTH_CLIENT_SECRET`).

Tokens are stored in the desktop Secret Service under a schema keyed by both
provider ID and authentication method. Request profiles receive tokens only at
the point where an HTTP request is authorized; provider configuration objects
and application settings never contain OAuth secrets.
