# Provider authentication architecture

Provider authentication is split across three narrow layers:

1. `packages/providerAuth/` owns OAuth/PKCE, Secret Service token records,
   refresh rotation, and provider-specific request profiles.
2. `src/providers/config.js` owns the selected method, provider readiness, and
   the request-authorizer closure injected into a remote provider instance.
3. `packages/providerRuntime/remoteProvider.js` builds the normal API request,
   then gives that request to the authorizer immediately before transport.

This keeps authentication independent from response parsing and tool logic.
An API-key request has no authorizer and follows the original code path.

## Persistent state

`provider-auth-methods` is a JSON GSettings map of provider ID to method ID.
It is configuration, not a credential. API keys continue to use
`io.github.stonega.Cusco.ProviderApiKey`; OAuth tokens use
`io.github.stonega.Cusco.ProviderAuthToken` with `provider` and `method`
attributes.

The file-backed settings fallback knows the same key, so selecting a method is
preserved when the compiled schema is unavailable during source development.

## Request authorization contract

Remote provider configs may expose:

```js
authorizeRequest(request, options) -> {
    url,
    headers,
    body,
    operation,
    stream,
}
```

The adapter supplies its normal URL, headers, and body. An OAuth profile may
replace only what its protocol requires. The transport validates that the
result still has a URL and headers before sending it.

OpenAI and Grok subscription methods use their Responses compatibility
profiles. Anthropic adds the Claude OAuth beta and Messages profile. Google
removes an API-key query parameter and supplies a bearer token while keeping
the normal Gemini API URL.

## Lifecycle

- Settings lists API key first and persists the selected method.
- Authentication methods may expose a `riskTitle` and `riskNote`; Settings
  shows that warning beside the selected method and repeats it in the
  confirmation dialog. Claude Code OAuth uses this disclosure because its
  unofficial compatibility traffic may be counted as extra usage.
- Connecting opens the system browser. OpenAI, Google, and Grok return to a
  short-lived loopback listener; Anthropic asks the user to paste its returned
  code.
- A successful exchange stores the versioned token record and can enable the
  provider.
- Before a request, tokens expiring within 60 seconds are refreshed. Concurrent
  callers share one refresh promise.
- A refresh failure produces a user-visible request to reconnect; no fallback
  credential or token from another application is inspected.
- Disconnect clears the selected OAuth record and disables the provider until
  valid credentials are configured.

Model lists remain Cusco-owned for built-in providers. Subscription profiles
do not use compatibility endpoints for model discovery. Image generation
continues to require the provider API key even when chat uses a subscription.
