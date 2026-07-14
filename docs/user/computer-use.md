# Computer use

Computer use lets a Cusco agent see and operate application windows on a
GNOME Wayland desktop. It can list windows, take a screenshot of one window,
click, type, scroll, drag, and switch GNOME workspaces.

The feature is Linux-only and disabled by default. Cusco keeps screen capture,
input control, and workspace switching behind separate settings so you can
grant only the access needed for a task.

## Requirements

- Linux with GNOME Shell on Wayland
- GNOME Shell 45–50
- An installed Cusco build and its `cusco-computer-use@stonega` Shell extension
- A vision-capable model for tasks that use screenshots
- Agent mode enabled in the current chat

Computer use does not support X11, KDE, Hyprland, macOS, or Windows.

## Install and enable the GNOME extension

The application and Shell extension must be installed under a prefix GNOME
searches. For a per-user source install, use `$HOME/.local`:

```sh
meson setup builddir --prefix "$HOME/.local"
meson compile -C builddir
meson install -C builddir
```

If `builddir` already exists, update its prefix first:

```sh
meson setup --reconfigure builddir --prefix "$HOME/.local"
meson compile -C builddir
meson install -C builddir
```

Confirm that Meson installed the extension:

```sh
test -f "$HOME/.local/share/gnome-shell/extensions/cusco-computer-use@stonega/extension.js" \
  && echo "Cusco extension files are installed"
```

GNOME Shell scans manually installed extensions when the Shell session starts.
On Wayland, **fully log out of GNOME and log back in** after the first install
or after replacing the extension. Closing Cusco, opening a new terminal, or
using Alt+F2 `r` does not restart GNOME Shell on Wayland.

After logging back in, enable and verify the extension:

```sh
gnome-extensions enable cusco-computer-use@stonega
gnome-extensions info cusco-computer-use@stonega
```

The `info` output should report the extension as enabled or active.

## Turn on computer use in Cusco

1. Start the installed Cusco application.
2. Open **Settings → Workspace → Computer Use**.
3. Turn on **Enable computer use**.
4. Turn on **Allow window capture** if the agent should see windows.
5. Turn on **Allow pointer and keyboard input** if the agent should interact
   with windows.
6. Turn on **Allow workspace switching** if the agent may move between GNOME
   workspaces.
7. Check that **GNOME Shell integration** says the integration is ready.
8. Enable **Agent** in the chat where you want to use it.

Computer-use tools use Cusco's normal tool approval flow. Enabling the settings
does not silently approve every action.

## Ask the agent to use the desktop

You can describe the task normally. For example:

- “List my open windows and tell me which workspace Firefox is on.”
- “Open the browser window, inspect the page, and click the Sign in button.”
- “Switch to workspace 2 and focus Terminal.”
- “Fill in this form, but stop before submitting it.”

Behind the scenes the agent follows a three-step tool workflow:

1. `computer_list` returns GNOME workspaces and controllable windows.
2. `computer_observe` focuses one window and captures it as a PNG for the next
   model turn.
3. `computer_act` performs one bounded action. The agent observes again after
   an action changes the screen.

Coordinates are relative to the most recent screenshot of that window. Cusco
automatically maps screenshot coordinates to the real window size, including
HiDPI scaling. A coordinate-based action is rejected until the window has been
observed.

## Available actions

| Action | What it does |
|---|---|
| `focus` | Focuses and unminimizes a window. |
| `move` | Moves the pointer to a window-relative position. |
| `click` | Clicks the left, middle, or right pointer button. |
| `double_click` | Double-clicks at a position. |
| `type` | Optionally clicks a position, then types text. |
| `keypress` | Sends a key or shortcut such as `CTRL` + `L`. |
| `scroll` | Scrolls horizontally or vertically at a position. |
| `drag` | Drags from one window-relative position to another. |
| `switch_workspace` | Activates a GNOME workspace by its zero-based index. |

## Stop immediately

After the first computer action in an agent turn, a cyan (`#42e6f5`) stop
control appears in the GNOME top panel and at the bottom of the Cusco window.
It remains visible until that turn completes or is cancelled. Click either one
to:

- cancel the current computer-use operation;
- stop the current provider turn;
- return to Cusco's workspace and window; and
- move keyboard focus back to the composer.

Stopping cannot undo a click, submitted form, sent message, or other action
that another application already received.

## Settings explained

| Setting | Effect |
|---|---|
| Enable computer use | Registers the three `computer_*` tools for Agent mode. |
| Allow window capture | Allows a selected window to be focused and captured. |
| Allow pointer and keyboard input | Allows focus, clicks, typing, shortcuts, scrolling, and dragging. |
| Allow workspace switching | Allows `switch_workspace`; input control must also be enabled. |
| Action timeout | Limits one Shell operation to 5–120 seconds. |
| GNOME Shell integration | Shows whether Cusco can register with the loaded extension. |

## Troubleshooting

### “Extension does not exist”

First check that the extension file exists:

```sh
ls "$HOME/.local/share/gnome-shell/extensions/cusco-computer-use@stonega/extension.js"
```

If it exists, fully log out and log back in, then run:

```sh
gnome-extensions list | grep '^cusco-computer-use@stonega$'
gnome-extensions enable cusco-computer-use@stonega
```

If the file does not exist, reinstall Cusco with the `$HOME/.local` prefix as
shown above.

### D-Bus `UnknownMethod` or “Object does not exist”

The extension files may be installed, but the running GNOME Shell has not
loaded the extension and therefore has not created
`/io/github/stonega/Cusco/ComputerUse`.

1. Fully log out and log back in.
2. Enable the extension with `gnome-extensions enable`.
3. Restart Cusco.
4. In **Settings → Workspace → Computer Use**, click the refresh button beside
   **GNOME Shell integration**.

### Integration is still unavailable

Check the extension state and recent Shell messages:

```sh
gnome-extensions info cusco-computer-use@stonega
journalctl -b _COMM=gnome-shell | grep -i 'cusco\|computer-use'
```

Also confirm that `echo "$XDG_SESSION_TYPE"` prints `wayland` and that
`echo "$XDG_CURRENT_DESKTOP"` includes `GNOME`.

### The model cannot understand the screenshot

Select a provider/model that accepts image input. Text-only models can list
window metadata but cannot reliably choose positions from a screenshot.

### A click uses the wrong position

Ask the agent to observe the window again. Window movement, resizing, or a
changed scale after the last observation can make old coordinates stale.

## Privacy and safety

- The Shell bridge accepts calls only from the registered running Cusco
  process. It also limits ownership to one Cusco D-Bus sender at a time.
- Screenshots are written with user-only permissions to a private per-Cusco
  session cache and deleted when the Cusco window closes.
- Captures contain only the selected window rectangle, although popovers or
  overlapping Shell content inside that rectangle may still be visible.
- Input control is disabled independently by default.
- Typed text is limited to 10,000 characters per action.
- A screenshot is limited to 25 MB.
- Treat desktop automation like giving another person temporary control of
  your session. Keep sensitive windows closed and supervise important actions.

For implementation details, see
[GNOME computer-use architecture](../implementation/computer-use.md).
