# Installation

<!-- Adapted for Cusco; see ../../../NOTICE. -->

Cusco's MCP preset does not require the CLI or a global npm install. Use the CLI
only for requested shell automation. It starts a separate daemon with its own
configuration; it does not inherit the MCP preset. The command below explicitly
attaches to the same running Chrome profile.

Run the pinned CLI without changing global packages:

```sh
npx -y --package=chrome-devtools-mcp@1.9.0 chrome-devtools --help
```

In the skill's examples, replace `chrome-devtools` with that npx invocation if
the command is not installed. To match the preset's telemetry choices and keep
file access scoped, start a task-owned CLI session with:

```sh
npx -y --package=chrome-devtools-mcp@1.9.0 chrome-devtools start --auto-connect --category-extensions --workspace=/absolute/path/to/project --no-usage-statistics --no-performance-crux
```

Check `start --help` for supported options. Stop a daemon started for this task
when finished; do not restart or stop another task's existing daemon.
Use Chrome 149+ with remote debugging enabled and accept Chrome's Allow prompt.
Follow the shared task-group workflow before navigating to a target.

If the user wants a persistent global CLI command, install it once:

```sh
npm i chrome-devtools-mcp@1.9.0 -g
chrome-devtools status # check if install worked.
```

## Troubleshooting

- **Command not found:** If `chrome-devtools` is not recognized, ensure your global npm `bin` directory is in your system's `PATH`. Restart your terminal or source your shell configuration file (e.g., `.bashrc`, `.zshrc`).
- **Permission errors:** If you encounter `EACCES` or permission errors during installation, avoid using `sudo`. Instead, use a node version manager like `nvm`, or configure npm to use a different global directory.
- **Old version running:** Run `chrome-devtools stop && npm uninstall -g chrome-devtools-mcp` before reinstalling, or ensure the latest version is being picked up by your path.
