# Computer use

GNOME computer-use protocol validation, accessibility snapshots, screenshot
analysis, the GNOME Shell D-Bus service client, and a managed headless GNOME
session for background computer use. `manager.js` starts each agent turn on
Background and routes calls to Current desktop when selected through
`computer_list`. `backgroundSession.js` owns the private session lifecycle;
`backgroundAccessibilityHost.js` runs AT-SPI inside that session.

The AI tool-description adapter and GTK settings remain in `src/computerUse/`
and `src/settings/`.
