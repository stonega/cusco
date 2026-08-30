# Testing and debugging

Choose commands based on the target Shell version and the user's session. Read
commands are safe defaults; installation and enablement change desktop state and
need to be within the user's request.

## Inspect the environment

```sh
gnome-shell --version
gnome-extensions version
gnome-extensions info <uuid>
```

Check the session type when it matters:

```sh
printf '%s\n' "$XDG_SESSION_TYPE"
```

## Static and packaging checks

```sh
python -m json.tool metadata.json
glib-compile-schemas --strict schemas
gnome-extensions pack <extension-directory>
```

Skip the schema command when no schema exists. Use the repository's own lint,
format, typecheck, and test commands when present. Inspect the produced ZIP so
`metadata.json` and `extension.js` are at its root and compiled schemas are
included.

Running `gjs -m extension.js` outside GNOME Shell is not a reliable extension
test: Shell resource modules and the `global` object belong to the Shell process.

## Runtime loop

For GNOME 49 and later, the official guide recommends a devkit-backed nested
Wayland Shell when `mutter-devkit` is installed:

```sh
dbus-run-session gnome-shell --devkit --wayland
```

For GNOME 48 and earlier, use the nested Wayland mode supported by that release:

```sh
dbus-run-session gnome-shell --nested --wayland
```

Inside the test session:

```sh
gnome-extensions enable <uuid>
gnome-extensions disable <uuid>
gnome-extensions prefs <uuid>
```

Exercise at least enable → disable → enable, not only the first enable. Look for
duplicate panel items, callbacks firing twice, actors remaining after disable,
and asynchronous work touching destroyed UI.

On X11, Shell can normally be restarted from `Alt`+`F2` with `r`/`restart`.
Wayland sessions cannot use that in-place restart; prefer the nested session or
log out and back in. Do not terminate the user's primary Shell process as a test
shortcut.

## Logs and inspection

Follow Shell messages:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

Open Looking Glass with `Alt`+`F2`, then `lg`. Use its Extensions page to inspect
load errors and its evaluator/inspector to examine Shell objects. Keep extension
logging concise because it shares the system journal.

When available on the target release, use purpose-built Shell extension test
tools and repository fixtures. GNOME 50 introduces additional
`gnome-shell-test-tool` coverage; consult that release's porting guide before
depending on its command line.

## Diagnose by lifecycle phase

- Load error: check JSON, default export, import paths, and declared Shell major.
- Enable error: map the first stack frame to the target version's Shell source.
- Disable/re-enable error: audit every actor, signal, source, binding, keybinding,
  subscription, cancellable, and singleton reference created during enable.
- Preferences error: remember it is GTK/Adwaita in a separate process; Shell UI
  resources are unavailable.
- Works on one major only: inspect the official porting guide and isolate private
  API differences rather than weakening `shell-version` metadata.

## Official references

- <https://gjs.guide/extensions/development/creating.html>
- <https://gjs.guide/extensions/development/debugging.html>
- <https://gjs.guide/extensions/upgrading/gnome-shell-50.html>
