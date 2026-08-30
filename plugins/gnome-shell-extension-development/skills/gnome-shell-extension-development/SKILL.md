---
name: gnome-shell-extension-development
description: Build, modify, port, debug, review, test, package, or publish GNOME Shell extensions using GJS. Use whenever the user mentions GNOME extensions, GNOME Shell add-ons, extension.js, prefs.js, metadata.json, GJS Shell APIs, panel indicators, Quick Settings, Looking Glass, extensions.gnome.org review, or a Shell-version migration—even if they only ask for a small extension code change.
compatibility: GNOME Shell extension development; runtime verification requires a GNOME desktop or nested Shell session.
---

# GNOME Shell Extension Development

Help the user produce a complete extension change that matches the target GNOME
Shell version, behaves correctly across repeated enable/disable cycles, and is
ready for review and packaging. GNOME Shell extensions execute inside the Shell
process, so lifecycle mistakes can destabilize the desktop; design cleanup at
the same time as setup.

## Establish the target

Before editing, determine as much of this as the repository and local system can
answer:

- Is this a new extension, an existing extension, a port, or a diagnosis?
- What UUID and human-readable name does it use?
- Which GNOME Shell major versions have actually been tested?
- Does it need preferences, GSettings, translations, styles, keybindings, D-Bus,
  or external helper processes?
- Is the active session Wayland or X11, and is nested Shell testing available?

Inspect an existing `metadata.json`, entry points, schemas, build scripts, and
tests before proposing structure. For a new project, infer safe defaults and
leave the Shell-version list limited to versions that can be verified. Never add
unverified major versions merely to bypass compatibility checks.

Run `gnome-shell --version` when local execution is available. Check the current
official GNOME JavaScript extension guide and the porting guide for every target
major before using a GNOME Shell internal module: internal JavaScript APIs change
between Shell releases even when GJS syntax remains valid.

## Choose the correct module generation

- GNOME Shell 45 and later use ECMAScript modules. `extension.js` must default-
  export a subclass of `Extension`; `prefs.js` must default-export a subclass of
  `ExtensionPreferences`.
- GNOME Shell 44 and earlier use the legacy `imports.*` and `init()` model. Do not
  mix legacy and ESM syntax in one entry point. Supporting both sides of the 45
  boundary normally requires separate release branches or generated artifacts.
- Shell-process code may import `St`, `Clutter`, `Meta`, and `Shell`, but must not
  import `Gtk`, `Gdk`, or `Adw`.
- Preferences run in a separate process. They may use GTK 4 and Libadwaita, but
  must not import Shell-process libraries such as `St`, `Clutter`, `Meta`, or
  `Shell`.
- Import GNOME Shell modules through their case-sensitive `resource:///` paths,
  GI libraries through `gi://`, and extension-owned modules through relative
  paths.

Use [references/project-templates.md](./references/project-templates.md) when
scaffolding entry points, preferences, or a settings schema. Adapt the template
to the target version instead of copying it blindly.

## Implement with resource ownership

Keep module import and the extension constructor free of Shell side effects.
Create dynamic resources in `enable()` and release all of them in `disable()`.
Keep the two methods close enough that reviewers can compare them directly.

Track each resource at the owner that creates it:

| Created during enable | Required cleanup during disable |
| --- | --- |
| `St`/`Clutter` actor, panel button, menu | Destroy it, then null the reference |
| GObject signal handler | Disconnect it from the same object |
| GLib timeout or idle source | Remove its source ID, then null the ID |
| Shell keybinding | Remove the keybinding |
| D-Bus export or signal subscription | Unexport or unsubscribe |
| `Gio.Cancellable` / async request | Cancel it and prevent late UI mutation |
| GSettings signal/binding | Disconnect or unbind when ownership requires it |
| Custom controller/service | Give it a symmetric `destroy()` and null it |

Avoid placeholder lifecycle methods. Implement the requested behavior fully or
state the concrete missing dependency. A custom class that allocates resources
should also own their cleanup; scattering cleanup across the entry point makes
leaks and repeated-enable failures difficult to reason about.

Prefer documented platform APIs. When a feature requires a private Shell module,
isolate the access behind a small adapter, verify it against each target major,
and document the compatibility risk.

## Preferences and settings

Use `ExtensionPreferences.fillPreferencesWindow(window)` with GTK 4 and
Libadwaita for modern preferences. Keep the preferences process independent from
the Shell process and share state through GSettings rather than shared objects.

When GSettings is needed:

1. Put the schema under `schemas/`.
2. Use an ID and path below `org.gnome.shell.extensions`.
3. Declare `settings-schema` in `metadata.json`.
4. Call `this.getSettings()` without duplicating the schema ID in code.
5. Compile schemas for local tests and ensure `gschemas.compiled` is included in
   the packaged extension.

## Verification workflow

Match validation to the change and report what could not be exercised:

1. Parse `metadata.json` and verify that its UUID matches the extension directory
   and packaging identity.
2. Run the repository's formatter, linter, type checks, and unit tests when they
   exist. Do not claim that `gjs -m extension.js` is a complete Shell test;
   resource imports and the `global` object require GNOME Shell.
3. Compile GSettings schemas with strict checking when a schema exists.
4. Package with `gnome-extensions pack` and inspect the ZIP layout.
5. Test in a nested Shell session when supported, otherwise give exact manual
   steps for the user's session type.
6. Enable, disable, and re-enable repeatedly. Exercise preferences, settings
   changes, lock/session transitions if declared, and the failure paths of async
   work.
7. Watch the Shell journal and inspect actors/signals with Looking Glass. Treat
   warnings, critical messages, leaked UI, duplicate callbacks, and post-disable
   activity as failures.

Read [references/testing-debugging.md](./references/testing-debugging.md) for
commands and the Wayland/X11 test loop.

## Review and release

Before packaging or publishing, apply
[references/review-release-checklist.md](./references/review-release-checklist.md).
Pay special attention to initialization side effects, resource cleanup, process
isolation, schema paths, bundled code, network behavior, privacy, and the exact
Shell versions declared in metadata.

Installing, enabling, disabling, or replacing an extension changes the user's
desktop session. Do those actions only when the user requested runtime testing
or installation; otherwise prepare the source, validate it without mutation,
and provide the commands for the user to run.

## Handoff format

Lead with what now works. Then state:

- files and behavior changed;
- target Shell versions and any private-API risks;
- automated checks and runtime scenarios completed;
- manual session steps still required;
- the packaging artifact or exact packaging command, when requested.

When diagnosing rather than implementing, identify the lifecycle/API cause with
evidence and do not silently change the extension unless the user also asked for
a fix.
