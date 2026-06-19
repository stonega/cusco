# Cusco Feature TODO

This list starts from the Alma public feature set: clean chat UI, streaming markdown/code responses, memory, memory management, web search, tool use, and multiple providers including OpenAI, Anthropic, Gemini, DeepSeek, and custom APIs.

## Phase 0: Foundation

- [x] Create native GJS/GTK/libadwaita project scaffold.
- [x] Add Meson build structure and GNOME data files.
- [x] Add starter chat shell with sidebar, transcript area, and composer.
- [x] Add provider interface with a local mock streaming provider.
- [x] Add provider configuration model.
- [x] Add in-memory chat manager with create, select, search, and per-chat transcripts.
- [x] Add provider management page in settings dialog.
- [x] Add provider definitions and HTTP clients for OpenAI, Anthropic, Gemini, Kimi, and DeepSeek.
- [x] Persist provider availability, default models, and active selection with GSettings.
- [x] Add persistent application settings for remaining preferences.
- [x] Add Secret Service storage for API keys.
- [x] Add local conversation database.

## Phase 1: Chat Core

- [x] Conversation list with create, rename, archive, delete, and search.
- [x] Streaming assistant responses.
- [x] Markdown rendering.
- [x] Code block rendering with syntax highlighting and copy actions.
- [x] Message editing, retry, regenerate, and branch from message.
- [x] Model picker in the composer.
- [x] Token and context usage display.

## Phase 2: Provider Orchestration

- [x] OpenAI provider.
- [x] Anthropic provider.
- [x] Google Gemini provider.
- [x] DeepSeek provider.
- [x] OpenAI-compatible custom API provider.
- [x] Per-provider model discovery.
- [x] Provider fallback and manual switching.
- [x] Per-chat provider/model defaults.

## Phase 3: Memory

- [x] Memory extraction proposal flow.
- [x] User-approved memory writes.
- [x] Memory manager with search, edit, pin, disable, and delete.
- [x] Per-chat memory controls.
- [x] Import/export for memory data.
- [x] Clear audit trail for when memories are used.

## Phase 4: Tools

- [x] Web search tool with citations.
- [x] Calculator and structured data tools.
- [x] Local file context picker through GNOME portals.
- [x] Image attachment support.
- [x] Tool call transcript with expandable results.
- [x] Safe permission prompts for sensitive tools.

## Phase 5: GNOME Integration

- [x] Native preferences window.
- [x] Notifications for long-running responses.
- [x] Shell search provider for conversations.
- [x] Desktop file actions for new chat and quick prompt.
- [x] Keyboard shortcuts and command palette.
- [x] Adaptive layout for small windows.
- [x] High contrast and reduced motion support.

## Phase 6: Advanced Workspace

- [x] Prompt library.
- [x] Reusable agent profiles.
- [x] Conversation folders and tags.
- [x] Export to Markdown, JSON, and PDF.
- [x] Offline-first local cache.
- [x] Installed SKILL.md discovery from `~/.agents/skills` with per-chat selection.
- [x] Plugin/tool extension interface.
- [x] Optional MCP client integration.
