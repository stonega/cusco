# Artifact Architecture and Security

## Storage model

Artifact metadata is stored separately from conversations under:

```text
$XDG_DATA_HOME/io.github.stonega.Cusco/artifacts-v2/
  index.json
  <artifact-id>/
    <revision-id>/
      manifest.json
      <artifact files>
```

`ArtifactFileStore` validates paths and sizes, stages a complete revision in a temporary directory, then renames it atomically. Metadata is written atomically after the revision exists. File hashes and a revision content hash detect corruption.

Limits are 128 files per revision, 4 MiB per file, and 16 MiB per bundle. Paths must be relative and cannot contain empty, `.` or `..` segments. `manifest.json` is reserved.

`ArtifactManager` owns create, read, update, fork, rename, archive/restore, legacy import, and export operations. Updates use a base revision and fail with `ARTIFACT_REVISION_CONFLICT` when the current revision changed. Existing revisions are immutable.

Legacy message artifacts containing an absolute `path` are copied into the managed store on startup. The conversation is rewritten to a compact `{artifactId, revisionId, ...}` reference only after the managed revision is durable. Legacy files are not deleted.

## Rendering

The renderer registry selects separate inline and workspace views. Native GTK renderers handle documents, source, tables, charts, images, SVG, and fallback files. HTML uses WebKitGTK 6.0. Application controls never run inside the HTML view.

The workspace is a trailing `Adw.OverlaySplitView` sidebar. It is pinned on wide windows and overlays the chat on narrower windows.

## Web security boundary

`ArtifactWebRuntime` owns a private WebKit context and ephemeral network session. It registers `cusco-artifact://<artifact-id>/<revision-id>/<path>` and binds each WebView to exactly one artifact and revision. The scheme handler rejects cross-artifact, cross-revision, missing, and unsafe paths even when a page constructs the URI itself.

The default content security policy denies all sources, then enables same-revision resources, inline styles, and inline/same-origin scripts. Network sources are absent unless a separately granted network capability exists. Agent tools currently accept only the `scripts` capability.

WebKit settings additionally disable file URL access, universal file access, JavaScript clipboard access, automatic windows, modal dialogs, DNS prefetching, fullscreen, local databases, media capture, WebRTC, and page caching. Permission requests and downloads are denied. Non-artifact navigation is ignored; user-initiated HTTP(S) links are handed to the native confirmation dialog.

## Agent interface

Agent Mode exposes:

- `artifact_create`
- `artifact_update`
- `artifact_read`
- `artifact_list`
- `artifact_present`

Tool results contain compact artifact references. Tool reads, updates, lists, and presentations are restricted to the active conversation. `artifact_update` always creates a revision and requires the caller's base revision. Permanent deletion is not exposed to the agent.

Tool content is UTF-8 text by default. A top-level body, bundle file, or file change can declare `encoding: "base64"` for binary image, PDF, or generic-file data; bundle limits apply after decoding.

Composer references are resolved to an exact revision and appended only to the provider copy of the referencing user turn. Artifact text is bounded and remains user-level input; it is never promoted into the system prompt.

## Verification

Headless tests cover normalization, storage, path traversal, reserved paths, revision conflicts, restart persistence, legacy import, export, integrity checks, tool behavior, conversation references, and URI/CSP policy. The display-backed workspace smoke test constructs the adaptive panel, loads HTML from the custom scheme, verifies script capability behavior, and checks that JavaScript has no clipboard access.
