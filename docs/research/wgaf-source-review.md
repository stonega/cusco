# WGAF source review

Date: 2026-08-07

Repository: [Ranrar/wgaf](https://github.com/Ranrar/wgaf)

Reviewed revision: [`ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e`](https://github.com/Ranrar/wgaf/tree/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e) (`0.8.3`)

## Conclusion

WGAF is a useful reference implementation, but it should not replace Cusco's
computer-use system or become a runtime dependency in its current form.

WGAF adds a Rust daemon, a CLI, a second GNOME Shell extension, a systemd user
service, and account-wide `/dev/uinput` access. Cusco already provides the
pieces an agent needs: window capture, window-relative actions, workspace
control, AT-SPI observation, an active-use indicator, and cancellation tied to
the active provider turn.

The recommended direction is:

- keep Cusco's current GNOME Shell extension and AT-SPI integration;
- borrow WGAF's strongest implementation ideas, such as typed D-Bus errors,
  input rate limits, keyboard-layout handling, focus verification, and explicit
  capability policy;
- retain Cusco's single-client ownership and whole-turn emergency stop;
- make input injection replaceable so a portal-authorized `libei` backend can
  be evaluated later without replacing capture, accessibility, or agent
  orchestration.

## Architecture

WGAF combines three desktop mechanisms behind a session D-Bus daemon:

```text
wgaf CLI
    │
    ▼
wgaf-daemon
    ├── GNOME Shell extension ── windows, workspaces, absolute pointer movement
    ├── /dev/uinput ──────────── relative pointer, clicks, scrolling, keyboard
    └── AT-SPI ───────────────── accessibility discovery and actions
```

The Rust workspace contains:

- `wgaf-common`: shared D-Bus records, names, and errors;
- `wgaf-daemon`: D-Bus APIs, permissions, window bridge, input, and AT-SPI;
- `wgaf-cli`: the user-facing command line.

The daemon exports `org.wgaf.Daemon1`, `org.wgaf.Windows1`,
`org.wgaf.Input1`, and `org.wgaf.Accessibility1`. The Shell extension exports
`org.gnome.Shell.Extensions.Wgaf.V1` separately.

## Findings

### Critical: the daemon permission boundary can be bypassed

The Shell extension exposes mutating methods directly on the user's session
bus, including `FocusWindow`, `MoveWindow`, `ResizeWindow`, `CloseWindow`,
workspace mutations, and `WarpPointer`. The exported implementation does not
authenticate or bind callers to `wgaf-daemon`.

- [Exported D-Bus contract](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/extension/dbusInterface.js#L59-L127)
- [Unauthenticated method implementation](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/extension/dbusInterface.js#L266-L387)
- [Object export and well-known name ownership](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/extension/extension.js#L85-L110)

Any process able to access the user's session bus can call this bridge
directly, bypassing WGAF's capability policy and audit logging. This
contradicts the architectural claim that nothing reaches the three backends
directly and that every mutation passes through the daemon.

- [README boundary claim](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/README.md#L175-L184)

Cusco has a better accidental-misuse boundary: its extension binds computer
use to one registered D-Bus sender, verifies the claimed PID against D-Bus,
and rejects privileged calls from other senders. This is still not a security
boundary against a determined process running as the same user, because the
command-line identity check can be imitated, but it prevents arbitrary clients
from invoking an already-owned bridge.

- [Cusco registration and sender binding](../../data/gnome-shell/extensions/cusco-computer-use@stonega/extension.js#L404)
- [Cusco registered-client check](../../data/gnome-shell/extensions/cusco-computer-use@stonega/extension.js#L317)

### High: the emergency stop does not stop the whole automation system

`org.wgaf.Daemon1.Stop` calls only `InputBackend::stop`. It stops and destroys
the `/dev/uinput` device, but it does not cancel the calling script or agent and
does not disable the windows or accessibility interfaces.

- [Daemon Stop implementation](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/dbus/mod.rs#L133-L160)
- [InputBackend stop implementation](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/input/mod.rs#L538-L580)

Absolute pointer movement is part of `org.wgaf.Input1`, but it calls the Shell
extension directly instead of the stopped input backend. It therefore remains
available after the emergency stop. Window focus, movement, closing, workspace
changes, AT-SPI invocation, text setting, and element focus also remain
available.

- [Absolute pointer path bypassing InputBackend](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/dbus/input_api.rs#L730-L779)

`Release` is intentionally ungated and callable by anything on the session
bus. A different client can therefore lift the brake after the user stops the
system. For a generic CLI tool this can be documented as part of its threat
model; for an AI agent it is insufficient because the active model turn must
also be cancelled.

Cusco's stop path cancels the active turn and every registered operation
cancellable, then deactivates the Shell-side action generation. Losing the
extension also triggers the same cancellation path.

- [Cusco stop and cancellation](../../src/computerUse/service.js#L2241)
- [Cusco extension-loss cancellation](../../src/computerUse/service.js#L976)

### High: `/dev/uinput` access is broader than WGAF's policy

WGAF's installation guide creates an `input`-group udev rule for `/dev/uinput`
and adds the account to that group.

- [WGAF uinput installation](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/docs/installation.md#L26-L41)

The source correctly acknowledges that the rate limiter and capability policy
are safety features, not security controls: any process running as that user
can open `/dev/uinput` directly and bypass WGAF.

- [Documented uinput threat model](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/input/rate_limit.rs#L1-L17)

Membership in a distribution's general `input` group may also grant access to
physical input event devices. A design that must use `uinput` should prefer a
dedicated group or narrowly scoped device ACL rather than the general `input`
group. Cusco's current Clutter-based Shell extension does not require a root
udev change or account-wide kernel input permission.

### Medium: prompt decisions are shared by every caller

Prompt decisions are cached in a daemon-wide `HashMap<Capability, bool>`. The
key contains no D-Bus sender, PID, application identity, or client session.

- [Global prompt cache](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/permissions/mod.rs#L126-L147)
- [Prompt resolution and caching](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/permissions/mod.rs#L250-L288)

Once the user allows a prompted capability for one client, every later client
inherits that decision for the rest of the daemon run. The notification says
only that a script or CLI command made the request and does not identify the
requesting process.

- [Prompt notification text](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/permissions/notify.rs#L139-L155)

For an agent-facing service, prompt decisions should be scoped to the owning
client or explicit automation session and should name that client in the user
interface.

### Medium: read-only desktop information is deliberately ungated

Window listings, workspace layout, monitor information, application listings,
AT-SPI element search, UI trees, and element information have no capability
gate.

- [Ungated read API policy](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/permissions/policy.rs#L35-L43)

Some of this information is already available to unsandboxed same-user
processes through AT-SPI or the session environment, but WGAF's policy should
not be described as complete desktop privacy isolation.

### Medium: Escape remains captured after the first input command

The virtual input device is created on first use and retained until `Stop`
drops it. The Shell extension arms Escape whenever the device-present property
is true.

- [Persistent input-device slot](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/input/mod.rs#L359-L371)
- [Device creation and presence publication](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/input/mod.rs#L943-L1012)
- [Extension Escape lifecycle](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/extension/extension.js#L186-L237)

Consequently, after the first input command finishes, Escape remains reserved
until the user stops WGAF. This differs from the documentation's statement
that Escape belongs to WGAF only while automation is actually running.

- [README Escape claim](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/README.md#L248-L258)

### Medium: first-input readiness uses a fixed delay

The daemon waits 300 ms after creating the uinput device so udev and the
compositor can discover it. The source explicitly documents that this widens a
race rather than proving readiness and may silently lose the first input
command on a slower machine.

- [Readiness workaround and intended fix](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/input/mod.rs#L55-L89)

The intended fix—observing that the compositor has opened the generated event
device—has not been implemented.

### Medium: the secure-file check has a path replacement race

`read_trusted` first calls `metadata(path)` and later calls
`read_to_string(path)`. Those are two path resolutions, so the checked object
can differ from the object that is read if the directory permits replacement.
The code comment claims the opposite.

- [Secure-file implementation](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/wgaf-daemon/src/secure_file.rs#L103-L168)

A descriptor-based implementation should open the file with suitable flags,
inspect that same descriptor with `fstat`, and then read from it. Parent
directory ownership and writability also matter if root-owned configuration is
intended to be stricter than user-owned configuration.

### Medium: WGAF is not yet an AI computer-use runtime

WGAF provides useful generic desktop primitives, but its own roadmap still
lists screenshots and an MCP server as future work.

- [Screenshot and MCP roadmap](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/README.md#L98-L116)

It also documents that clicks are not target-bound: they go to the current
pointer location and focus, with no equivalent to the keyboard commands'
optional `--window` verification.

- [Known targeting limitations](https://github.com/Ranrar/wgaf/blob/ffdf76f103ea8e1e7bf648b7d09bf539a9651b4e/README.md#L286-L298)

Cusco already has Shell screenshot capture, normalized window-relative
coordinates, action-result observation, popup guards, visual-change checks,
AT-SPI snapshots, and provider-turn cancellation. Adopting WGAF wholesale
would duplicate these systems while losing their shared lifecycle.

- [Cusco computer-use architecture](../implementation/computer-use.md)
- [Cusco Shell capture](../../data/gnome-shell/extensions/cusco-computer-use@stonega/extension.js#L500)

### Low: documentation and release hygiene have drift

- The configuration guide says there are nineteen gated capabilities, but the
  table and `Capability` enum contain twenty.
- Source comments refer to an `issues.md` and ADR paths that are not present in
  the repository.
- `cargo fmt --all --check` fails on the reviewed release commit.
- The project declares no Rust `rust-version`; its locked `zbus 5.18.0`
  dependency rejects Rust 1.85 and requires Rust 1.87 or newer, while the
  installation guide says only "a recent Rust toolchain."

These are not fundamental architectural defects, but they matter because the
project was created on 2026-07-26, had 43 commits from one author at review
time, and had no Git tags. Real-desktop behavior has had much less independent
validation than the unit-test count suggests.

## Positive observations

WGAF also contains substantial good engineering:

- clear separation between CLI, shared protocol types, daemon APIs, and
  desktop backends;
- typed D-Bus errors and tests that detect protocol/interface drift;
- extensive comments explaining invariants and failure modes;
- per-capability policy with explicit `Allow`, `Deny`, and `Prompt` values;
- caller PID and process-name attribution in permission audit logs;
- rate limits, maximum text size, reverse-order modifier release, and
  per-keystroke stop checks;
- full-string keyboard planning before input begins;
- Wayland keymap and `libxkbcommon` support for non-US layouts;
- targeted keyboard calls that verify and periodically re-check window focus;
- bounded AT-SPI traversal with depth, node, and result limits;
- safe separation of ordinary tests from tests that take over the real desktop;
- strict ownership and mode checks for configuration files, aside from the
  path-replacement issue described above.

These are suitable ideas to adapt into Cusco behind Cusco's existing
single-client, turn-owned lifecycle.

## Verification performed

The complete repository was cloned into a temporary review directory and left
unmodified. No binaries, daemon, Shell extension, systemd service, udev rule,
or group membership were installed.

The following safe checks were run:

| Check | Result |
|---|---|
| `cargo +1.88.0 build --locked --offline --workspace --all-targets` | Passed |
| `cargo +1.88.0 clippy --locked --offline --workspace --all-targets -- -D warnings` | Passed |
| `dbus-run-session -- cargo +1.88.0 test --locked --offline --workspace --bins --lib` | 278 passed, 2 ignored |
| Safe daemon D-Bus integration suites | 40 passed, 5 real-desktop tests ignored |
| `make test-extension` | Passed |
| `cargo +1.88.0 test --locked --offline --workspace --doc` | Passed; no doctests defined |
| `cargo +1.88.0 fmt --all -- --check` | Failed on one formatting diff in `wgaf-cli/src/main.rs` |

The ignored integration tests synthesize real keyboard and pointer input or
require a live GNOME/AT-SPI desktop. They were not run because doing so would
take over the active desktop and require `/dev/uinput` privileges. Dependency
vulnerability scanning was not performed because `cargo-audit` was not
installed; no new review tools were installed into the environment.

## WGAF, libei, and Cusco

WGAF and `libei` are not equivalent choices. WGAF is a desktop automation
service; `libei` is an emulated-input protocol and client/server library.

| Area | WGAF | `libei` through RemoteDesktop | Cusco currently |
|---|---|---|---|
| Input mechanism | `/dev/uinput` plus Shell pointer warp | Compositor-controlled EIS connection | Clutter virtual devices inside the Shell extension |
| Authorization | WGAF policy, bypassable through its extension and kernel device | Portal-created, compositor-controlled session | One registered Cusco D-Bus sender plus Cusco settings |
| System setup | udev rule, group membership, daemon, and extension | Portal/backend and native `libei` client dependency | User-installed Shell extension |
| Window control | WGAF Shell extension | Not provided by `libei` | Cusco Shell extension |
| Screenshot capture | Planned | Separate ScreenCast/PipeWire concern | Already integrated with `Shell.Screenshot` |
| Accessibility | AT-SPI daemon API | Not provided | Integrated AT-SPI snapshot and action service |
| Agent lifecycle | Not managed | Application responsibility | Owned by the active Cusco provider turn |
| Background operation | Yes while services remain active | Yes while the authorized portal session remains alive | Yes while Cusco remains open and the turn is active |

The [official libei documentation](https://libinput.pages.freedesktop.org/libei/)
describes an EI client connected to an EIS implementation, normally the
Wayland compositor. Emulated events remain distinguishable inside the
compositor, allowing it to decide which events are permitted and when.

The
[XDG RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
provides the user-visible session and permission lifecycle. Its `ConnectToEIS`
method returns a file descriptor that a `libei` sender uses for input. Screen
content is a separate ScreenCast/PipeWire selection that can share the same
portal session.

This is a better long-term security model than granting the account direct
`/dev/uinput` access, but it has integration costs:

- portal consent and session restoration must fit Cusco's user experience;
- `libei` is a native C API rather than a ready GJS service;
- Cusco would likely need a small native helper or maintained bindings;
- input device, keymap, region, pause/resume, disconnect, and neutral-state
  handling become explicit application responsibilities;
- `libei` does not replace window discovery, screenshots, AT-SPI, agent safety,
  or action verification.

## Recommended implementation direction

1. Keep the current Cusco Shell/Clutter backend for production GNOME support.
2. Define a narrow app-side input backend contract for pointer movement,
   buttons, scrolling, key events, text input, cancellation, and capability
   reporting.
3. Preserve Shell capture, window control, AT-SPI, coordinate mapping, visual
   verification, and turn cancellation above that contract.
4. Strengthen Shell registration beyond command-line substring recognition if
   a stronger same-user threat model is required.
5. Add WGAF-inspired rate limiting, explicit input burst limits, and periodic
   target-focus verification where they improve Cusco's current safeguards.
6. Build a separate `libei`/RemoteDesktop experiment and evaluate portal UX,
   GNOME version support, packaging, keymap behavior, multi-monitor regions,
   and emergency cancellation before considering it the default backend.
7. Do not integrate WGAF as a daemon dependency or grant the account general
   `input`-group access.

The resulting architecture keeps the behavior the product needs—computer use
continuing while Cusco's window remains open and unfocused—without separating
desktop actions from the agent turn that owns and must be able to stop them.
