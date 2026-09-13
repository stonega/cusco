# One Chrome tab group per task

Create a **new named Chrome tab group for each distinct browser task** before
navigating to its first target page. Add that task's later tabs to the same group.
Continue using the group during follow-ups to that task; a new task gets a new
group even when its title or website matches a previous task. Keep the group ID,
task title, and MCP page IDs in the conversation context.

Chrome DevTools MCP 1.9.0 has no native tab-group tool. The bundled
[Cusco Task Groups manifest](../assets/task-groups/manifest.json),
[extension page](../assets/task-groups/task.html), and
[grouping script](../assets/task-groups/task.js) provide the bridge through Chrome's
`tabs.group` and `tabGroups` APIs. It only groups its own newly opened extension
page. It has no host permissions, content scripts, network calls, background
worker, or access to tab URLs through the `tabs` permission.

## Prepare the helper once per browser session

1. Use `list_extensions` to find **Cusco Task Groups** if it is already loaded.
   Reuse its extension ID; do not reinstall it for each task.
2. Otherwise copy the complete `assets/task-groups/` folder beside this skill's
   `SKILL.md` into a unique directory under the OS temporary directory. Resolve
   this relative to the **Skill directory** supplied by Cusco, not the user's
   current project directory. Example using the actual skill directory:

   ```sh
   task_group_dir="$(mktemp -d /tmp/cusco-chrome-task-groups.XXXXXX)"
   cp -R /absolute/skill/directory/assets/task-groups/. "$task_group_dir/"
   printf '%s\n' "$task_group_dir"
   ```

3. Call `install_extension` with `path` set to that absolute temporary directory.
   Record the extension ID from the result. The preset already enables
   `--category-extensions`; using temporary storage fits its filesystem roots.
4. Retain the helper files while it is loaded in the attached Chrome profile.
   Chrome 149+ supports loading it through auto-connect. The user's request to
   use this plugin with task groups includes its bundled helper. Do not install
   unrelated extensions or change their settings. If a previously loaded helper
   has missing temporary files, restage and reload only Cusco Task Groups before
   starting the task. Keep the current task's group ID through that repair.

## Start the task group

1. Choose a short descriptive title, such as `Checkout layout`.
2. Call `new_page` with
   `url: "chrome-extension://<extension-id>/task.html"`.
3. Use the returned **MCP page ID** in `evaluate_script`:

   ```js
   async () => await cuscoTaskGroup.assign({ title: "Checkout layout" })
   ```

4. Record the returned `groupId` and title. Group IDs and `browserTabId` are
   Chrome IDs, **not MCP page IDs**. Continue to use the original MCP `pageId`
   with `navigate_page` to open the desired URL. Navigation preserves membership.

The helper verifies membership before returning. If the grouping call fails,
diagnose that failure before proceeding; do not claim a group exists or silently
substitute an isolated context for a visible tab group.

## Add another task tab

Open another `task.html` page with `new_page`, then call `evaluate_script` on that
new MCP page with the saved group ID and original title:

```js
async () => await cuscoTaskGroup.assign({ title: "Checkout layout", groupId: 123 })
```

Replace `123` with the actual returned ID. Navigate that same MCP page to its
target URL. Do this for each task tab instead of opening target URLs directly.
If the group was closed, create a replacement group with a fresh helper tab;
do not reuse an ID belonging to another task. The helper rejects title mismatches
and refuses to move a tab that already belongs to a different group.

## Existing tabs and completion

- Leave unrelated tabs and groups unchanged. For a URL-based task, create fresh
  task tabs. If the user explicitly needs an existing tab's live state, explain
  that the helper groups new task tabs and preserve that existing state.
- A group organizes tabs; it does not isolate cookies or authentication.
  `isolatedContext` creates a separate context and loses the user's existing
  logins. Do not use it for normal tasks. Only use a fresh profile when the user
  asks for a clean-session test, and retain the same grouping workflow.
- Leave the task group available for review when finished. Close only task-owned
  tabs when cleanup is requested; never close unrelated tabs or groups.
- For the optional CLI workflow, use the same extension page and grouping calls
  through CLI commands if that release exposes them. Do not open ungrouped task
  tabs as a fallback when extension tools are unavailable.
- Auto-connect requires Chrome 149+ to load the helper. If extension installation
  fails, check the Chrome version, remote-debugging permission, and filesystem
  roots. Report the limitation before interacting if the mode cannot create groups.

API references: [tabs.group](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-group)
and [tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).
