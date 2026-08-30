# Automations

Automations send a saved prompt to AI on a recurring schedule. Each automation
has its own conversation, provider/model selection, and message history. The
scheduled prompt appears as a user message and the AI result appears as the next
assistant message, so scheduled output uses the same transcript UI as chat.

## Create an automation

1. Select **Automations** at the bottom of the left sidebar.
2. Select **New automation** in the sidebar header.
3. Enter a name, a five-field cron schedule, and the prompt Cusco should send.
4. Select **Create**.

The five schedule fields are minute, hour, day of month, month, and weekday.
For example, `0 9 * * 1-5` runs at 09:00 every weekday, while
`30 18 * * *` runs every day at 18:30.

You can also ask Cusco to create an automation in Agent Mode. Cusco requests
permission before installing the schedule.

## Manage and run automations

Open an automation's row menu to run it immediately, edit its schedule or
prompt, pause or resume future runs, or delete it. Pausing does not remove its
message history, and **Run now** can still run a paused automation.

Select an automation to change its provider, model, reasoning, or other
conversation controls. Future runs use those selections and retain earlier
messages as context.

Cusco installs schedules in the current user's crontab. On systemd-based GNOME
desktops, the schedule starts Cusco through the graphical user session so an
automation can run while the main window is closed. Provider credentials remain
in Secret Service; they are not written into the crontab. The automation name,
schedule, and prompt are stored in the user's crontab metadata, so prompts
should refer to Secret Service-backed accounts rather than contain credentials.

Older Cusco-managed command jobs remain visible in Automations for migration
and deletion, but their shell command cannot be edited as an AI prompt.
