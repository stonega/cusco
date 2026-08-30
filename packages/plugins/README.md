# Plugins

Reusable, standalone plugin discovery and lifecycle support for Cusco.

`client.js` reads `$REPO_ROOT/.agents/plugins/marketplace.json` directly and
enriches each entry from its plugin manifest. Installation is Cusco-owned: the
complete selected plugin is copied into `$REPO_ROOT/plugins/<name>/` and
validated before activation. Removal affects only that repository-local copy.

Connector declarations are matched to plugin-provided MCP server definitions.
Cusco also discovers a root `.mcp.json` in compatible ported plugins when the
main manifest does not declare `mcpServers`, matching the OpenAI plugin package
layout. A declared bearer-token environment variable can be satisfied either
from Cusco's process environment or through the native Connect dialog; dialog
credentials are stored in Secret Service and never copied into workspace data.
Cusco creates its own workspace MCP configuration, connects with the native MCP
client, performs OAuth discovery and PKCE locally when required, and stores
tokens in Secret Service. Legacy app IDs in ported manifests are never sent to
OpenAI; an app-only plugin instead asks the user for its MCP endpoint.
Removing a plugin also removes the workspace MCP connector and Secret Service
credential that Cusco created for it. Independently configured `mcp.json`
servers are left untouched.

Source runs infer `$REPO_ROOT` from the module location. Packaged development
runs can set `CUSCO_REPOSITORY_ROOT` explicitly to point at the writable Cusco
repository they should manage.

GTK presentation belongs in `src/chat/pluginsPage.js`; this package stays
independent of application windows and widgets.
