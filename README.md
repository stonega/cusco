# Cusco

Cusco is a native GNOME AI chat application built with GJS, GTK 4, and libadwaita. The goal is an advanced desktop AI workspace that feels at home on GNOME: fast conversations, provider switching, memory controls, tools, and deep desktop integration.

## Current Status

This repository contains the first scaffold:

- Native GJS application entry point.
- GTK/libadwaita shell with sidebar, chat surface, and composer.
- Meson project structure for GNOME packaging.
- Desktop entry, app metadata, settings schema, icon, and resource placeholders.
- Feature roadmap in [TODO.md](TODO.md).

## Requirements

Install the GNOME JavaScript and build tooling for your distro.

Fedora:

```sh
sudo dnf install gjs gtk4 libadwaita meson ninja-build desktop-file-utils appstream glib2-devel
```

Ubuntu/Debian:

```sh
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-adw-1 meson ninja-build desktop-file-utils libglib2.0-dev
```

## Run From Source

```sh
gjs -m src/main.js
```

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
gjs -m tests/import-smoke.js
```

## Documentation

- [Architecture](docs/design/architecture.md)
- [Setup](docs/implementation/setup.md)
- [User Getting Started](docs/user/getting-started.md)

## License

Cusco is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
