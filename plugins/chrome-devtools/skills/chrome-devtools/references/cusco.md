# Chrome DevTools in Cusco

Use the discovered `mcp__chrome_devtools__*` tools for normal browser work.
Upstream uses bare names such as `list_pages`; in Cusco this normally appears as
`mcp__chrome_devtools__list_pages`. If another configured server owns that
namespace, use the names actually exposed by Cusco.

`mcp_server_status` with `{"server":"Chrome DevTools"}` reports connection state
and available tools. After connecting, `mcp_server_call` can invoke a discovered
tool during the same turn, for example:

```json
{"server":"Chrome DevTools","tool":"list_pages","arguments":{}}
```

Installing the plugin from **Plugins → Chrome DevTools** also configures and
connects its local MCP server. Already installed plugins are configured when the
catalog opens or an agent turn starts. There is no plugin Connect button.
If the server is disconnected, use `mcp_server_connect` or refresh **Plugins → MCP**.
Keep Agent Mode and the needed plugin skills enabled. The STDIO server does not
use an API key or OAuth. `mcp_server_configure` supports HTTP servers and is not
the setup tool for this plugin.

## Browser and tool scope

- Before the first target navigation, follow [task tab groups](task-groups.md) to
  create a new named group for this task. Add later task tabs to that same group;
  preserve other tasks' groups and the user's existing tabs.
- The preset uses Chrome DevTools MCP 1.9.0 with `--auto-connect`, extension tools,
  and memory tools. It attaches to the running Chrome Stable profile and shares
  its logins. Require Chrome 149+ for the task-group helper.
- Call `list_pages` or `new_page` to obtain a real page ID, then pass `pageId` to
  every page-scoped call. Get element UIDs from a fresh snapshot.
- On first browser use, Chrome requires remote debugging enabled at
  `chrome://inspect/#remote-debugging` and its Allow prompt accepted by the user.
  If unavailable, report the required Chrome setup; do not silently launch a
  different profile or use `isolatedContext`, which loses the user's logins.
- Use the live tool schema. In this release, Lighthouse uses `device` and
  `mode`; reload is `navigate_page` with `type: "reload"`; network resource types
  are lowercase. Lighthouse excludes performance; use performance traces for CWV.
- The preset disables MCP usage statistics and CrUX URL sharing. Report trace
  metrics as lab data, without claiming to have fetched real-user field data.
- Calls follow Cusco's permission controls. Do not route denied browser actions
  through shell commands or a separate CLI daemon. Match actions to the user's
  requested task, especially on signed-in pages.
- Keep cookie values, authorization headers, and unrelated browser data out of
  reports. Summarize relevant evidence and save large artifacts to task files.

## Configuration and files

The plugin template is copied into a workspace server during installation or
automatic setup. The original unchanged `--isolated` arguments migrate to the
new `--auto-connect` preset; custom argument lists remain unchanged.
Inspect **Plugins → MCP** before changing arguments. Workspace servers are saved
in `$XDG_DATA_HOME/io.github.stonega.Cusco/workspace.json` (normally
`~/.local/share/io.github.stonega.Cusco/workspace.json`). Quit Cusco before editing
the relevant `mcpServers` array entry so in-memory state cannot overwrite the
change; preserve its ID and unrelated records, then restart and reconnect.
**Settings → Workspace** shows the separate file-based `mcp.json` configuration.
Changing the plugin's template alone does not change an existing connection.

File tools are restricted by the server's filesystem roots. Prefer a temporary
task directory, or add `--workspace=/absolute/path/to/project` for each needed
directory. This also matters for uploading local files and loading unpacked
extensions. Do not broadly disable path restrictions to fix one rejected path.

Full setup, optional modes, prerequisites, and source provenance are in the
[plugin README](../../../README.md). The bundled CLI skill is for shell workflow
requests; it operates its own daemon and does not share this MCP session.
