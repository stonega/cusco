# Chrome DevTools plugin

Chrome DevTools is a predefined Cusco plugin with the official local MCP server
and all seven upstream skills. The server and skills are pinned to **1.9.0**.

## Use in Cusco

1. Install a supported Node.js LTS release, npm (including `npx`), and current
   stable Google Chrome **149 or newer** for auto-connect with the tab-group helper.
   Version 1.9.0 declares Node.js support as
   `^20.19.0 || ^22.12.0 || >=23`; prefer a maintained LTS release.
2. Open **Plugins → Chrome DevTools** and select **Install**. Installation also
   configures and connects the MCP server. If the plugin is already installed,
   Cusco configures it automatically when the catalog opens
   or an agent turn starts. This plugin has no Connect button because it needs
   no account authentication.
3. In your running, signed-in Chrome, open `chrome://inspect/#remote-debugging`
   and enable remote debugging. Keep the intended Chrome profile open.
4. Enable **Agent Mode** and **Skills** in the chat. Ask Cusco to inspect a URL
   or check its performance, then accept Chrome's **Allow** prompt.

Cusco launches `npx -y chrome-devtools-mcp@1.9.0` over STDIO. The first connection
may download the package into npm's cache; it needs registry access. There is no
API key, hosted proxy, OAuth client, or separate global MCP installation.
The browser connection begins when a browser tool is used. Chrome's Allow prompt
is separate from installing or starting the MCP server.

The preset uses `--auto-connect` to attach to your running Chrome Stable profile,
including its existing logins. It does not launch an empty or incognito profile.
Chrome must be running with remote debugging enabled. It enables browser, network, emulation,
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
alone. This workflow requires Skills, the preset's extension tools, and Chrome
149+ for loading the helper into an attached browser. A mode that cannot load the
helper must report that limitation instead of silently browsing without groups.

See the [task grouping workflow](skills/chrome-devtools/references/task-groups.md).
Run `gjs -m tests/chrome-devtools-plugin-smoke.js --live` from the source repository
to verify attachment to an existing test Chrome profile, two separate tasks,
same-task tab reuse, and retained profile state after reconnecting. The test starts
its own headless Chrome and never attaches to your personal browser. This optional
check downloads the pinned MCP package if needed;
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

The plugin's `.mcp.json` supplies defaults during installation or automatic setup.
Saved connections with the original, unchanged `--isolated` argument list upgrade
to `--auto-connect`. Custom argument lists retain their saved configuration.
Use **Plugins → MCP** to inspect the connection. Quit Cusco before editing its saved workspace at
`$XDG_DATA_HOME/io.github.stonega.Cusco/workspace.json` (normally
`~/.local/share/io.github.stonega.Cusco/workspace.json`). Edit only that server's
`args` in the `mcpServers` array, preserving its ID and other records, then start
Cusco and reconnect. Editing the plugin's template alone does not update a saved
connection. **Settings → Workspace** exposes the separate file-based `mcp.json`
configuration, which is not where this plugin's workspace server is saved.

| Need | Change to the server arguments |
| --- | --- |
| Fresh test profile | Replace `--auto-connect` with `--isolated` |
| Background test browser | Replace `--auto-connect` with `--isolated`, add `--headless` |
| Keep a dedicated testing profile | Replace `--auto-connect` with `--user-data-dir=/absolute/path/to/test-profile` |
| Custom Chrome binary/channel | For attachment, add `--channel=beta`; for a server-launched browser, remove `--auto-connect` before adding `--executable-path=/absolute/path/to/chrome` |
| Manually started debugging browser | Replace `--auto-connect` with `--browser-url=http://127.0.0.1:9222`; start Chrome with that debugging port and a separate `--user-data-dir` |
| Page-defined developer tools | Add `--category-experimental-third-party` |
| Screencasting | Add `--experimental-screencast` and install `ffmpeg` |
| PWA lifecycle tools | Add `--category-pwa` when the server launches Chrome |
| File output or extension loading outside temporary storage | Add `--workspace=/absolute/path/to/project` for each needed directory |

Only use auto-connect when you intend to expose the selected Chrome profile,
including its signed-in pages. Chrome 144+ supports auto-connect; Chrome 149+
is required to load extensions over that connection and create task groups.
Do not disable the Chrome sandbox or certificate verification as a default fix.

## Troubleshooting

- **Command not found:** Cusco must inherit a `PATH` containing Node.js and
  `npx`. Desktop launchers may not load nvm's shell setup. Test from a terminal
  where `node --version` and `npx -y chrome-devtools-mcp@1.9.0 --help` work, then
  launch Cusco from that terminal or configure the desktop environment's PATH.
- **MCP connected but Chrome unavailable:** Run `list_pages` to test attachment.
- **Startup failed:** Fix the reported prerequisite, then retry the task or use
  **Plugins → MCP → Refresh MCP servers**. Chrome DevTools has no plugin Connect button.
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
