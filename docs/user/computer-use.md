# Computer use

Computer use lets a Cusco agent see and operate application windows on a
GNOME Wayland desktop. It can list windows, take a screenshot of one window,
click, type, scroll, drag, and switch GNOME workspaces.
It can also create a workspace, move a window there, and maximize supported
windows.

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

### Update only the extension

To package and update the computer-use extension without rebuilding or
installing the Cusco application, run this from the repository root:

```sh
scripts/update-computer-use-extension.sh
```

The script packages the extension with `gnome-extensions pack` and installs
the bundle for the current user with overwrite enabled. To create the bundle
without updating the installed extension, use:

```sh
scripts/update-computer-use-extension.sh --build-only
```

The bundle is written beneath `builddir/gnome-shell-extension/`. After an
update, fully log out of GNOME and log back in, enable the extension, and
restart Cusco as described above.

## Turn on computer use in Cusco

1. Start the installed Cusco application.
2. Open **Settings → Workspace → Computer Use**.
3. Turn on **Enable computer use**.
4. Turn on **Allow window capture** if the agent should see windows.
5. Turn on **Allow pointer and keyboard input** if the agent should interact
   with windows.
6. Turn on **Allow workspace switching** if the agent may create or activate
   GNOME workspaces and move windows between them.
7. Check that **GNOME Shell integration** says the integration is ready.
8. Enable **Agent** in the chat where you want to use it.

Computer-use tools use Cusco's normal tool approval flow. Enabling the settings
does not silently approve every action.

## Ask the agent to use the desktop

You can describe the task normally. For example:

- “List my open windows and tell me which workspace Firefox is on.”
- “Open the browser window, inspect the page, and click the Sign in button.”
- “Open Calculator in a new workspace.”
- “Switch to workspace 2 and focus Terminal.”
- “Fill in this form, but stop before submitting it.”

Behind the scenes the agent follows this tool workflow:

1. `computer_list` returns GNOME workspaces and controllable windows.
2. `computer_observe` focuses one window and captures it as a PNG for the next
   model turn. The model receives a synthetic `0`–`1000` grid drawn on a copy;
   the clean screenshot remains unchanged for verification.
3. `computer_observe_region` enlarges a selected part of the latest screenshot
   when a target is small or an earlier visual click did not change the screen.
4. `computer_step` performs one or more safe actions and returns the updated
   screenshot in the same tool call. It also reports unchanged screens so the
   agent can stop retrying a missed target.
5. `computer_act` creates and switches workspaces, launches through global
   keyboard input, and performs individual actions that do not need an
   immediate screenshot.

When the agent launches an application, its Computer Use rule first creates
and activates a new workspace. After the new window appears, the agent checks
that it is on that workspace, moves it there if necessary, and maximizes it
when the window supports maximizing. If workspace creation is unavailable, the
agent should report that constraint instead of silently launching on an
occupied workspace.

`computer_step` uses normalized coordinates from 0 to 1000. Cusco automatically
maps them to the real window size, including HiDPI scaling. Each observation
has an ID, and an action that explicitly references an older observation is
rejected rather than clicking against a stale layout.

Grid lines and labels are targeting aids added by Cusco; they are not part of
the application. Region observations use their own local `0`–`1000` space and
Cusco maps the point back to the full window automatically. After two visual
click attempts leave the screen unchanged, further full-window coordinate
clicks are blocked until the agent changes strategy. Coordinate clicks and
typing are deliberately split into separate steps so a missed click cannot
send text to the wrong target.

When an application exposes desktop accessibility information, observations
also include named elements such as buttons and text fields. The agent can
activate or fill these elements by reference instead of estimating pixels.
Focusable rows without a direct click action are activated with Return. If an
application reports duplicate or out-of-window element positions, Cusco hides
those unreliable bounds while preserving the named reference. In a search
result list, the agent prefers keyboard selection; coordinate navigation is
only considered verified when the requested destination appears afterward.
Not every GNOME application or custom-drawn surface exposes this information,
so Cusco always keeps the application-independent visual fallback available.

## Available actions

| Action | What it does |
|---|---|
| `create_workspace` | Creates and activates a new GNOME workspace. |
| `focus` | Focuses and unminimizes a window. |
| `maximize` | Maximizes a window when the application supports it. |
| `move_to_workspace` | Moves a window to a workspace by zero-based index. |
| `move` | Moves the pointer to a window-relative position. |
| `click` | Clicks the left, middle, or right pointer button. |
| `double_click` | Double-clicks at a position. |
| `type` | Types text into the current focus. `computer_act` retains optional coordinate targeting for compatibility; safe stepped workflows click and verify first. |
| `keypress` | Sends a key or shortcut such as `CTRL` + `L`. |
| `scroll` | Scrolls horizontally or vertically at a position. |
| `drag` | Drags from one window-relative position to another. |
| `switch_workspace` | Activates a GNOME workspace by its zero-based index. |

## Stop immediately

After the first computer action in an agent turn, a cyan (`#42e6f5`) stop
control appears in the GNOME top panel. It combines the computer-use icon with
a short status such as **Viewing Firefox** or **Typing in Terminal**. Long
window titles end in an ellipsis, and Cusco never shows the text being typed.
Cusco does not add a second banner; the composer instead shows **Esc to quit**
in the same cyan. The indicators remain visible until that turn completes or
is cancelled. Click the Shell control or press Escape in Cusco to:

- cancel the current computer-use operation;
- stop the current provider turn;
- return to Cusco's workspace and window; and
- move keyboard focus back to the composer.

Stopping cannot undo a click, submitted form, sent message, or other action
that another application already received.

## Settings explained

| Setting | Effect |
|---|---|
| Enable computer use | Registers the four `computer_*` tools for Agent mode. |
| Allow window capture | Allows a selected window to be focused and captured. |
| Allow pointer and keyboard input | Allows focus, clicks, typing, shortcuts, scrolling, and dragging. |
| Allow workspace switching | Allows workspace creation, activation, and window moves; input control must also be enabled. |
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
