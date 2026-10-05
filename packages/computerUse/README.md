# Computer use

GNOME computer-use protocol validation, accessibility snapshots, screenshot
analysis, the GNOME Shell D-Bus service client, and a managed headless GNOME
session for background computer use. `manager.js` starts each agent turn on
Background and routes calls to Current desktop when selected through
`computer_list`. `backgroundSession.js` owns the private session lifecycle;
`backgroundAccessibilityHost.js` runs AT-SPI inside that session.

The AI tool-description adapter and GTK settings remain in `src/computerUse/`
and `src/settings/`.

The preview's Take over action cancels the owning agent turn while preserving
the background session. The manager blocks agent operations during manual
control and routes `DesktopInput` only to that private session. Closing the
view or choosing Stop controlling releases held keys and buttons; the agent
turn stays stopped. Desktop input does not use the agent's input permission
setting, because it comes directly from the user. The additive `DesktopInput`
method is bundled with newly started background sessions.
