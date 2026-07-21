# GNOME computer-use architecture

This document explains how Cusco's Linux-only computer-use implementation is
put together. For installation and everyday use, start with the
[user guide](../user/computer-use.md).

## Design goals

- Support GNOME Shell on Wayland directly.
- Avoid a cross-platform backend-selection layer.
- Keep capture, input, and workspace switching separately user-controlled.
- Give the user a centered Shell emergency stop and a desktop-wide Escape path.
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
computer_list / computer_observe / computer_observe_region / computer_step / computer_act
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
| Image views | `src/computerUse/imageViews.js` | Creates model-only coordinate grids and enlarged region views without altering clean screenshots. |
| Accessibility adapter | `src/computerUse/accessibility.js` | Reads AT-SPI interactive elements and executes verified semantic activation and text actions. |
| Settings UI | `src/settings/computerUseSettings.js` | Exposes capability switches, timeout, and live integration status. |
| Window integration | `src/window.js` | Registers tools, attaches observations, displays the cyan Escape hint, and stops the provider turn. |
| Shell extension | `data/gnome-shell/extensions/cusco-computer-use@stonega/` | Performs GNOME-specific discovery, capture, input, workspace creation/window movement, maximizing, and top-panel UI. |
| Persistent settings | `data/io.github.stonega.Cusco.gschema.xml` | Stores the feature and capability gates in GSettings. |

## D-Bus contract

The extension exports this interface on the user's session bus:

```text
Bus name:   org.gnome.Shell
Object:     /io/github/stonega/Cusco/ComputerUse
Interface:  io.github.stonega.Cusco.ComputerUse
Protocol:   4
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
| `CaptureWindowPassive(id)` | Captures a window without activating it for a just-in-time stale-state check. |
| `PerformAction(json)` | Performs one validated input or workspace action. |
| `StopRequested` | Tells Cusco that the Shell stop control was clicked. |

Payloads are JSON strings inside typed D-Bus parameters. App and extension
both require protocol version `6`; a version mismatch is shown in settings
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
  frame rectangle, focus/minimized/maximized state, maximize support, and
  sticky-workspace state; and
- the GNOME stage dimensions.

Skip-taskbar windows are omitted.

### 2. Observe

`computer_observe` requires capture permission and a window ID from the list.
The extension unminimizes and focuses the window only when it is not already
focused, waits briefly for it to settle, then captures its frame rectangle
with `Shell.Screenshot`. Avoiding redundant activation preserves the focused
child control in browsers and other multi-process applications.

The extension returns base64 PNG data over D-Bus. The service:

1. rejects empty data and images larger than 25 MB;
2. writes the PNG with mode `0600` inside a mode `0700` per-window session
   directory under the user cache;
3. scales the clean model-sized screenshot to at most 1600 pixels on its
   longest edge;
4. fingerprints that clean image and creates a downscaled visual signature for
   cursor-insensitive change detection;
5. creates a same-size Cairo-rendered copy with a synthetic normalized grid;
6. records an observation ID plus screenshot and window-frame dimensions for
   coordinate mapping; and
7. attaches the gridded copy to the next model turn while retaining the clean
   path for UI display, cropping, and verification.

The grid uses `0`–`1000` independently on both axes, with major lines every
100 units and minor lines every 50 units. It never changes image dimensions,
adds padding, or participates in the screenshot fingerprint. If grid rendering
fails, capture remains usable and the clean image is attached as a fallback.

When the target application exposes AT-SPI, the observation also contains a
bounded list of visible interactive elements. Each element has an
observation-scoped reference, role, accessible name, state, and normalized
bounds. Duplicate or out-of-window AT-SPI geometry is marked unreliable and
the element's bounds are returned as `null`, while its name and semantic ref
remain available. Password text values are never exposed. Applications that
do not publish an accessibility tree continue through visual targeting.

The cache directory is recursively removed when the Cusco window shuts down.

### 3. Region observation

`computer_observe_region` derives an enlarged view from the latest clean
screenshot without capturing the application again. Its region is expressed
in normalized coordinates relative to the referenced full or region view.
Pixel rounding is recorded and the effective crop is mapped back to the root
window frame, so coordinates from the enlarged image remain exact.

Each region receives its own observation ID and records its parent and root
observation IDs. A later `computer_step` can use the region ID directly; its
`0`–`1000` coordinates are local to that enlarged view. Capturing a new full
window invalidates all region views derived from the previous screenshot.
AT-SPI elements with reliable bounds are filtered to the crop and remapped to
the local coordinate space. The workflow contains no application-specific
browser, toolkit, or DOM integration.

### 4. Step

`computer_step` is the preferred window-control tool. It accepts up to eight
actions for one window, using normalized coordinates from `0` to `1000`, then
waits briefly and captures the resulting window in the same tool call. The
result reports whether the screenshot changed meaningfully, whether the target
window is focused, and whether repeated unchanged steps indicate a stall.
Before dispatch, the app validates every action, key name, coordinate, target
window, and observation ID in the batch. Invalid later actions therefore
cannot leave an otherwise valid prefix partially executed.

Immediately before each coordinate-bearing action, the service calls
`CaptureWindowPassive`. That capture does not activate the target or wait for
focus to settle. Cusco compares it with the clean root image behind the
referenced full or region observation and also requires the target window to
still be focused. If a menu closed, a popover changed, the page moved, or focus
left the window, the step returns `stale_observation`, a fresh screenshot and
observation ID, and `preAction.actionDispatched: false`. `PerformAction` is not
called, so an old point cannot land on the control that replaced the intended
target.

An arbitrary explicit coordinate click cannot be batched with later text input
or key presses. One coordinate-bearing `paste_text` or `type` action is allowed
when it is the only action in the step: the Shell bridge focuses the point and
waits briefly for field focus to settle. `paste_text` then sets the supplied
UTF-8 value through `St.Clipboard` and dispatches Ctrl+V; it intentionally
leaves that value on the desktop clipboard. `type` sends virtual key values and
remains the fallback for sensitive values and fields that reject paste.
`replace: true` adds Ctrl+A before either input method so an existing visual
field can be replaced safely. At the model-facing tool boundary, equivalent
click and optional Ctrl+A input patterns are normalized into those atomic
actions; other click-and-keyboard batches remain rejected. This is the visual
fallback for a text field when AT-SPI is unavailable. After two meaningfully
unchanged coordinate steps, full-window coordinate targeting is blocked. A
region observation, semantic action, keyboard strategy, fresh explicit
observation, or user help provides a deliberate recovery path.

The passive stale-state check narrows but cannot eliminate runtime races after
the check, such as a window closing or the Shell rejecting an action after
earlier actions completed. In that case the step
stops immediately, records the failed action index and confirmed completed
count, and attempts a fresh post-action observation. The tool response tells
the Agent to continue from that screenshot instead of replaying the whole
batch. A screenshot failure is also represented in the structured failure;
raw D-Bus error prefixes are removed from user and model-facing messages.

Change detection compares downscaled RGB signatures with a small changed-pixel
threshold. Pointer movement, a blinking caret, and compression noise therefore
do not reset stall detection by themselves. The exact fingerprint remains
available as a fallback if a visual signature cannot be created.

When semantic elements are available, `click_element` invokes the element's
AT-SPI action. If a focusable element exposes no action, Cusco focuses it and
dispatches Return, leaving final verification to the post-action observation
or an explicit expectation. `set_text_element` uses the editable-text
interface and reads the value back to verify the change. Element references
expire on the next observation.

For search results, the Agent prompt prefers keyboard selection over estimated
row coordinates. Coordinate clicks that choose a named item or navigate to a
new view should include an expectation for the intended destination; without
one, the tool reports `coordinateActionVerified: null` and
`visualConfirmationRequired: true`. This means semantic verification was not
available; it is not an action failure. A real failure is represented by the
step's `failed` field and structured `failure` object.

For deterministic typing or pasting, the Agent treats its known payload as
intact when the intended field becomes visibly nonempty and the application
shows no error. It does not use screenshot text recognition to compare or
repair individual characters in opaque values such as wallet addresses,
hashes, IDs, and URLs, because horizontally scrolled inputs can hide a valid
prefix. The complete value is retried only after positive failure evidence or
a machine-readable value mismatch.

Before attaching a step or observation image to the provider, Cusco removes
older computer-use image attachments from the live Agent runtime. Textual tool
history remains available, but only the latest desktop screenshot consumes
image context.

### 5. Act

`computer_act` requires input permission. Workspace creation, activation, and
window movement additionally require the workspace-switching setting.
Coordinate actions require a prior observation of the same window.

Cusco converts either screenshot pixels or normalized `0`–`1000` coordinates
back to the current window-frame coordinate space before sending the action.
This handles resized model screenshots and cases where PNG dimensions and
logical Mutter frame dimensions differ, such as HiDPI scaling. Actions may
include the latest observation ID; stale IDs are rejected. The extension then
adds the window's current frame origin and clamps the point to its bounds.

Coordinate action results include the model-requested point, its model-image
pixel position, the mapped window-relative point, and the final clamped desktop
point reported by the Shell extension. `dispatchStatus: dispatched` only means
that the virtual input event was sent; it does not claim the application
accepted it.

The Shell side uses Clutter virtual devices for pointer and keyboard events.
Before capture or input it activates the target only when the window is not
already focused; repeated activation must not replace a focused web control
with browser chrome focus.
Supported actions are `focus`, `move`, `click`, `double_click`, `paste_text`, `type`,
`keypress`, `scroll`, `drag`, `create_workspace`, `switch_workspace`,
`move_to_workspace`, and `maximize`. Global `paste_text`, `type`, and `keypress` actions may
omit a window ID, allowing the GNOME overview to launch an app without
reactivating a window on an older workspace.

The Agent prompt treats app launch as a guarded sequence: create and activate
a workspace, launch there, list the resulting windows, move the new window
back if the application placed it elsewhere, and maximize it when supported.

## Settings and permission layers

The feature has several independent gates:

```text
Computer use enabled
    ├── list windows/workspaces
    ├── capture enabled ── observe window
    └── input enabled ──── pointer/keyboard actions
            └── workspace switching enabled ── create/switch workspace, move window
```

Tool registration also requires Agent mode in the chat, and every
computer-use tool currently uses Cusco's `ask` permission policy. The action
timeout applies to each app-to-Shell operation and is clamped to 5–120 seconds.

## Cancellation and emergency stop

`ComputerUseService` tracks every active D-Bus call with a `Gio.Cancellable`.
The first computer-use operation in an agent turn shows the Shell stop control
with its cyan icon and a short description of the current operation, such as
**Viewing Firefox** or **Typing in Terminal**. It occupies the panel center and
temporarily hides the existing center actors while preserving each actor's
previous visibility. Those actors are restored when the control hides. Window
titles are collapsed to one line and the complete status is limited to 36
characters with an ending ellipsis. Typed content is never included. The
control and the composer's cyan **Esc to quit** hint remain visible between
observe/act calls while the agent decides its next step, then hide when the
turn completes or is cancelled.

While active, the extension temporarily grabs the bare Escape accelerator from
Mutter, so Escape works even while Chrome or another client window has focus.
It releases the accelerator immediately on stop. Escape and a click on the
Shell control both invalidate long-running Shell work, emit `StopRequested`,
activate Cusco's window (including its workspace), and trigger the same
app-side stop path. Cusco also prioritizes this stop path over question and
composer Escape handling when its own window has focus.

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

For extension-only development, `scripts/update-computer-use-extension.sh`
packages this directory and updates the current user's installed extension
without running Meson or installing the Cusco application. Pass `--build-only`
to create the bundle without installing it.

Until the extension is loaded, GNOME Shell owns `org.gnome.Shell` but the
Cusco object path does not exist. The app converts that D-Bus failure into an
installation/enablement hint in the settings status row.

## Failure behavior

- Unsupported desktop/session: rejected before contacting D-Bus.
- Computer use disabled: all operations are rejected app-side.
- Capability disabled: capture, input, or workspace switching is rejected
  independently.
- Missing observation: coordinate actions are rejected.
- Invalid step action: the entire batch is rejected before input is dispatched.
- Missing window/workspace: the Shell method returns a user-visible error.
- Runtime failure after an earlier step action: the completed prefix, failed
  index, normalized reason, and best-effort post-action screenshot are returned
  so the Agent can recover without replaying completed input.
- Shell extension disappears: active work is cancelled and registration is
  cleared.
- Operation timeout or provider cancellation: the active `Gio.Cancellable`
  stops the D-Bus request and hides the Shell indicator and Escape highlight.
- App shutdown: Cusco unregisters, disconnects signals, and removes screenshots.

## Current limitations

- Chrome and some Electron configurations do not expose AT-SPI unless browser
  accessibility is enabled. These windows continue to require visual
  targeting; OCR and a browser-specific adapter are not yet included.
- A vision-capable provider/model is required for reliable coordinate selection.
- Virtual keyboard behavior needs broader testing with non-Latin input methods
  and custom keyboard layouts.
- The bridge uses GNOME Shell/Mutter extension APIs, so every new GNOME major
  release must be compatibility-tested. Metadata currently declares 45–50.
- Flatpak packaging needs a separate Shell-extension delivery and D-Bus
  permission design.
- Screenshot-only actions cannot confirm which application element received an
  input event. Post-action capture detects visible changes, while semantic
  verification is available only when the target exposes an AT-SPI element.
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
