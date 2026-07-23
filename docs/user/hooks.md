# Lifecycle Hooks

Cusco hooks run reviewed local commands at defined points in a chat turn. They can add provider context, reject a prompt, block or rewrite a tool call, decide a pending permission request, react to tool output, stop context compaction, or request another response pass.

Hooks run with your user account. A command can read the prompt or tool data sent to it, access local files available to Cusco, and use the network. Cusco therefore skips every new or changed hook until you review and trust its exact definition in **Settings → Hooks**.

## Configuration locations

Cusco discovers JSON hook files from:

- `~/.config/io.github.stonega.Cusco/hooks.json`
- `<chat working directory>/.cusco/hooks.json`

Choose the active chat's working directory in **Settings → Hooks**. Cusco does not infer a project from the directory where the application happened to start, and it does not discover hooks from Codex configuration directories.

If both Cusco files exist, matching hooks from both files run. Hooks in one file do not replace hooks in the other.

## Example

```json
{
  "description": "Local checks for this workstation.",
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 /home/me/.local/lib/cusco/check_prompt.py",
            "timeout": 30,
            "statusMessage": "Checking prompt"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 /home/me/.local/lib/cusco/check_command.py",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Each command receives one JSON object on standard input and runs with the chat working directory as its current directory. If no working directory is selected, user hooks run from Cusco's process directory and no workspace hook file is loaded.

Only synchronous `command` handlers are executable. Unsupported handler types and invalid matchers remain visible in Settings but are skipped.

## Supported events

| Event | When it runs |
|---|---|
| `SessionStart` | Before the first hook-enabled turn for a chat runtime |
| `UserPromptSubmit` | Before a prompt is stored or sent |
| `PreToolUse` | Before a built-in or MCP tool permission decision and side effect |
| `PermissionRequest` | When Cusco would otherwise show a tool approval dialog |
| `PostToolUse` | After a tool returns a result or error |
| `PreCompact` | Before automatic context compaction |
| `PostCompact` | After compacted messages are stored |
| `Stop` | After an assistant response, before the turn finishes |

Shell tools match the canonical name `Bash`. Other built-in tools keep their Cusco names, and MCP tools use names such as `mcp__server__tool`. Provider-hosted tools are not local Cusco tool calls and do not trigger tool hooks.

All matching commands for one event are started concurrently. A denial wins over an allow when permission hooks disagree. Rewritten tool input is passed through Cusco's normal tool lookup and permission policy before execution.

## Inputs and outputs

Common input fields include:

- `session_id` and `conversation_id`
- `turn_id` for turn-scoped events
- `cwd`
- `hook_event_name`
- `model` and `provider_id`
- `permission_mode`
- `agent_mode`

Event-specific fields follow the OpenAI Hooks command protocol. For example, `UserPromptSubmit` receives `prompt`; tool events receive `tool_name`, `tool_input`, and a tool-use identifier; compaction receives `trigger`; and `Stop` receives `last_assistant_message` plus `stop_hook_active`.

A command may exit successfully with no output. Events that accept additional context can return plain text or the documented JSON `hookSpecificOutput.additionalContext` shape. Exit status `2` blocks prompts and pre-tool calls, supplies post-tool feedback, or requests a Stop continuation where applicable.

Cusco bounds command output before it reaches the model. Larger output is stored in a private temporary file and the path is made available to the turn. Avoid returning secrets: hook output may appear in model context or the hook inspector.

## Trust and failure behavior

The Hooks page shows every discovered definition, its source, matcher, command, timeout, trust state, and most recent result. Trust is tied to a fingerprint of the source path and executable definition. Changing the command, matcher, event, timeout, or status message creates an untrusted definition that is skipped until reviewed.

Hooks can be disabled individually or globally. A command timeout, non-special nonzero exit, malformed output, or unsupported output field is recorded as a hook failure and normally leaves the underlying Cusco operation unchanged. Stop continuations are limited to three passes per turn to prevent an accidental infinite loop.
