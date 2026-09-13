---
name: chrome-devtools-troubleshooting
description: Uses Chrome DevTools MCP and documentation to troubleshoot connection and target issues. Trigger this skill when list_pages, new_page, or navigate_page fail, or when the server initialization fails.
---

<!-- Adapted for Cusco; see ../../NOTICE. -->

## Using this skill in Cusco

Use Cusco’s connected `mcp__chrome_devtools__*` tools for browser tasks; the
CLI skill applies to shell automation requests. Read the [Cusco connection guide](../chrome-devtools/references/cusco.md) for connection status, tool routing, saved configuration,
and optional features. Before target navigation, create a new named Chrome tab
group for the task using that guide; add subsequent task tabs to the same group.
Use the live tool schema when an upstream example differs.

## Troubleshooting Wizard

You are acting as a troubleshooting wizard to help the user configure and fix their Chrome DevTools MCP server setup. When this skill is triggered (e.g., because `list_pages`, `new_page`, or `navigate_page` failed, or the server wouldn't start), follow this step-by-step diagnostic process:

### Step 1: Find and Read Configuration

Start with `mcp_server_status` for `Chrome DevTools`, or inspect **Plugins → MCP**.
Cusco creates this plugin's connection as a **workspace** server. Inspect only its
`mcpServers` array entry in `$XDG_DATA_HOME/io.github.stonega.Cusco/workspace.json`
(`~/.local/share/io.github.stonega.Cusco/workspace.json` by default): command,
args, enabled state, and allowlist. Quit Cusco before editing this file to avoid
overwriting its in-memory state, then restart and reconnect. Direct file
servers can also be declared in `$XDG_CONFIG_HOME/io.github.stonega.Cusco/mcp.json`
(`~/.config/io.github.stonega.Cusco/mcp.json` by default). The plugin's `.mcp.json`
is the template, not the active saved connection. Do not replace the workspace
or unrelated servers, read Secret Service credentials, or ask the user to paste
unredacted configuration.

Check Node.js and npx availability in Cusco's inherited PATH, invalid arguments,
missing category flags, and incompatible `--isolated` / `--auto-connect` options.
If a required setting is still unknown, ask only for that missing non-secret value.

### Step 2: Triage Common Connection Errors

Before reading documentation or suggesting configuration changes, check if the error message matches one of the following common patterns.

#### Error: `Could not find DevToolsActivePort`

This error is highly specific to the `--autoConnect` feature. It means the MCP server cannot find the file created by a running, debuggable Chrome instance. This is not a generic connection failure.

Check whether the intended Chrome channel is running and whether the setup
already establishes that remote debugging is enabled. If a user action is still
needed, direct them to `chrome://inspect/#remote-debugging` to enable remote
debugging and accept Chrome's connection dialog. Retry `list_pages` as the
smallest connection check. If it still fails after these prerequisites are met,
inspect the specific timeout or sandbox error before changing connection modes.

#### Symptom: Server starts but creates a new empty profile

The Cusco preset should attach to the user's running Chrome profile. Check the
saved arguments for an old `--isolated` flag or a custom profile. Use
`--auto-connect` for existing logins and avoid `isolatedContext` on task tabs.

- **Check for flag typos:** For example, `--autoBronnect` instead of `--autoConnect`.
- **Verify the configuration:** Ensure the arguments match the expected flags exactly.

#### Symptom: Missing tools

If the server starts but only a subset of tools is available, inspect the
discovered names and configuration before assuming the cause.

In Cusco, check Agent Mode, the server's enabled state and tool allowlist,
category flags, and whether `--slim` is set. Inspect status and refresh the MCP
connection. Keep existing permission choices; missing tools are not a reason to
change the permission policy to allow or bypass a denied tool through the CLI.

#### Symptom: Extension tools are missing or extensions fail to load

If the tools related to extensions (like `install_extension`) are not available, or if the extensions you load are not functioning:

1. **Check for the `--categoryExtensions` flag**: Ensure this flag is passed in the MCP server configuration to enable the extension category tools.
2. **Check Chrome is 149 or newer**: Earlier versions cannot load extensions when connecting to an existing instance (`--auto-connect`, `--browserUrl`). Update Chrome for the preset's signed-in profile and task-group workflow. Do not switch to a blank profile without the user's request.

#### Other Common Errors

Identify other error messages from the failed tool call or the MCP initialization logs:

- `Target closed`
- "Tool not found" (check if they are using `--slim` which only enables navigation and screenshot tools).
- Missing `pageId`: Page-scoped tools require a `pageId` argument. Call `list_pages` to find active page IDs.
- `ProtocolError: Network.enable timed out` or `The socket connection was closed unexpectedly`
- `Error [ERR_MODULE_NOT_FOUND]: Cannot find module`
- Any sandboxing or host validation errors.

### Step 3: Read Known Issues

Read the contents of https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md to map the error to a known issue. Pay close attention to:

- Sandboxing restrictions (macOS Seatbelt, Linux containers).
- WSL requirements.
- `--autoConnect` handshakes, timeouts, and requirements (requires **running** Chrome 144+).

### Step 4: Formulate a Configuration

Based on the exact error and the user's environment (OS, MCP client), formulate the correct MCP configuration snippet. Check if they need to:

- Pass `--browser-url=http://127.0.0.1:9222` instead of `--autoConnect` (e.g. if they are in a sandboxed environment like Claude Desktop).
- Enable remote debugging in Chrome (`chrome://inspect/#remote-debugging`) and accept the connection prompt. **Ask the user to verify this is enabled if using `--autoConnect`.**
- Add `--logFile <absolute_path_to_log_file>` to capture debug logs for analysis.
- If the first connection times out while npx downloads the package, finish the
  pinned `--help` diagnostic below and refresh Plugins → MCP or call
  `mcp_server_connect`. Cusco does not use Codex settings.

If a configuration detail remains unknown, ask for that specific non-secret setting.

### Step 5: Run Diagnostic Commands

If the issue is still unclear, run diagnostic commands to test the server directly:

- Run `npx -y chrome-devtools-mcp@1.9.0 --help` to verify the installation and Node.js environment.
- For server logs, add `--log-file=/absolute/path/to/debug.log` and `DEBUG=*`
  to the existing server configuration, restart Cusco, and reproduce once.
  Remove temporary debug settings afterward; do not expose sensitive log contents.

### Step 6: Check GitHub for Existing Issues

If https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md does not cover the specific error, check if the `gh` (GitHub CLI) tool is available in the environment. If so, search the GitHub repository for similar issues:
`gh issue list --repo ChromeDevTools/chrome-devtools-mcp --search "<error snippet>" --state all`

Alternatively, you can recommend that the user checks https://github.com/ChromeDevTools/chrome-devtools-mcp/issues and https://github.com/ChromeDevTools/chrome-devtools-mcp/discussions for help.
