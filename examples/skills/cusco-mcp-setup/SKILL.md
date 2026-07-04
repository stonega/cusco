---
name: cusco-mcp-setup
description: Use this skill whenever a user wants to configure, add, troubleshoot, document, or explain Model Context Protocol (MCP) servers for Cusco, including mcp.json, stdio servers, Streamable HTTP servers, MCP tool naming, resources, prompts, reload steps, or why Cusco is not showing an MCP tool.
---

# Cusco MCP Setup

Use this skill to help a user set up MCP servers for Cusco, the native GNOME AI chat app.

Cusco includes a compact version of this MCP setup guidance as an always-available built-in skill. Use this longer file as a reference version or when installing the same guidance into another agent.

Cusco supports MCP in Agent Mode. Enabled MCP servers are discovered into namespaced tools such as `mcp__server__tool`. Servers can also expose helper tools for resources and prompts when the server supports them.

## First Checks

Before editing anything, identify what the user is trying to connect:

- Stdio MCP server: a local command that Cusco starts, using `command`, `args`, optional `cwd`, and optional `env`.
- Streamable HTTP MCP server: a remote or local URL, using `url` and optional `headers`.
- Existing broken setup: inspect the config JSON, server command, environment variables, and Cusco reload state.

If you are working as a coding agent, respect the current filesystem sandbox and approval rules before writing outside the repo. Cusco's runtime config usually lives in the user's home config directory, not inside the project checkout.

## Runtime Paths

Cusco loads MCP servers from:

```text
~/.config/io.github.stonega.Cusco/mcp.json
```

Cusco discovers installed skills from:

```text
~/.agents/skills/<skill-id>/SKILL.md
```

The skill folder can also be registered manually from Preferences -> Skills -> Add skill folder.

## Preferred mcp.json Shape

Prefer a top-level `mcpServers` object. Cusco also accepts `servers` or a bare object/array, but `mcpServers` is the clearest format.

Stdio server example:

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "cwd": "/absolute/path/to/project",
      "env": {
        "API_KEY": "set-this-outside-git"
      },
      "enabled": true,
      "permissionPolicy": "ask"
    }
  }
}
```

Streamable HTTP server example:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer set-this-outside-git"
      },
      "enabled": true,
      "permissionPolicy": "ask"
    }
  }
}
```

Cusco infers `transport` from the config:

- `url` present means `streamable-http`.
- No `url` means `stdio`.

Only set `transport` explicitly when that helps clarity or when matching an existing config style.

## Important Fields

- `command`: executable for a stdio server. Use an absolute path or a program known to be on Cusco's `PATH`.
- `args`: command arguments for stdio servers. Use absolute paths for server files.
- `cwd`: working directory for stdio servers.
- `env`: string map of environment variables for stdio servers.
- `url`: Streamable HTTP MCP endpoint.
- `headers`: string map of HTTP headers for Streamable HTTP servers.
- `enabled`: defaults to true unless `disabled: true` is set.
- `namespace`: optional stable namespace for tool names. Cusco sanitizes names to lowercase letters, numbers, and underscores.
- `permissionPolicy`: defaults to `ask`. Use `allow` only for trusted servers with low-risk tools.

Do not commit real API keys, bearer tokens, or other secrets into the repository. For examples, use placeholders.

## Reload and Use in Cusco

After editing `mcp.json`:

1. Open Cusco Preferences.
2. Go to MCP or Workspace preferences.
3. Use the MCP config file refresh/reload action.
4. Start or continue an Agent Mode chat.
5. Look for tools named like `mcp__<namespace>__<tool>`.

If the server exposes resources, Cusco adds:

- `mcp__<namespace>__list_resources`
- `mcp__<namespace>__read_resource`

If the server exposes prompts, Cusco adds:

- `mcp__<namespace>__list_prompts`
- `mcp__<namespace>__get_prompt`

## Verification

When working inside the Cusco repo, run the focused MCP smoke test:

```sh
gjs -m tests/mcp-smoke.js
```

For a broader check, run:

```sh
scripts/check.sh
```

The smoke test uses `tests/fixtures/fake-mcp-server.js` and verifies parsing, stdio discovery, tool registration, resource helpers, prompt helpers, and tool calls.

## Troubleshooting

If Cusco does not show the MCP server or tools:

- Confirm `mcp.json` is valid JSON.
- Confirm the server entry is enabled and not marked with `disabled: true`.
- Reload the MCP config from Preferences after editing.
- For stdio, run the command and arguments manually from a terminal to catch missing executables, bad paths, or missing environment.
- Use absolute paths for local server scripts and `cwd`.
- For HTTP, confirm the URL is the MCP endpoint and required headers are present.
- Set a simple `namespace` if generated tool names are confusing or collide.
- Keep `permissionPolicy: "ask"` while diagnosing so tool calls remain visible and auditable.

## Response Pattern

When helping a user set up MCP for Cusco, include:

1. The exact config path to edit.
2. A minimal `mcpServers` JSON block tailored to their server.
3. How to reload the config in Cusco.
4. How the resulting tool names will look.
5. A verification step, using `gjs -m tests/mcp-smoke.js` only when the user is working in the Cusco repo.
