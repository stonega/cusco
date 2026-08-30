# Review and release checklist

Use this before producing a ZIP or preparing an extensions.gnome.org submission.

## Metadata and layout

- The extension directory, `metadata.json` UUID, and package identity match.
- `metadata.json` includes a focused name, description, URL, and only tested
  Shell major versions.
- Required files are at the ZIP root, without an extra parent directory.
- Optional schemas, translations, styles, icons, and license files are included.
- GSettings schema IDs and paths begin with `org.gnome.shell.extensions`.

## Lifecycle

- Import time and constructors create no GObjects, connect no signals, add no
  main-loop sources, and do not modify Shell.
- `enable()` owns all dynamic setup.
- `disable()` destroys actors, disconnects signals, removes sources and
  keybindings, cancels async work, unexports D-Bus objects, clears collections,
  and nulls references.
- Repeated enable/disable cycles do not duplicate UI or callbacks.
- Each component cleans up the resources it creates.

## Process boundaries

- Shell code does not import GTK, GDK, or Libadwaita.
- Preferences do not import St, Clutter, Meta, Shell, or Shell UI modules.
- Shared modules are process-neutral or split into explicit Shell and preferences
  modules.
- Heavy or blocking work does not run in the Shell process.

## Privacy and reviewability

- The extension contains no telemetry or undisclosed data collection.
- Network access is necessary, visible to the user, and narrowly scoped.
- Bundled dependencies are reviewable and permitted by the current EGO rules.
- There is no downloaded executable code or runtime code generation that evades
  review.
- Requested permissions and session modes are limited to the feature's needs.
- Source is modular and free of placeholder or dead functionality.

## Verification evidence

- Formatting/linting, tests, JSON parsing, and schema compilation pass.
- The extension was packaged and the ZIP contents inspected.
- Runtime testing covered the declared Shell versions or the untested versions
  were removed from metadata.
- Journal and Looking Glass checks show no warnings, critical messages, leaked
  actors, or callbacks after disable.
- Preferences and settings changes were exercised.

## Release handoff

Report the output ZIP path, UUID, version, tested Shell majors, validation
commands, remaining manual checks, and any use of private Shell APIs.

## Official references

- <https://gjs.guide/extensions/review-guidelines/review-guidelines.html>
- <https://gjs.guide/extensions/review-guidelines/best-practices.html>
- <https://gjs.guide/extensions/overview/updates-and-breakage.html>
