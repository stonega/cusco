# Background Computer Use

## Goal and status

Computer Use starts each agent turn on **Background desktop**. When the user
asks for their foreground desktop or an already open window, the agent selects
**Current desktop** in `computer_list` for that turn. The choice is not saved.
Computer Use itself remains disabled by default.

The first runtime is implemented and has been exercised on GNOME Shell 51:
Cusco started a second headless Shell, launched Calculator and Firefox, captured
a window, and sent keyboard input while the physical session stayed separate.
Availability on other GNOME releases is detected at startup; their headless
behavior still needs integration testing.

## Implemented runtime

```text
Cusco on the physical session
  -> ComputerUseManager (mode routing)
       -> Current desktop: existing ComputerUseService and Shell extension
       -> Background desktop: BackgroundComputerUseSession
            -> private D-Bus session bus and XDG runtime/config/data/cache
            -> headless GNOME Shell with 1280x800 virtual monitor
            -> source or installed Cusco Shell extension on that bus
            -> session-local AT-SPI bridge
            -> gtk-launch or browser launcher with a private profile
```

The backend reuses the existing observation, input, permission, cancellation,
image, and stale-state code. The Shell extension assigns a random session
prefix to window IDs, so an ID from a different compositor or an earlier run
cannot select a window by accident. Background D-Bus requests connect only to
the private bus. The active desktop is shown in `computer_list` results.
`computer_launch` opens an installed application on that
desktop. Background failures return an error; they never switch to the
physical desktop.

The background session starts on demand. Cusco tracks its Shell, bus,
accessibility helper, and directly launched browser processes. The header's
**Stop agent desktop** button cancels work and stops the runtime. Switching
modes, disabling Computer Use, or closing Cusco also stops it. The private
browser profile persists under Cusco's data directory; transient sockets and
session state are removed after shutdown. Firefox uses `--no-remote` and an
explicit profile. Chrome and Chromium use an explicit user data directory.
Unsupported browser launchers fail instead of opening the physical profile.

## Limits and next steps

This runtime uses the **same Unix user account** as Cusco. Its D-Bus, display,
clipboard, and XDG directories are separate, but the agent can still access
files in the user's home and applications may ignore XDG directories. This is
interaction isolation, not a security boundary. A dedicated service account
would provide stronger file and credential separation, but needs an explicit
file transfer and application setup design before being made the default.

The user can hover over **Stop agent desktop** for a live, view-only desktop
preview or open that preview in a separate GTK window. A private AT-SPI bus and
registry expose semantic elements for supported applications; visual targeting
remains available for the others.
Browser launch support has been exercised with Firefox on this host. Other
browser packaging formats and GNOME versions require testing before their
launchers are allowed.

## Verification

```sh
gjs -m tests/background-computer-use-smoke.js
gjs -m tests/computer-use-smoke.js
gjs -m tests/app-settings-smoke.js
gjs -m tests/agent-mode-smoke.js
gjs -m tests/import-smoke.js
glib-compile-schemas --strict --dry-run data
```

On a GNOME Wayland desktop, run the opt-in integration test from this checkout:

```sh
gjs -m "$PWD/tests/background-computer-use-live.js"
CUSCO_TEST_BACKGROUND_FIREFOX=1 gjs -m "$PWD/tests/background-computer-use-live.js"
CUSCO_TEST_BACKGROUND_ATSPI=1 gjs -m "$PWD/tests/background-computer-use-live.js"
```

The integration test starts a disposable background session, operates
Calculator, optionally launches Firefox or checks Text Editor's semantic tree,
and stops the session. It does not install or replace the user's Cusco application.

## References

- [Firefox command-line parameters](https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html)
- [Chromium separate user data directories](https://www.chromium.org/developers/creating-and-using-profiles/)
- [GVfs FUSE control](https://wiki.gnome.org/Projects/gvfs/doc)
