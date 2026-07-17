# Cusco Architecture

Cusco starts as a standalone native GNOME application.

## Layers

- Shell: GJS application lifecycle, actions, shortcuts, preferences, and windows.
- UI: GTK 4 and libadwaita widgets for sidebar navigation, transcript, composer, settings, and tool results.
- Chat engine: conversation state, streaming response coordination, retry/branch behavior, and transcript persistence.
- Provider layer: one interface for OpenAI, Anthropic, Gemini, DeepSeek, Grok, and custom OpenAI-compatible APIs.
- Memory layer: user-approved memory extraction, memory lookup, and memory management.
- Skill layer: local SKILL.md discovery, metadata persistence, and provider-context assembly.
- Tool layer: web search, file context, calculations, and namespaced MCP tools.
- Workspace layer: prompt library, agent profiles, folders, tags, export, local cache, plugin tools, and user-managed MCP server configs.
- Storage layer: local conversations, memory, workspace database, and Secret Service for credentials.

## Initial Structure

- `src/main.js`: process entry point.
- `src/application.js`: GNOME application lifecycle and actions.
- `src/searchProvider.js`: GNOME Shell SearchProvider2 implementation backed by persisted conversations.
- `src/window.js`: first window and chat shell.
- `src/chat/conversation.js`: conversation manager for chat creation, active selection, titles, archive/delete/search, provider/model assignment, and messages.
- `src/chat/markdown.js`: small markdown-to-Pango parser plus fenced code block splitting.
- `src/chat/messageView.js`: transcript message renderer with markdown labels, GtkSourceView code blocks, and code copy actions.
- `src/chat/usage.js`: approximate transcript usage estimator for composer context display.
- `src/memory/memory.js`: user-approved memory proposal, lookup, management, import/export, and audit logic.
- `src/mcp/config.js`: MCP server config normalization and `mcp.json` loading.
- `src/mcp/client.js`: dependency-free MCP JSON-RPC client for stdio and Streamable HTTP transports.
- `src/mcp/manager.js`: MCP server discovery, tool/resource/prompt registration, status tracking, and ToolManager integration.
- `src/providers/config.js`: provider and model configuration registry.
- `src/providers/provider.js`: common provider contract and message helper.
- `src/providers/mockProvider.js`: local streaming provider used while the real API layer is designed.
- `src/providers/remoteProvider.js`: basic HTTP clients for OpenAI Responses, Anthropic Messages, Gemini generateContent, and OpenAI-compatible chat providers.
- `src/secrets/apiKeyStore.js`: Secret Service API key storage with an injectable in-memory store for tests.
- `src/settings/appSettings.js`: persistent chat preference store and preferences page.
- `src/settings/memorySettings.js`: memory manager preferences page with search, edit, pin, disable, delete, import, and export.
- `src/settings/providerSettings.js`: libadwaita settings dialog pages for provider management and API keys.
- `src/skills/skills.js`: local skill discovery for `~/.agents/skills`, SKILL.md parsing, and prompt-context formatting.
- `src/storage/conversationStore.js`: local conversation database stored under the app data directory.
- `src/storage/memoryStore.js`: local memory database stored under the app data directory.
- `src/storage/workspaceStore.js`: local workspace database for prompts, profiles, folders, plugin descriptors, MCP configs, and cache entries.
- `src/workspace/exports.js`: Markdown, JSON, and lightweight PDF conversation exporters.
- `src/workspace/workspace.js`: prompt library, profile, folder, cache, plugin, and MCP workspace manager.
- `src/tools/tools.js`: slash-command tool framework for web search, calculator, and structured data summaries.
- `data/`: GNOME integration files.
- `tests/import-smoke.js`: fast import smoke check.
- `tests/mock-provider-smoke.js`: verifies the provider stream path.

## Early Design Decisions

- Native widgets first. Web rendering can be added for rich markdown/code views only when needed.
- Provider orchestration is a core domain layer, not UI-specific code.
- Streaming is represented as an async iterator so real API clients and local providers can use the same UI path.
- Provider fallback is opt-in and retries failed requests with another enabled provider, excluding user-cancelled requests.
- Transcript rendering stays native: Pango markup for markdown text and GtkSourceView for highlighted code blocks.
- Transcript navigation keeps a bounded cache of recent GTK view trees and initially materializes only the latest message page. Older pages remain explicitly loadable; collapsed reasoning/tool bodies, syntax highlighting, and image decoding are deferred so chat selection does not block the GTK main loop. The limits, persistence boundaries, and profiling method are recorded in [Chat Switching Performance](../implementation/chat-performance.md).
- Token usage is an estimate for context awareness; provider-specific tokenizers can replace it later.
- Message edit, retry, regenerate, and branch actions mutate conversation state through the chat manager.
- Conversations persist through a local JSON database with schema versioning and atomic writes. Active-chat selection uses a separate small state record so navigation never rewrites the transcript database, while streaming mutations are flushed at response completion and window close.
- Provider availability, default models, active selection, and chat preferences are persisted with GSettings.
- API keys are stored in Secret Service; environment variables remain a development fallback.
- Custom OpenAI-compatible providers are stored as a multi-entry list in GSettings, while each stable provider ID keeps an independent API key in Secret Service. Legacy singleton settings migrate into the list.
- Provider model discovery refreshes model lists from supported provider APIs and persists discovered model metadata in GSettings. Provider/model capability metadata, including supported thinking levels, lives in the provider registry and is documented in `docs/user/provider-models.md`.
- Memory writes are never implicit: user messages can trigger a proposal dialog, and only explicit approval stores memory.
- Memory use is per-chat controllable and creates a stored usage audit entry without adding a transcript system message.
- Installed skills are discovered from `~/.agents/skills`, enabled in the Skills preferences page, selected per chat, and injected as ephemeral hidden provider context.
- Tools run before the assistant response when requested with slash commands; sensitive web search asks for permission and tool results render as expandable transcript entries with citations where available.
- Local file and image attachments are selected through the native GTK file dialog and folded into the user message context.
- GNOME integration uses app actions for shortcuts and desktop actions, native preferences windows, notifications for long responses, and a Shell SearchProvider2 conversation index.
- High contrast, reduced motion, and compact-layout hooks are applied with CSS classes controlled by settings and window size.
- Advanced workspace data is local-first and persisted separately from conversation transcripts, with explicit export and extension registries.
- MCP servers are loaded from `~/.config/io.github.stonega.Cusco/mcp.json`, which is exposed from Workspace preferences for editing and reload. Enabled MCP tools are exposed to Agent Mode with `mcp__server__tool` names and use the same permission/audit path as built-in tools.
- Remote providers stream display chunks after receiving a complete provider response; true network streaming is still pending.
- Memory must remain visible, editable, disableable, importable, and exportable.
- Secrets must not be stored in GSettings or local JSON.
