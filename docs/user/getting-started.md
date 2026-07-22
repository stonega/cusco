# Getting Started

Cusco is currently a development scaffold.

Run it from the project root:

```sh
gjs -m src/main.js
```

The first window has a persistent conversation sidebar, markdown-capable transcript, and composer with provider/model selection plus estimated context usage. Hover the composer context ring for token details. When a chat reaches 80% of the selected model's context window, Cusco automatically summarizes older messages into a context checkpoint and keeps the recent conversation active. The Preferences button opens chat settings plus provider management, including opt-in provider fallback and Secret Service API key storage for remote providers.

Messages can be edited, retried, regenerated, or branched from the transcript. Fenced code blocks render with syntax highlighting and copy buttons. Long conversations open at their latest messages for faster switching; select **Show earlier messages** above the transcript to load older history without removing anything from the conversation.

The Custom APIs list in Preferences accepts multiple OpenAI-compatible endpoints. Add a name, base URL, and API key; Cusco stores each key separately in Secret Service and fetches that endpoint's models from `GET /models`. Model IDs can still be entered manually when an endpoint does not support discovery.

Built-in providers use Cusco's maintained chat model lists. Their Endpoint row can
be edited for a proxy or compatible deployment, but that URL will receive the
provider API key and chat content and may behave differently from the official
service. Use Reset to return to the default official URL. Kimi exposes both its
Global and CN official endpoints directly. The supported built-in model matrix
and per-model thinking levels are listed in [Provider Models](provider-models.md).

Memory is opt-in at write time. When a message looks like a useful long-term fact, Cusco asks before saving it. The Memory page in Preferences can search, edit, pin, disable, delete, import, and export memories. When memories are used in a chat, Cusco records a local audit entry without adding a transcript note.

Tools can be requested from the composer with `/search`, `/calc`, and `/data`. Web search asks for permission before sending a query and returns cited results. The attachment button adds local file context or images to the next message. You can also copy an image or screenshot and paste it directly into the composer; Cusco adds it as an image attachment without sending the message.

Select any generated image, image attachment, tool result, or image artifact to open Cusco's native viewer. It supports zooming, cropping, rotation, flipping, and editable drawing, shape, arrow, and text annotations. Edited copies can be saved as PNG or added to the composer without sending immediately. See [Image Viewer and Editor](image-editor.md).

In Agent mode, the model can pause its work with an `ask_user` request when it needs information or a choice. Cusco temporarily replaces the provider controls with one question and its suggested options while keeping a custom-answer input. Multiple questions are shown sequentially. Select an option or type an answer and press Enter; press Escape to return a `null` answer and let the agent continue. Any existing composer draft is restored afterward.

Gemini Agent mode enables Google Search and URL Context as provider-managed tools. URL Context can read complete public URLs included in the prompt. Cusco displays provider-tool activity and appends returned sources to grounded answers.

The composer also provides inline references. Type `$` to filter enabled skills, `@` to find files under your Home folder, `@artifact:` to reference an exact artifact revision, or `#` to find executable commands available on `PATH`. Use the arrow keys and Enter or Tab to insert a styled reference, or Escape to close the list. Referenced files are attached to the message, referenced skills are loaded for that turn, referenced artifacts provide bounded working context, and referenced commands are never executed automatically.

Assistant HTML and SVG documents can become durable artifacts. Compact artifacts appear in the transcript; select **Open artifact workspace** for a larger preview, source editing, revision history, rename, fork, archive, and export. See [Artifacts](artifacts.md) for formats and security behavior.

GNOME integration includes desktop actions for New Chat and Quick Prompt, shell search over saved conversations, long-response notifications, and shortcuts: Ctrl+N for a new chat, Ctrl+, for Preferences, Ctrl+K for the command palette, and Ctrl+L to focus the composer. High contrast, reduced motion, and response timeout are available in Preferences.

Workspace preferences include a prompt library, conversation folders, plugin tool descriptors, and the MCP config file entry for `~/.config/io.github.stonega.Cusco/mcp.json`. Edit MCP servers in that file using a `mcpServers` object, then reload it from Workspace preferences. Enabled MCP servers expose namespaced Agent Mode tools such as `mcp__server__tool`, plus resource and prompt helper tools when the server supports them. Cusco includes compact MCP setup guidance that is always available to the model when it is relevant. The Skills preferences page discovers installed skills from `~/.agents/skills`, where each skill folder contains `SKILL.md`. Enable skills there, then reference one from the composer with `$`. Referenced skills are sent as hidden instruction context for the response; skill files are not executed.

Conversation rows can be organized with folders/tags/profiles and exported to Markdown, JSON, or PDF.
