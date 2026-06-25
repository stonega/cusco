# Getting Started

Cusco is currently a development scaffold.

Run it from the project root:

```sh
gjs -m src/main.js
```

The first window has a persistent conversation sidebar, markdown-capable transcript, and composer with provider/model selection plus estimated context usage. The Preferences button opens chat settings plus provider management, including opt-in provider fallback and Secret Service API key storage for remote providers.

Messages can be edited, retried, regenerated, or branched from the transcript. Fenced code blocks render with syntax highlighting and copy buttons.

The Custom API provider accepts an OpenAI-compatible base URL and comma-separated model IDs in Preferences. Its API key is stored through Secret Service like the built-in remote providers.

Provider settings can refresh model lists from supported remote APIs after credentials are configured.

Memory is opt-in at write time. When a message looks like a useful long-term fact, Cusco asks before saving it. The Memory page in Preferences can search, edit, pin, disable, delete, import, and export memories. When memories are used in a chat, Cusco adds a visible transcript note and records an audit entry.

Tools can be requested from the composer with `/search`, `/calc`, and `/data`. Web search asks for permission before sending a query and returns cited results. The attachment button adds local file context or image attachment notes to the next message.

GNOME integration includes desktop actions for New Chat and Quick Prompt, shell search over saved conversations, long-response notifications, and shortcuts: Ctrl+N for a new chat, Ctrl+, for Preferences, Ctrl+K for the command palette, and Ctrl+L to focus the composer. High contrast and reduced motion are available in Preferences.

Workspace preferences include a prompt library, reusable agent profiles, conversation folders, plugin tool descriptors, and the MCP config file entry for `~/.config/io.github.stonega.Cusco/mcp.json`. Edit MCP servers in that file using a `mcpServers` object, then reload it from Workspace preferences. Enabled MCP servers expose namespaced Agent Mode tools such as `mcp__server__tool`, plus resource and prompt helper tools when the server supports them. The Skills preferences page discovers installed skills from `~/.agents/skills`, where each skill folder contains `SKILL.md`. Enable skills there, then select them from the composer skill menu for a chat. Selected skills are sent as instruction context for the response and Cusco records a visible transcript note; skill files are not executed.

Conversation rows can be organized with folders/tags/profiles and exported to Markdown, JSON, or PDF.
