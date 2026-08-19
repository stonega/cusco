# Provider authentication source review

Cusco's additional account authentication methods were reviewed on 2026-08-19
against sub2api revision
[`359fd12b2e0a4ab37143b9ecb7714236a1fc375c`](https://github.com/Wei-Shaw/sub2api/tree/359fd12b2e0a4ab37143b9ecb7714236a1fc375c)
and the providers' official documentation.

## Decision

Account authentication belongs beneath Cusco's existing remote providers. A
ChatGPT account is an authentication method for OpenAI, for example, rather
than a separate `codex-cli` provider. This preserves one provider catalog,
conversation format, tool runtime, fallback policy, and GTK surface.

Cusco does not embed sub2api, run it as a service, or import credentials from
provider CLIs. The reviewed project is a protocol reference for OAuth
parameters, refresh behavior, subscription endpoints, and request headers.
The implementation is native GJS and stores its own tokens in Secret Service.

## Supported methods

| Provider | Method ID | OAuth mode | Request surface |
|---|---|---|---|
| OpenAI | `chatgpt-subscription` | PKCE with fixed loopback callback | ChatGPT Codex Responses compatibility endpoint |
| Anthropic | `claude-subscription` | PKCE with manually pasted callback code | Claude Code Messages compatibility profile |
| Google Gemini | `google-oauth` | PKCE with loopback callback | Official Gemini API with bearer authentication |
| Grok | `grok-subscription` | PKCE with fixed loopback callback | Grok CLI Responses compatibility endpoint |

API keys remain the default and keep their existing endpoints, headers, model
catalogs, and Secret Service records.

## Trust and stability boundary

OpenAI, Anthropic, and Grok publicly document API-key access for their
developer APIs. Their consumer subscription compatibility endpoints and CLI
OAuth clients are more fragile integration points: availability can depend on
the account plan, provider terms, geography, and upstream client changes.
Cusco therefore labels these methods as account connections, asks for explicit
confirmation, and keeps every compatibility header in a small request profile.

Claude Code OAuth has an additional usage-accounting risk. The reviewed
compatibility implementation warns that traffic recognized as coming from a
third-party client may draw from extra usage instead of the usage included with
a Claude plan. Cusco cannot guarantee how Anthropic will classify requests, so
Settings shows this warning before connection and advises users to verify their
account usage afterward.

Google documents OAuth for the Gemini API. Cusco deliberately does not copy a
Google client secret from Gemini CLI or sub2api. Distributors provide their own
desktop OAuth client through `CUSCO_GEMINI_OAUTH_CLIENT_ID` and, if required,
`CUSCO_GEMINI_OAUTH_CLIENT_SECRET`.

## Security conclusions

- PKCE S256 and a random state value are required for every authorization.
- Loopback listeners bind only to IPv4 loopback and shut down after success,
  failure, cancellation, or timeout.
- Access, refresh, and ID tokens are stored under a provider-and-method Secret
  Service schema. They never enter GSettings, provider lists, logs, or
  conversation records.
- Refreshes are single-flight per account to prevent concurrent requests from
  racing refresh-token rotation.
- Switching methods does not delete credentials. Disconnect is an explicit
  action, and it removes only that provider/method token.
- API-key image generation remains separately gated by an API key; selecting a
  chat subscription does not silently send OAuth credentials to image APIs.

## Sources

- [sub2api README and source](https://github.com/Wei-Shaw/sub2api/tree/359fd12b2e0a4ab37143b9ecb7714236a1fc375c)
- [OpenAI: ChatGPT and API billing are separate](https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform)
- [OpenAI API authentication](https://developers.openai.com/api/docs/guides/production-best-practices)
- [Anthropic API getting started](https://docs.anthropic.com/en/api/getting-started)
- [Google Gemini OAuth](https://ai.google.dev/gemini-api/docs/oauth)
- [xAI API documentation](https://docs.x.ai/docs/tutorial)
