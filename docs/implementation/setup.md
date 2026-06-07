# Setup

## Dependencies

Cusco uses GJS, GTK 4, libadwaita, Meson, and Ninja.

Quick smoke check:

```sh
gjs -m tests/import-smoke.js
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

1. Add a `src/providers/` directory with a provider interface and a mock provider.
2. Add a `src/storage/` directory for local conversations.
3. Add settings and preferences for provider configuration.
4. Add a markdown renderer path for assistant messages.
