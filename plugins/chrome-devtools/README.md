# Chrome DevTools plugin

Chrome DevTools is a predefined Cusco plugin with the official local MCP server
and all seven upstream skills. The server and skills are pinned to **1.9.0**.

## Connect in Cusco

1. Install a supported Node.js LTS release, npm (including `npx`), and current
   stable Google Chrome. Version 1.9.0 declares Node.js support as
   `^20.19.0 || ^22.12.0 || >=23`; prefer a maintained LTS release.
2. Open **Plugins → Chrome DevTools** and select **Connect**. If the plugin is
   listed as available, select **Install** first.
3. Enable **Agent Mode** and **Skills** in the chat. Ask Cusco to inspect a URL
   or check its performance.

Cusco launches `npx -y chrome-devtools-mcp@1.9.0` over STDIO. The first connection
may download the package into npm's cache; it needs registry access. There is no
API key, hosted proxy, OAuth client, or separate global MCP installation.
Chrome opens only when a browser tool is used, so a successful **Connect** does
not itself open a window.

The preset starts a visible Chrome window with a temporary profile, cleaned up
when that browser closes. It enables the normal browser, network, emulation,
performance, and Lighthouse tools plus extension and memory debugging tools.
It does not use slim mode. Experimental third-party tools, WebMCP, screencasting,
vision, and PWA management remain optional.

## Task tab groups

The skills create a **new named Chrome tab group for each browser task**, then
keep that task's new tabs in the same group. Follow-ups reuse the task's group;
unrelated tasks get a fresh group. Groups remain available for review afterward.

Because the upstream MCP has no tab-group tool, the plugin includes a small
**Cusco Task Groups** extension. The agent stages it in temporary storage and
loads it into the MCP browser through `install_extension`. Its local page groups
only the new tab it runs in before that tab navigates to the target URL. It
requests only `tabGroups` permission and contains no background worker, content
script, host access, or network code. Existing tabs and other groups are left
alone. This workflow requires Skills and the preset's extension-enabled,
server-launched Chrome connection; a mode that cannot load the helper must report
that limitation instead of silently browsing without groups.

See the [task grouping workflow](skills/chrome-devtools/references/task-groups.md).
Run `gjs -m tests/chrome-devtools-plugin-smoke.js --live` from the source repository
to verify two separate tasks and same-task tab reuse in a temporary headless
Chrome profile. This optional check downloads the pinned MCP package if needed;
the normal smoke test is offline.

Browser tools can read and change content in the connected session. Cusco keeps
MCP tool calls on its normal permission path. The preset disables MCP usage
statistics and sending trace URLs to Google's CrUX API; this does not change
Chrome's own telemetry preferences or the website's network traffic. Performance
traces still provide local lab measurements, without CrUX field data.

## Included skills

| Skill | Purpose |
| --- | --- |
| `chrome-devtools` | Browser navigation, snapshots, screenshots, debugging, and extension testing |
| `chrome-devtools-a11y-debugging` | Lighthouse, semantics, keyboard focus, labels, and contrast |
| `chrome-devtools-debug-optimize-lcp` | Performance traces, LCP subparts, and verified optimizations |
| `chrome-devtools-cookie-debugging` | Sessions, cookie attributes, authentication, and consent testing |
| `chrome-devtools-memory-leak-debugging` | Heap comparisons, retainers, detached nodes, and memory cleanup |
| `chrome-devtools-troubleshooting` | Cusco connection diagnostics and Chrome launch problems |
| `chrome-devtools-cli` | Optional shell automation using the upstream CLI |

The CLI skill is included for script requests. The preset uses MCP; the CLI
runs a separate background daemon and does not share Cusco's MCP connection.
See its bundled installation reference before using it.

## Customize the connection

The plugin's `.mcp.json` supplies defaults when **Connect** creates the workspace
server. Existing connections retain their saved configuration. Use **Plugins →
MCP** to inspect the connection. Quit Cusco before editing its saved workspace at
`$XDG_DATA_HOME/io.github.stonega.Cusco/workspace.json` (normally
`~/.local/share/io.github.stonega.Cusco/workspace.json`). Edit only that server's
`args` in the `mcpServers` array, preserving its ID and other records, then start
Cusco and reconnect. Editing the plugin's template alone does not update a saved
connection. **Settings → Workspace** exposes the separate file-based `mcp.json`
configuration, which is not where this plugin's workspace server is saved.

| Need | Change to the server arguments |
| --- | --- |
| Background browser | Add `--headless` |
| Keep a dedicated testing profile | Replace `--isolated` with `--user-data-dir=/absolute/path/to/test-profile` |
| Custom Chrome binary/channel | Add `--executable-path=/absolute/path/to/chrome` or `--channel=beta` |
| Existing Chrome session | Remove `--isolated` and `--category-extensions`, add `--auto-connect`; requires Chrome 144+, remote debugging enabled at `chrome://inspect/#remote-debugging`, and Chrome's Allow dialog |
| Manually started debugging browser | Remove `--isolated` and `--category-extensions`, add `--browser-url=http://127.0.0.1:9222`; start Chrome with that debugging port and a separate `--user-data-dir` |
| Page-defined developer tools | Add `--category-experimental-third-party` |
| Screencasting | Add `--experimental-screencast` and install `ffmpeg` |
| PWA lifecycle tools | Add `--category-pwa` when the server launches Chrome |
| File output or extension loading outside temporary storage | Add `--workspace=/absolute/path/to/project` for each needed directory |

Only use auto-connect when you intend to expose the selected Chrome profile,
including its signed-in pages. Extension tooling in this release is documented
for a server-launched browser over a pipe; use that mode for extension testing.
Do not disable the Chrome sandbox or certificate verification as a default fix.

## Troubleshooting

- **Command not found:** Cusco must inherit a `PATH` containing Node.js and
  `npx`. Desktop launchers may not load nvm's shell setup. Test from a terminal
  where `node --version` and `npx -y chrome-devtools-mcp@1.9.0 --help` work, then
  launch Cusco from that terminal or configure the desktop environment's PATH.
- **Connected but no browser:** Run `list_pages` to test browser launch.
- **Missing Chrome / Target closed:** Verify Chrome can run in the same desktop
  session. Use the executable-path option for a nonstandard installation.
- **Missing tools:** Check Agent Mode, the server's enabled state and tool
  allowlist, and category flags. Refresh MCP tools after changing configuration.
- **Auto-connect fails:** Start the intended Chrome channel, enable remote
  debugging, accept Chrome's prompt, then retry `list_pages`.
- **Need logs:** Temporarily add `--log-file=/absolute/path/to/debug.log` and
  `DEBUG=*` in that server's environment. Treat logs, cookies, network bodies,
  and heap snapshots as potentially sensitive.

## Sources and maintenance

The complete Chrome agents documentation was reviewed on 2026-09-13:
[get started](https://developer.chrome.com/docs/devtools/agents/get-started),
[configuration](https://developer.chrome.com/docs/devtools/agents/get-started/configuration),
[auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect),
[emulation](https://developer.chrome.com/docs/devtools/agents/use-cases/emulation),
[Lighthouse](https://developer.chrome.com/docs/devtools/agents/use-cases/lighthouse-audit),
[third-party tools](https://developer.chrome.com/docs/devtools/agents/use-cases/third-party-tools),
and [extensions](https://developer.chrome.com/docs/devtools/agents/extensions),
plus the upstream README and full `docs/` directory, including the tool reference,
CLI, client setup, advanced usage, Android, and troubleshooting guides.

Bundled skills and reference files come from
[`chrome-devtools-mcp-v1.9.0`](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/chrome-devtools-mcp-v1.9.0/skills),
commit `1cec9cd1a3bbf1895c98fa4b4e0e2da5a36e4075`, under [Apache 2.0](LICENSE).
See [NOTICE](NOTICE) for the Cusco adaptations. Update the server version and
skill snapshot together and verify against the published package's tool schemas;
the website and repository main branch can describe newer APIs than the release.
