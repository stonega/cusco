---
name: chrome-devtools
description: Uses Chrome DevTools via MCP for efficient debugging, troubleshooting and browser automation. Use when debugging web pages, automating browser interactions, analyzing performance, or inspecting network requests. This skill does not apply to `--slim` mode (MCP configuration).
---

<!-- Adapted for Cusco; see ../../NOTICE. -->

## Using this skill in Cusco

Use Cusco’s connected `mcp__chrome_devtools__*` tools for browser tasks; the
CLI skill applies to shell automation requests. Read the [Cusco connection guide](references/cusco.md) for connection status, tool routing, saved configuration,
and optional features. Before target navigation, create a new named Chrome tab
group for the task using that guide; add subsequent task tabs to the same group.
Use the live tool schema when an upstream example differs.

## Core Concepts

**Browser lifecycle**: The first browser tool attaches to the user's running,
signed-in Chrome profile using `--auto-connect`. Chrome must have remote debugging
enabled and the user must accept its Allow prompt. Keep task tabs in that same
profile; do not use `isolatedContext` unless a clean-session test is requested.
Inspect configuration options with
`npx -y chrome-devtools-mcp@1.9.0 --help`.
The Cusco preset already enables these additional categories:

- For extension tooling, use the `--categoryExtensions` flag.
- For memory tooling, use the `--memoryDebugging` flag.

**Page targeting**: Page-scoped tools require a `pageId` parameter to target a specific page. Use `list_pages` to see available pages and their IDs (e.g. `pageId: 1`), or use the ID returned when creating a page with `new_page`.
Note: For `evaluate_script`, `pageId` is required when targeting pages. However, when `--categoryExtensions` is enabled, `pageId` is optional so you can pass `serviceWorkerId` instead to evaluate inside an extension background service worker.
**Element interaction**: Use `take_snapshot` to get page structure with element `uid`s. Each element has a unique `uid` for interaction. If an element isn't found, take a fresh snapshot - the element may have been removed or the page changed.

## Workflow Patterns

### Before interacting with a page

1. Group: follow [task tab groups](references/task-groups.md) to open a helper tab
   and create the task's group, or add the tab to this task's existing group.
2. Navigate that same MCP `pageId` to the target URL with `navigate_page`.
3. Wait: `wait_for` to ensure content is loaded if you know what you look for.
4. Snapshot: `take_snapshot` with `pageId` to understand page structure
5. Interact: Use element `uid`s from snapshot for `click`, `fill`, etc., passing the corresponding `pageId`.

### Efficient data retrieval

- Use `filePath` parameter for large outputs (screenshots, snapshots, traces)
- Use pagination (`pageIdx`, `pageSize`) and filtering (`types`) to minimize data
- Set `includeSnapshot: false` on input actions unless you need updated page state

### Tool selection

- **Automation/interaction**: `take_snapshot` (text-based, faster, better for automation)
- **Visual inspection**: `take_screenshot` (when user needs to see visual state)
- **Additional details**: `evaluate_script` for data not in accessibility tree

### Parallel execution

You can send multiple tool calls in parallel, but maintain correct order: navigate → wait → snapshot → interact.

### Testing an extension

Extension tools (`install_extension`, `list_extensions`, etc.) require
`--category-extensions`, which is included in the preset. If they are missing,
inspect the saved server's flags and tool allowlist using the connection guide.
Preserve its other arguments when enabling a category, then restart Cusco.
Use Chrome 149+ for extension testing through auto-connect; the extension
directory must be within a configured filesystem root.

1. **Install**: Use `install_extension` with the path to the unpacked extension.
2. **Identify**: Get the extension ID from the response or by calling `list_extensions`.
3. **Trigger Action**: Use `trigger_extension_action` to open the popup or side panel if applicable.
4. **Verify Service Worker**: Use `evaluate_script` with `serviceWorkerId` (omitting `pageId` and `args`) to check extension state or trigger background actions. When evaluating in a page, pass `pageId` (omitting `serviceWorkerId`).
5. **Verify Page Behavior**: Navigate to a page where the extension operates and use `take_snapshot` to check if content scripts injected elements or modified the page correctly.

## Troubleshooting

If `chrome-devtools-mcp` is insufficient, guide users to use Chrome DevTools UI:

- https://developer.chrome.com/docs/devtools
- https://developer.chrome.com/docs/devtools/ai-assistance

If there are errors launching `chrome-devtools-mcp` or Chrome, refer to https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md.
