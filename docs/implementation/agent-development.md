# Agent Development

This document distills the agent-harness patterns from `/home/stone/Web/learn-claude-code` into a development guide for Cusco.

Cusco should treat the model as the agent and the application as the harness: the native GNOME shell provides context, tools, memory, permissions, and provider access. Avoid encoding brittle workflows when a clearer capability, better context, or stronger permission boundary would let the model reason through the task.

## Current Cusco Harness

Cusco already has the first useful pieces of an agent harness:

- Conversation state in `src/chat/conversation.js`.
- Provider abstraction in `src/providers/provider.js`.
- Provider adapters in `src/providers/remoteProvider.js`.
- Slash-command tools in `src/tools/tools.js`.
- Provider-neutral Agent Mode prompt and tool-call parsing in `src/chat/agentMode.js`.
- Central tool permission decisions in `src/tools/permissions.js`.
- Explicit memory controls in `src/memory/memory.js`.
- Local SKILL.md discovery and injection in `src/skills/skills.js`.
- Workspace records for prompts, profiles, plugin tools, MCP server configs, and cache entries in `src/workspace/workspace.js`.
- Native GTK orchestration in `src/window.js`.

The core runtime path is:

1. `_sendMessage()` appends the user message, proposes memory when relevant, runs an explicit slash-command tool if requested, then starts a provider response.
2. `_streamAssistantResponse()` injects visible memory context, loads selected skills as hidden provider context, builds provider messages, streams the selected provider, optionally falls back to another provider, then persists the assistant message.
3. Provider classes normalize Cusco messages into each remote API format. Remote providers currently request the full response and then stream display chunks; true network streaming remains a planned improvement.

When `agentModeEnabled` is set on a conversation, Cusco adds an Agent Mode system prompt and lets the model request one existing tool at a time with a `<cusco_tool_call>` JSON tag. Cusco validates the request, applies permissions, appends visible tool audit rows, feeds the result back to the model, and repeats until the model returns final text or the iteration limit is reached.

Current built-in tools are `calc`, `data`, `search`, `file_list`, `file_read`, and `bash`. Search, file access, and bash are approval-gated. File reads are size-limited, file listings are item-limited, bash has a timeout and bounded stdout/stderr, and sensitive home-directory paths such as SSH keys, GnuPG data, keyrings, and browser profiles are blocked.

Keep this path boring and explicit. Most agent features should attach around it, not replace it.

## Design Principles

- Start with the smallest useful capability. Add a tool or subsystem only when real workflows fail without it.
- Keep tools atomic and composable. A tool should do one observable action and return a concise result.
- Put provider-specific behavior behind provider adapters. The UI and chat engine should not know an API's wire format.
- Load knowledge on demand. Skills, profile prompts, and reference material should be discoverable before they are injected.
- Make memory visible and user-controlled. Memory writes need approval; memory reads should leave an audit trail in the transcript or local usage log.
- Put permission checks before side effects. Network, filesystem, shell, and external service actions need clear deny/allow behavior.
- Preserve context quality. Truncate, summarize, or isolate noisy outputs rather than dumping them into the main conversation.
- Prefer native GNOME surfaces. Agent controls should feel like part of the app, not a web workflow embedded in GTK.

## Component Responsibilities

| Area | Current home | Development direction |
|---|---|---|
| Agent loop | `src/window.js` | Move orchestration toward a chat engine module when tool calling, retries, compaction, and background tasks grow beyond UI concerns. |
| Providers | `src/providers/` | Keep a single async iterator contract and provider/model capability metadata. Add true streaming and tool-call response support here. |
| Tools | `src/tools/tools.js` | Replace slash-only parsing with provider-visible tool definitions when model tool calling is implemented. Keep slash commands as a deterministic user shortcut. |
| Permissions | `src/window.js`, `src/tools/tools.js` | Centralize permission policy before adding file, shell, browser, or MCP tools. Deny destructive actions by default; ask for external or risky actions. |
| Skills | `src/skills/skills.js`, `src/workspace/workspace.js` | Keep progressive disclosure: list available skills, then inject selected SKILL.md content only when relevant or user-selected. |
| Memory | `src/memory/memory.js` | Keep approval and audit behavior. Improve selection and extraction before adding autonomous memory writes. |
| Tasks | not implemented | Add a persisted task graph separately from transient todos. Use it for long-running goals, dependencies, and resumable work. |
| Background work | partially notification-only | Run slow or external work outside the active UI path and inject completion notifications back into the conversation. |
| MCP/plugins | MCP implemented for Agent Mode; plugins are descriptors | MCP servers are loaded from settings or `mcp.json`, discovered into namespaced tools, and routed through the existing permission and transcript audit path. |

## Tool Development Rules

When adding a tool, define:

- `name`: stable, short, and unique.
- `label`: user-visible name for dialogs and transcripts.
- `input schema`: what the model or slash command must provide.
- `permission policy`: `allow`, `ask`, or `deny`, with the reason.
- `run` behavior: side effects, timeout, cancellation, and error surface.
- `transcript result`: concise summary that helps the next model turn.
- tests for parsing, execution, permission metadata, failure output, and transcript formatting.

Do not return unbounded output. Large results should be summarized, stored separately, or represented with a handle that can be expanded later.

## Memory Development Rules

Memory should remain explicit:

- Propose memory from user-visible signals or an extraction pass.
- Ask before storing new user memory.
- Let users search, edit, disable, pin, delete, import, and export memories.
- Record when memory is used for a response.
- Distinguish user memory from session state and task state.

Do not hide memory injection inside provider prompts without a visible audit path.

## Skill Development Rules

Cusco skills are local knowledge packs. They should be treated as optional context, not global prompt bloat.

Good skill behavior:

- Discover installed skills without loading every byte into every response.
- Show name, description, path, enabled state, and load errors.
- Select skills per chat, with profile defaults later.
- Inject selected skill content as hidden system context.
- Cap SKILL.md size and surface load errors clearly.

Future improvement: split skill metadata from full content in the provider prompt. The model can first see available skills, then request a specific skill body when needed.

## Permission Model

Use a policy pipeline before any side effect:

1. Normalize the requested action.
2. Validate input shape and path/service boundaries.
3. Classify the action as safe, external, sensitive, or destructive.
4. Deny clearly unsafe actions.
5. Ask the user before external, sensitive, or destructive actions.
6. Execute with timeout and cancellation.
7. Persist an auditable result.

Search already follows the seed of this model by asking before sending a query to DuckDuckGo. File writes, shell commands, browser automation, MCP tools, and plugin commands should go through the same centralized policy.

## Context Management

Context is a runtime budget, not an append-only log. Add context controls in this order:

1. Estimate usage, which Cusco already does in `src/chat/usage.js`.
2. Trim or summarize oversized tool results.
3. Truncate attached files with a visible marker, which Cusco already does for local file attachments.
4. Add conversation compaction summaries for old turns.
5. Persist large artifacts outside the provider prompt and pass compact references.
6. Isolate exploratory work in subagents or background jobs when it would pollute the main thread.

Compaction must preserve user instructions, current goal, decisions, pending tasks, tool results that matter, and unresolved errors.

## Roadmap

### Stage 1: Harden the Single-Agent Harness

- Move response orchestration out of `CuscoWindow` into a chat engine service.
- Add true provider streaming for remote APIs.
- Extend provider capability metadata beyond model/thinking support: streaming, tool calls, vision, system prompt support, max context.
- Centralize permission checks and audit records.
- Improve tool result size limits and summaries.

### Stage 2: Model-Visible Tools

- Define a provider-neutral tool schema.
- Let capable providers request tool calls directly.
- Keep slash commands as user-forced tools.
- Execute multiple safe tool calls concurrently only when tools declare that they are concurrency-safe.
- Feed tool results back into the same provider loop until the model returns final text.

### Stage 3: Runtime Prompt Assembly

- Build a prompt assembler for base app instructions, active profile, memory, selected skills, active tools, attachment summaries, and workspace state.
- Cache stable prompt sections per conversation.
- Keep provider adapters responsible for mapping assembled system/developer/user content into provider-specific formats.

### Stage 4: Tasks and Background Work

- Add a local task graph with `pending`, `in_progress`, `blocked`, and `completed` states.
- Support dependencies and one active owner per task.
- Run slow tools or long commands in background jobs.
- Inject completion, failure, and timeout notifications into the conversation.
- Persist enough state to resume after app restart.

### Stage 5: Subagents and Isolation

- Use subagents for noisy exploration, comparison, or long analysis.
- Give subagents scoped context, scoped tools, and read-only defaults.
- Bubble permission requests back to the main session.
- Return concise reports, not full transcripts.

### Stage 6: MCP and Plugin Tools

- Discover MCP tools, resources, and prompts from enabled workspace and config-file server configs.
- Namespace external tools, for example `mcp__server__tool`.
- Merge built-in, plugin, and MCP tools into one Agent Mode tool pool.
- Apply the same permission pipeline to external tools.
- Track connection status and surface failures in settings and transcripts.
- Future work: map this tool pool to provider-native tool-call APIs once provider capability metadata covers tool-call support.

### Stage 7: Multi-Agent Workflows

- Add this only after tasks, permissions, and isolation are solid.
- Use task records as the coordination source.
- Give each worker a clear role, bounded tools, and isolated workspace state.
- Use a structured request/reply protocol for coordination.
- Avoid hidden autonomous changes to user files.

## Testing Checklist

For every agent capability, add or update smoke tests that cover:

- importability through `gjs -m tests/import-smoke.js`;
- pure parsing or normalization logic;
- success and failure paths;
- cancellation or timeout behavior when applicable;
- persistence round trips for conversation, workspace, memory, or task state;
- transcript/audit messages for user-visible operations;
- provider payload mapping when provider messages change.

Use `scripts/check.sh` for the fast local smoke pass.

## Implementation Standard

Agent development in Cusco should keep a simple invariant:

> The model decides what to do; Cusco provides safe, inspectable ways to observe, act, remember, and recover.

If a change makes the loop harder to reason about, adds hidden state, or bypasses user-visible permission and memory controls, it is probably the wrong layer for the feature.
