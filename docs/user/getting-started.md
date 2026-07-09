# Getting Started

Cusco is currently a development scaffold.

Run it from the project root:

```sh
gjs -m src/main.js
```

The first window has a persistent conversation sidebar, markdown-capable transcript, and composer with provider/model selection plus estimated context usage. Hover the composer context ring for token details. When a chat reaches 80% of the selected model's context window, Cusco automatically summarizes older messages into a context checkpoint and keeps the recent conversation active. The Preferences button opens chat settings plus provider management, including opt-in provider fallback and Secret Service API key storage for remote providers.

Messages can be edited, retried, regenerated, or branched from the transcript. Fenced code blocks render with syntax highlighting and copy buttons.

The Custom API provider accepts an OpenAI-compatible base URL and comma-separated model IDs in Preferences. Its API key is stored through Secret Service like the built-in remote providers.

Provider settings can refresh model lists from supported remote APIs after credentials are configured. Cusco keeps a supported built-in model matrix with per-model thinking levels in [Provider Models](provider-models.md).

Memory is opt-in at write time. When a message looks like a useful long-term fact, Cusco asks before saving it. The Memory page in Preferences can search, edit, pin, disable, delete, import, and export memories. When memories are used in a chat, Cusco records a local audit entry without adding a transcript note.

Tools can be requested from the composer with `/search`, `/calc`, and `/data`. Web search asks for permission before sending a query and returns cited results. The attachment button adds local file context or image attachment notes to the next message.

GNOME integration includes desktop actions for New Chat and Quick Prompt, shell search over saved conversations, long-response notifications, and shortcuts: Ctrl+N for a new chat, Ctrl+, for Preferences, Ctrl+K for the command palette, and Ctrl+L to focus the composer. High contrast, reduced motion, and response timeout are available in Preferences.

Workspace preferences include a prompt library, conversation folders, plugin tool descriptors, and the MCP config file entry for `~/.config/io.github.stonega.Cusco/mcp.json`. Edit MCP servers in that file using a `mcpServers` object, then reload it from Workspace preferences. Enabled MCP servers expose namespaced Agent Mode tools such as `mcp__server__tool`, plus resource and prompt helper tools when the server supports them. Cusco includes compact MCP setup guidance that is always available to the model when it is relevant. The Skills preferences page discovers installed skills from `~/.agents/skills`, where each skill folder contains `SKILL.md`. Enable skills there, then select them from the composer skill menu for a chat. Selected skills are sent as hidden instruction context for the response; skill files are not executed.

Conversation rows can be organized with folders/tags/profiles and exported to Markdown, JSON, or PDF.
