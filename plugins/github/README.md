# GitHub plugin for Cusco

This directory ports the OpenAI GitHub plugin manifest at version `0.1.11` for
Cusco. Cusco ignores the hosted connector IDs in `.app.json` and connects
directly to the declared GitHub MCP endpoint in `.mcp.json`.

The manifest and icon are derived from
<https://github.com/openai/plugins/tree/main/plugins/github>, where the plugin
declares the MIT license. The icon references use the bundled symbolic SVG so
the plugin remains readable in GNOME light and dark themes.
