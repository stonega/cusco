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

## Next Implementation Steps

1. Replace display-level chunking with true provider streaming for remote APIs.
