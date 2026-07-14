# GNOME computer-use architecture

This document explains how Cusco's Linux-only computer-use implementation is
put together. For installation and everyday use, start with the
[user guide](../user/computer-use.md).

## Design goals

- Support GNOME Shell on Wayland directly.
- Avoid a cross-platform backend-selection layer.
- Keep capture, input, and workspace switching separately user-controlled.
- Give the user a visible emergency stop in both GNOME Shell and Cusco.
- Limit privileged Shell methods to the running Cusco process.
- Keep screenshots private and short-lived.

The observe/act workflow was adapted from `pi-computer-use`. Cusco does not
vendor its Node.js, Pi extension, macOS, Windows, Hyprland, `grim`, `ydotool`,
or `wtype` layers. Attribution and the pinned upstream revision are in
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

## Components

```text
Chat with Agent enabled
        │
        ▼
computer_list / computer_observe / computer_act
        │
        ▼
ComputerUseService (Cusco process)
        │  session D-Bus
        ▼
GNOME Shell extension
        ├── Mutter window and workspace discovery
        ├── Shell.Screenshot window capture
        ├── Clutter virtual pointer and keyboard
        └── cyan top-panel emergency stop
```

| Component | Location | Responsibility |
|---|---|---|
| Tool definitions | `src/computerUse/tools.js` | Defines model-visible schemas and converts tool input/output. |
| App-side service | `src/computerUse/service.js` | Enforces settings, calls D-Bus, maps coordinates, caches screenshots, and handles cancellation. |
| Settings UI | `src/settings/computerUseSettings.js` | Exposes capability switches, timeout, and live integration status. |
| Window integration | `src/window.js` | Registers tools, attaches observations, displays the in-app stop control, and stops the provider turn. |
| Shell extension | `data/gnome-shell/extensions/cusco-computer-use@stonega/` | Performs GNOME-specific discovery, capture, input, workspace activation, and top-panel UI. |
| Persistent settings | `data/io.github.stonega.Cusco.gschema.xml` | Stores the feature and capability gates in GSettings. |

## D-Bus contract

The extension exports this interface on the user's session bus:

```text
Bus name:   org.gnome.Shell
Object:     /io/github/stonega/Cusco/ComputerUse
Interface:  io.github.stonega.Cusco.ComputerUse
Protocol:   1
```

The extension exports an object under GNOME Shell's existing bus name; it does
not own a separate well-known name. This is why an unloaded extension produces
an `UnknownMethod` or “Object does not exist” error even while
`org.gnome.Shell` itself is reachable.

| Method or signal | Purpose |
|---|---|
| `Register(pid)` | Binds the bridge to one Cusco D-Bus sender and process ID. |
| `Unregister()` | Releases the current client and hides the indicator. |
| `GetStatus()` | Returns protocol, Shell version, and supported capabilities. |
| `SetActive(active)` | Shows or hides the Shell emergency-stop control. |
| `ListDesktop()` | Returns screens, workspaces, and window metadata as JSON. |
| `CaptureWindow(id)` | Focuses a window and returns a PNG as base64 JSON data. |
| `PerformAction(json)` | Performs one validated input or workspace action. |
| `StopRequested` | Tells Cusco that the Shell stop control was clicked. |

Payloads are JSON strings inside typed D-Bus parameters. App and extension
both require protocol version `1`; a version mismatch is shown in settings
instead of allowing actions against an incompatible bridge.

## Registration and trust boundary

Before a privileged call, the extension verifies that:

1. the PID claimed by Cusco matches the PID D-Bus reports for that sender;
2. the process command line looks like an installed or source Cusco process;
3. later calls come from the same unique D-Bus sender; and
4. no second Cusco process already owns the bridge.

The extension subscribes to D-Bus owner changes. If Cusco exits or loses its
bus connection, the bridge clears its client state and hides the stop control.
These checks prevent another ordinary session-bus client from calling the
bridge by merely knowing its object path. They are a process identity boundary,
not a sandbox boundary against a process already able to inspect or control the
same desktop session.

## Tool workflow

### 1. List

`computer_list` calls `ListDesktop`. The extension reads Mutter's tab list and
returns:

- each workspace's zero-based index, active state, and window count;
- each controllable window's ID, title, application, PID, workspace, monitor,
  frame rectangle, focus/minimized state, and sticky-workspace state; and
- the GNOME stage dimensions.

Skip-taskbar windows are omitted.

### 2. Observe

`computer_observe` requires capture permission and a window ID from the list.
The extension unminimizes and focuses the window, waits briefly for it to
settle, then captures its frame rectangle with `Shell.Screenshot`.

The extension returns base64 PNG data over D-Bus. The service:

1. rejects empty data and images larger than 25 MB;
2. writes the PNG with mode `0600` inside a mode `0700` per-window session
   directory under the user cache;
3. records screenshot and window-frame dimensions for coordinate mapping; and
4. attaches the image to the next model turn.

The cache directory is recursively removed when the Cusco window shuts down.

### 3. Act

`computer_act` requires input permission. Workspace switching additionally
requires the workspace-switching setting. Coordinate actions require a prior
observation of the same window.

Cusco converts screenshot pixels back to the current window-frame coordinate
space before sending the action. This handles cases where PNG dimensions and
logical Mutter frame dimensions differ, such as HiDPI scaling. The extension
then adds the window's current frame origin and clamps the point to its bounds.

The Shell side uses Clutter virtual devices for pointer and keyboard events.
Supported actions are `focus`, `move`, `click`, `double_click`, `type`,
`keypress`, `scroll`, `drag`, and `switch_workspace`.

## Settings and permission layers

The feature has several independent gates:

```text
Computer use enabled
    ├── list windows/workspaces
    ├── capture enabled ── observe window
    └── input enabled ──── pointer/keyboard actions
            └── workspace switching enabled ── switch workspace
```

Tool registration also requires Agent mode in the chat, and every
computer-use tool currently uses Cusco's `ask` permission policy. The action
timeout applies to each app-to-Shell operation and is clamped to 5–120 seconds.

## Cancellation and emergency stop

`ComputerUseService` tracks every active D-Bus call with a `Gio.Cancellable`.
The first computer-use operation in an agent turn shows both stop controls.
They remain visible between observe/act calls while the agent decides its next
step, then hide when the turn completes or is cancelled.

Clicking the in-app control cancels active D-Bus work and the current provider
turn, presents Cusco, and focuses the composer. Clicking the Shell control also
invalidates long-running Shell work, emits `StopRequested`, activates Cusco's
window (including its workspace), and triggers the same app-side stop path.

Cancellation is cooperative. Typing and dragging check a generation counter
during their loops, and capture checks it after its focus delay. An input event
already delivered to another application cannot be rolled back.

## Extension installation lifecycle

Meson installs the extension directory below:

```text
<prefix>/share/gnome-shell/extensions/cusco-computer-use@stonega/
```

For a user build, `<prefix>` should normally be `$HOME/.local`. A running
Wayland Shell does not necessarily rescan a directory copied there during the
session. A full logout/login is required after the first raw install or an
extension replacement, followed by:

```sh
gnome-extensions enable cusco-computer-use@stonega
```

Until the extension is loaded, GNOME Shell owns `org.gnome.Shell` but the
Cusco object path does not exist. The app converts that D-Bus failure into an
installation/enablement hint in the settings status row.

## Failure behavior

- Unsupported desktop/session: rejected before contacting D-Bus.
- Computer use disabled: all operations are rejected app-side.
- Capability disabled: capture, input, or workspace switching is rejected
  independently.
- Missing observation: coordinate actions are rejected.
- Missing window/workspace: the Shell method returns a user-visible error.
- Shell extension disappears: active work is cancelled and registration is
  cleared.
- Operation timeout or provider cancellation: the active `Gio.Cancellable`
  stops the D-Bus request and hides the indicators.
- App shutdown: Cusco unregisters, disconnects signals, and removes screenshots.

## Current limitations

- Observation is screenshot-first; AT-SPI accessibility trees and OCR are not
  included in model context.
- A vision-capable provider/model is required for reliable coordinate selection.
- Virtual keyboard behavior needs broader testing with non-Latin input methods
  and custom keyboard layouts.
- The bridge uses GNOME Shell/Mutter extension APIs, so every new GNOME major
  release must be compatibility-tested. Metadata currently declares 45–50.
- Flatpak packaging needs a separate Shell-extension delivery and D-Bus
  permission design.
- Window screenshots may become stale after moving, resizing, or changing a
  window; the agent must observe again.
- Stop cannot reverse side effects already accepted by another application.

## Relevant tests

```sh
gjs -m tests/computer-use-smoke.js
gjs -m tests/import-smoke.js
glib-compile-schemas --strict --dry-run data
```

The smoke test validates tool schemas, permission gates, capture persistence,
coordinate remapping, and screenshot cleanup with a fake D-Bus proxy. Shell
integration still requires an interactive GNOME Wayland session test.
