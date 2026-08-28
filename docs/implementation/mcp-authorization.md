# MCP Authorization

Cusco authorizes remote Streamable HTTP MCP servers directly from the installed
desktop application. It does not require a Cusco-hosted callback or connector
service. OAuth credentials and tokens stay on the desktop; tokens are stored in
Secret Service rather than in `mcp.json`.

## Connection flow

1. Cusco sends the MCP `initialize` request. A `401`, or a `403` with
   `insufficient_scope`, records the Bearer challenge instead of treating the
   connector as a generic transport failure.
2. Cusco discovers OAuth Protected Resource Metadata from the challenge's
   `resource_metadata` URL, then falls back to the MCP endpoint's well-known
   locations.
3. Cusco discovers Authorization Server Metadata, validates the issuer and
   HTTPS endpoints, and requires PKCE `S256` support.
4. Cusco selects one of the client-registration paths supported by the server:
   a configured client ID, an HTTPS Client ID Metadata Document URL, or Dynamic
   Client Registration.
5. A temporary loopback callback receives the authorization code. Cusco checks
   `state`, validates `iss` when the authorization server advertises it, and
   exchanges the code with PKCE and the MCP `resource` parameter.
6. Token endpoint authentication is negotiated as `none`,
   `client_secret_post`, or `client_secret_basic`. Dynamic registration may
   return a client secret even though Cusco itself is a locally installed app.
7. Access, refresh, client-registration, scope, resource, and expiry metadata
   are stored together in Secret Service. Cusco refreshes an expiring access
   token before the next MCP request and preserves rotated refresh tokens.
8. **Sign out** in Plugins → MCP clears the stored authorization and disconnects
   the server.

This follows the MCP authorization specification and the same discovery,
resource-indicator, PKCE, registration, and refresh concepts described by the
ChatGPT MCP client documentation.

## Configuration

Most servers need only a URL:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Cusco discovers OAuth configuration when the server challenges the first
request. Servers with pre-registered client credentials can use the optional
`oauth` object:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "resource": "https://mcp.example.com/mcp",
        "clientId": "cusco-desktop-client",
        "clientSecretEnvVar": "EXAMPLE_MCP_CLIENT_SECRET",
        "tokenEndpointAuthMethod": "client_secret_post",
        "callbackUrl": "http://127.0.0.1:32123/callback",
        "callbackPort": 32123,
        "scopes": ["mcp:connect"]
      }
    }
  }
}
```

The client secret value must remain outside the JSON file. Put only its
environment-variable name in `clientSecretEnvVar`. An HTTPS Client ID Metadata
Document URL may be used as `clientId`; its declared callback must exactly match
Cusco's callback configuration.

## References

- [ChatGPT MCP client authentication](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
