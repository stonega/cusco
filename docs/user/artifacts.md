# Artifacts

Artifacts are durable outputs that can be reopened and revised independently from the conversation text. A message points to the exact artifact revision created during that turn, while the artifact workspace can also show its newest revision.

## Supported content

- Markdown and plain-text documents
- Source code
- JSON and CSV data tables
- Native JSON chart specifications
- Diagram source such as Mermaid
- Raster images and SVG
- Single-page HTML and multi-file HTML/CSS/JavaScript bundles
- PDF and generic files through the desktop viewer and export actions

HTML is one artifact format with two presentations. An inline HTML artifact runs inside a bounded message preview. A larger site opens in the trailing artifact workspace. The same artifact can be opened in either place without creating a copy.

## Using the workspace

Select the open button on an artifact card or the Artifacts button in the window header. The workspace provides:

- Artifact and revision selection
- Preview and Source tabs
- Multi-file source selection
- Editing that saves a new revision
- Rename and fork actions
- Archive and restore
- Single-file and bundle export
- Reload and stop behavior for HTML previews

Historical revisions are read-only. Fork one when you want to continue from older content without replacing the artifact's current revision.

## Referencing an artifact

Type `@artifact:` in the composer and select an artifact. Cusco records its exact artifact and revision IDs with the user message. Text entrypoints are added to that turn with bounded size; binary artifacts provide metadata instead of being inserted into the prompt.

## HTML security

Generated HTML is untrusted. Cusco serves each revision from an isolated `cusco-artifact://` origin instead of `file://` and denies access to local files, conversations, settings, secrets, clipboard, popups, downloads, device permissions, and application tools.

JavaScript runs only when the artifact has the visible `scripts` capability. Agent-created artifacts cannot grant themselves network, persistent-storage, clipboard, or host-action capabilities. External links require confirmation and open in the desktop browser. Network access is disabled by default.

At most four inline HTML previews remain active. Older previews pause and can be resumed from their card.
