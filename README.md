# Cusco

![Cusco banner](assets/banner.png)

Cusco is a native GNOME AI chat application built with GJS, GTK 4, and libadwaita. It is an advanced desktop AI workspace that feels at home on GNOME: persistent conversations, provider switching, memory controls, local tools, reusable workspace assets, installed skills, and desktop integration.

> **Under development:** Cusco is not production-ready yet. Expect incomplete behavior, changing data formats, and rough edges while the app is actively built.

## Features

- Native GTK/libadwaita chat shell with a persistent conversation sidebar.
- Markdown transcript rendering with highlighted code blocks and copy actions.
- Message edit, retry, regenerate, branch, archive, delete, search, and export workflows.
- Provider management for OpenAI, Anthropic, Gemini, Kimi, DeepSeek, Z.ai, and custom OpenAI-compatible APIs.
- Per-chat provider/model selection, model discovery, response timeouts, and optional provider fallback.
- Secret Service API key storage, with environment variables as a development fallback.
- User-approved memory proposals, per-chat memory controls, memory management, import/export, and visible audit notes.
- Built-in tools for web search, calculator, structured data summaries, file context, and image attachment notes.
- Workspace preferences for prompt snippets, agent profiles, conversation folders/tags, plugin tool descriptors, and optional MCP server configs.
- Installed SKILL support from `~/.agents/skills`, with a top-level Skills preferences page and per-chat skill selection.
- GNOME integration through app actions, keyboard shortcuts, notifications, adaptive layout, high contrast/reduced motion settings, desktop actions, and Shell search provider support.

## Current Status

Cusco is still a development project, but the main local app surfaces are implemented. Remote provider clients currently return complete responses and then stream display chunks in the UI; true network streaming is still pending.

See [TODO.md](TODO.md) for the roadmap and [docs/user/getting-started.md](docs/user/getting-started.md) for workflow details.

## Requirements

Install the GNOME JavaScript and build tooling for your distro.

Fedora:

```sh
sudo dnf install gjs gtk4 libadwaita gtksourceview5 libsecret libsoup3 meson ninja-build desktop-file-utils appstream glib2-devel
```

Ubuntu/Debian:

```sh
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-gtksource-5 gir1.2-secret-1 gir1.2-soup-3.0 meson ninja-build desktop-file-utils libglib2.0-dev
```

## Run From Source

```sh
gjs -m src/main.js
```

Configure remote providers from Preferences. API keys are stored through Secret Service; for local development, provider-specific environment variables can also be used.

Installed skills are discovered from:

```sh
~/.agents/skills/<skill-id>/SKILL.md
```

Enable skills in the Skills preferences page, then select them from the composer skill menu for a chat. Cusco sends selected skills as instruction context and records a visible transcript note; it does not execute skill files.

## Build

```sh
meson setup builddir
meson compile -C builddir
```

For a local install prefix:

```sh
meson setup builddir --prefix "$PWD/.local"
meson install -C builddir
```

## Test

```sh
scripts/check.sh
```

Some smoke tests skip automatically when the current environment has no display server or disallows local sockets.

## Documentation

- [Architecture](docs/design/architecture.md)
- [Setup](docs/implementation/setup.md)
- [User Getting Started](docs/user/getting-started.md)

## License

Cusco is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
