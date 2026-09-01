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

Tools can be requested from the composer with `/search`, `/calc`, and `/data`. Web search asks for permission before sending a query and returns cited results. Models with native search keep using their provider; other models and explicit `/search` commands use built-in DuckDuckGo search by default. It requires no API key, background service, or additional software. Preferences → Providers → Web Search can switch the fallback to Exa Search when an API key is configured. Exa offers a free tier. The attachment button adds local file context or images to the next message. You can also paste clipboard content directly into the composer: images become image attachments, very long text becomes a private `.txt` article attachment, and shorter text remains inline. Pasting an attachment does not send the message.

Select any generated image, image attachment, tool result, or image artifact to open Cusco's native viewer. It supports zooming, cropping, rotation, flipping, and editable drawing, shape, arrow, and text annotations. Edited copies can be saved as PNG or added to the composer without sending immediately. See [Image Viewer and Editor](image-editor.md).

In Agent mode, the model can pause its work with an `ask_user` request when it needs information or a choice. Cusco temporarily replaces the provider controls with one question and its suggested options while keeping a custom-answer input. Multiple questions are shown sequentially. Select an option or type an answer and press Enter; press Escape to return a `null` answer and let the agent continue. Any existing composer draft is restored afterward.

Gemini Agent mode enables Google Search and URL Context as provider-managed tools. URL Context can read complete public URLs included in the prompt. Cusco displays provider-tool activity and appends returned sources to grounded answers.

The composer also provides inline references. Type `$` to filter enabled skills, `@` to find files under your Home folder, `@artifact:` to reference an exact artifact revision, or `#` to find executable commands available on `PATH`. Use the arrow keys and Enter or Tab to insert a styled reference, or Escape to close the list. Referenced files are attached to the message, referenced skills are loaded for that turn, referenced artifacts provide bounded working context, and referenced commands are never executed automatically.

Assistant HTML and SVG documents can become durable artifacts. Compact artifacts appear in the transcript; select **Open artifact workspace** for a larger preview, source editing, revision history, rename, fork, archive, and export. See [Artifacts](artifacts.md) for formats and security behavior.

GNOME integration includes desktop actions for New Chat and Quick Prompt, shell search over saved conversations, long-response notifications, and shortcuts: Ctrl+N for a new chat, Ctrl+, for Preferences, Ctrl+K for the command palette, and Ctrl+L to focus the composer. High contrast, reduced motion, and response timeout are available in Preferences.

Select **Plugins** beside **Usage** in the sidebar to browse every installed and
available plugin in Cusco's configured marketplace. Search by name, description,
developer, category, capability, or marketplace; filter to installed or
available entries; then select **Install** or **Remove**. Removal requires a
confirmation. Cusco reads `$REPO_ROOT/.agents/plugins/marketplace.json` itself
and copies installed plugins into `$REPO_ROOT/plugins/`. Plugin skills are
discovered immediately from each installed plugin's `skills/` folder and are
available to new Cusco conversations. **Connect** normally uses the plugin's MCP
endpoint, Cusco's native OAuth discovery, PKCE, client registration, automatic
token refresh, and Secret Service storage; app-only
ports ask for an MCP endpoint instead of sending their legacy connector ID to
another host. Compatible plugin packages may provide a root `.mcp.json` without
referencing it from the main manifest; Cusco discovers that endpoint
automatically. When an endpoint declares a bearer-token environment variable,
**Connect** accepts the token in a masked native dialog and stores it in Secret
Service instead of workspace settings. The bundled GitHub plugin uses this path
to expose permission-gated repository, pull request, issue, and Actions tools;
use a GitHub token limited to the repositories and permissions you need.
Gmail is native: **Connect** selects a Google mail account from
GNOME Online Accounts, verifies Gmail access, and stores only that GOA account
ID. Its search and read tools use Gmail's secure IMAP/XOAUTH2 path, ask for
permission on every invocation, and do not use a hosted connector intermediary.
Remote MCP authentication also runs locally and opens the system browser only
for authorization. Plugins → MCP exposes advanced OAuth fields for a
pre-registered client and a **Sign out** action. Some services approve MCP
clients at the service level, so a standards-compliant OAuth flow can still be
rejected until the service approves Cusco. See [MCP Authorization](../implementation/mcp-authorization.md).
Select a plugin row to inspect its provenance, status, included components,
capabilities, connection state, and example requests. Select a skill row in the
**Skills** tab to inspect its source, location, status, and instruction preview.
Removing a plugin also removes any workspace MCP connector and stored bearer
credential that Cusco created for it; independently managed `mcp.json` servers
remain in place.

Workspace preferences include the prompt library, hooks, and computer-use controls. Open the **Plugins** destination and use its **Skills** and **MCP** tabs to manage integrations. The MCP tab can add STDIO commands and Streamable HTTP endpoints, including environment-backed secrets, OAuth scopes, and optional tool allowlists. Agent Mode can also configure a direct file-backed HTTP server, complete OAuth in the system browser, reconnect, inspect non-sensitive status, and call a newly discovered allowed tool without installing a plugin. These host actions update `~/.config/io.github.stonega.Cusco/mcp.json` atomically and preserve unrelated settings. Enabled servers expose namespaced Agent Mode tools such as `mcp__server__tool`, plus explicitly allowed resource and prompt helpers when supported. The Skills tab discovers skills from `~/.agents/skills`, `$REPO_ROOT/skills`, and installed plugins, and labels them as **Global** or **Cusco**. Each skill folder contains `SKILL.md`. **Add skill folder** copies the complete selected folder into `$REPO_ROOT/skills/` without changing the original. Enable skills there, then reference one from the composer with `$`. Referenced skills are sent as hidden instruction context for the response; skill files are not executed.

The Hooks preferences page discovers reviewed lifecycle commands from Cusco's user configuration and an explicitly selected chat working directory. Hooks can inspect or influence prompts, local tools, permission requests, compaction, and turn completion. New or changed commands never run before they are trusted. See [Lifecycle Hooks](hooks.md) for configuration and security details.

Conversation rows can be organized with folders/tags/profiles and exported to Markdown, JSON, or PDF.
