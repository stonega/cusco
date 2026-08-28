# Setup

## Dependencies

Cusco uses GJS, GTK 4, libadwaita, GtkSourceView 5, WebKitGTK 6.0, libsecret, libsoup 3, GNOME Online Accounts, Meson, and Ninja. WebKitGTK is used only for sandboxed HTML artifacts; the application shell remains native GTK/libadwaita.

Fedora provides the required GTK 4 WebKit and GOA runtimes as `webkitgtk6.0` and `gnome-online-accounts-libs`. Debian and Ubuntu provide their GObject-introspection bindings as `gir1.2-webkit-6.0` and `gir1.2-goa-1.0`.

Quick smoke check:

```sh
scripts/check.sh
```

Run the current shell:

```sh
gjs -m src/main.js
```

## Built-in Web Search

Cusco's default fallback queries DuckDuckGo's non-JavaScript search page with
the existing libsoup runtime and normalizes its cited results in-process. No
API key, container, daemon, or additional dependency is required. Moderate
Safe Search remains enabled, DuckDuckGo is attributed in the transcript, and
sponsored results remain visibly labeled.

Providers → Web Search can instead select Exa Search and store its API key
in Secret Service.

Configure and compile:

```sh
meson setup builddir
meson compile -C builddir
```

Install for the current user:

```sh
scripts/install-user.sh
```

The installer configures the build with the `$HOME/.local` prefix and refuses
to run as root, so it cannot overwrite the system-wide installation. To
perform the same steps manually:

```sh
meson setup --reconfigure builddir --prefix "$HOME/.local"
meson compile -C builddir
meson install -C builddir --no-rebuild
```

Build a system package from a fresh `/usr`-prefix build directory:

```sh
meson setup rpm-builddir --prefix /usr
meson compile -C rpm-builddir
DESTDIR="$PWD/rpm-root" meson install -C rpm-builddir --no-rebuild
```

## Release Automation

Pushing a `v*` tag builds and publishes the GitHub release artifacts, then
submits `cusco.spec` to the `stonegate/cusco` Fedora COPR project. The COPR job
derives the package version from the tag and waits for every configured chroot
to finish, so a failed COPR build also fails the release workflow.

The repository must have a GitHub Actions secret named `COPR_CONFIG`. Sign in
to the [Fedora COPR API page](https://copr.fedorainfracloud.org/api/), copy the
complete generated configuration, and store it as the secret value. The
workflow writes it to the COPR CLI configuration path only for the publishing
job. To publish or retry an existing release, run the workflow manually and
enter its `v*` tag in the `copr_tag` input.

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
trigger. RPM specs should not add manual `%post` or `%postun`
`glib-compile-schemas` calls for Cusco; those compile every host schema and can
print unrelated system warnings as Cusco install output.

## Runtime Verification

Run `gjs -m tests/remote-provider-http-smoke.js` to exercise native loopback streaming, protocol reduction, interruption handling, and retry behavior without contacting external providers.
