# Cusco Feature TODO

This list starts from the Alma public feature set: clean chat UI, streaming markdown/code responses, memory, memory management, web search, tool use, and multiple providers including OpenAI, Anthropic, Gemini, DeepSeek, and custom APIs.

## Phase 0: Foundation

- [x] Create native GJS/GTK/libadwaita project scaffold.
- [x] Add Meson build structure and GNOME data files.
- [x] Add starter chat shell with sidebar, transcript area, and composer.
- [ ] Add persistent application settings with GSettings.
- [ ] Add provider configuration model.
- [ ] Add Secret Service storage for API keys.
- [ ] Add local conversation database.

## Phase 1: Chat Core

- [ ] Conversation list with create, rename, archive, delete, and search.
- [ ] Streaming assistant responses.
- [ ] Markdown rendering.
- [ ] Code block rendering with syntax highlighting and copy actions.
- [ ] Message editing, retry, regenerate, and branch from message.
- [ ] Model picker in the composer.
- [ ] Token and context usage display.

## Phase 2: Provider Orchestration

- [ ] OpenAI provider.
- [ ] Anthropic provider.
- [ ] Google Gemini provider.
- [ ] DeepSeek provider.
- [ ] OpenAI-compatible custom API provider.
- [ ] Per-provider model discovery.
- [ ] Provider fallback and manual switching.
- [ ] Per-chat provider/model defaults.

## Phase 3: Memory

- [ ] Memory extraction proposal flow.
- [ ] User-approved memory writes.
- [ ] Memory manager with search, edit, pin, disable, and delete.
- [ ] Per-chat memory controls.
- [ ] Import/export for memory data.
- [ ] Clear audit trail for when memories are used.

## Phase 4: Tools

- [ ] Web search tool with citations.
- [ ] Calculator and structured data tools.
- [ ] Local file context picker through GNOME portals.
- [ ] Image attachment support.
- [ ] Tool call transcript with expandable results.
- [ ] Safe permission prompts for sensitive tools.

## Phase 5: GNOME Integration

- [ ] Native preferences window.
- [ ] Notifications for long-running responses.
- [ ] Shell search provider for conversations.
- [ ] Desktop file actions for new chat and quick prompt.
- [ ] Keyboard shortcuts and command palette.
- [ ] Adaptive layout for small windows.
- [ ] High contrast and reduced motion support.

## Phase 6: Advanced Workspace

- [ ] Prompt library.
- [ ] Reusable agent profiles.
- [ ] Conversation folders and tags.
- [ ] Export to Markdown, JSON, and PDF.
- [ ] Offline-first local cache.
- [ ] Plugin/tool extension interface.
- [ ] Optional MCP client integration.
