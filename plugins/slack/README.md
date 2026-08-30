# Slack plugin

This plugin connects Cusco to Slack's official hosted MCP server at
`https://mcp.slack.com/mcp`.

Slack currently requires an internal or Slack Marketplace app. Add the fixed
callback URL `http://localhost:32119/callback` and the user-token scopes listed
in `.mcp.json` to that app, then paste its Client ID into Cusco's connection
dialog. Cusco performs OAuth with PKCE and stores resulting credentials in the
desktop Secret Service.

Every MCP action remains subject to Cusco's permission prompt. The bundled
skill requires read-first targeting, protects private workspace context, and
requires explicit review for consequential or broadcast writes.
