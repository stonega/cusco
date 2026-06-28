# Setup

## Dependencies

Cusco uses GJS, GTK 4, libadwaita, GtkSourceView 5, libsecret, libsoup 3, Meson, and Ninja.

Quick smoke check:

```sh
scripts/check.sh
```

Run the current shell:

```sh
gjs -m src/main.js
```

Configure and compile:

```sh
meson setup builddir
meson compile -C builddir
```

Install into a local prefix:

```sh
meson setup builddir --prefix "$PWD/.local"
meson install -C builddir
```

Build a system package from a fresh `/usr`-prefix build directory:

```sh
meson setup rpm-builddir --prefix /usr
meson compile -C rpm-builddir
DESTDIR="$PWD/rpm-root" meson install -C rpm-builddir --no-rebuild
```

## Schema Warnings During Install

Cusco installs one GSettings schema, `io.github.stonega.Cusco.gschema.xml`,
using the path `/io/github/stonega/Cusco/`. Warnings about deprecated
`/apps/`, `/desktop/`, or `/system/` paths in schemas such as IBus, Seahorse,
or `org.gnome.system.proxy` come from the host system schema cache step, not
from Cusco.

Validate Cusco's schema directly with:

```sh
glib-compile-schemas --strict --dry-run data
```

For distro packaging, install through `DESTDIR`; Meson skips live schema cache
updates in that mode and lets the package manager run its normal GLib schema
trigger.

## Next Implementation Steps

1. Replace display-level chunking with true provider streaming for remote APIs.
