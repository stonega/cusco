# Cusco Architecture

Cusco starts as a standalone native GNOME application.

## Layers

- Shell: GJS application lifecycle, actions, shortcuts, preferences, and windows.
- UI: GTK 4 and libadwaita widgets for sidebar navigation, transcript, composer, settings, and tool results.
- Chat engine: conversation state, streaming response coordination, retry/branch behavior, and transcript persistence.
- Provider layer: one interface for OpenAI, Anthropic, Gemini, DeepSeek, and custom OpenAI-compatible APIs.
- Memory layer: user-approved memory extraction, memory lookup, and memory management.
- Tool layer: web search, file context, calculations, and later optional MCP integration.
- Storage layer: local conversations and memory database plus Secret Service for credentials.

## Initial Structure

- `src/main.js`: process entry point.
- `src/application.js`: GNOME application lifecycle and actions.
- `src/window.js`: first window and chat shell.
- `data/`: GNOME integration files.
- `tests/import-smoke.js`: fast import smoke check.

## Early Design Decisions

- Native widgets first. Web rendering can be added for rich markdown/code views only when needed.
- Provider orchestration is a core domain layer, not UI-specific code.
- Memory must be visible, editable, and disableable.
- Secrets must not be stored in GSettings or local JSON.
