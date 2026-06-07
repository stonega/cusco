# Setup

## Dependencies

Cusco uses GJS, GTK 4, libadwaita, Meson, and Ninja.

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

1. Add a `src/storage/` directory for local conversations.
2. Add settings and preferences for provider configuration.
3. Add a real provider behind the existing streaming interface.
4. Add a markdown renderer path for assistant messages.
