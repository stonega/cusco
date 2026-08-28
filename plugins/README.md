# Cusco plugins

Cusco installs marketplace plugins into this directory. Each installed plugin
uses `plugins/<plugin-name>/` and must contain a
`.cusco-plugin/plugin.json` manifest. Ported plugins may retain the compatible
`.codex-plugin/plugin.json` source manifest.

The repository marketplace index at `.agents/plugins/marketplace.json` is kept
in sync with installs and removals. Do not place unrelated files inside an
installed plugin directory.
