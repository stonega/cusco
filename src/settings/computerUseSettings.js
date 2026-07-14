import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

function statusSubtitle(status) {
    if (status?.available) {
        const version = status.shellVersion ? `GNOME ${status.shellVersion}` : 'GNOME Shell';
        return `${version} integration is ready.`;
    }

    return status?.reason || 'GNOME Shell integration has not been checked.';
}

export function createComputerUseSettingsGroup(appSettings, computerUse, onChanged = () => {}) {
    const group = new Adw.PreferencesGroup({
        title: 'Computer Use',
        description: 'Linux-only control for GNOME on Wayland. Computer-use tools are available only when Agent is enabled for a chat.',
    });
    const enabledRow = new Adw.SwitchRow({
        title: 'Enable computer use',
        subtitle: 'Expose GNOME window observation and control tools to agents.',
        active: appSettings.computerUseEnabled,
    });
    const captureRow = new Adw.SwitchRow({
        title: 'Allow window capture',
        subtitle: 'Focus and capture the selected window for a vision-capable model.',
        active: appSettings.computerUseCaptureEnabled,
    });
    const inputRow = new Adw.SwitchRow({
        title: 'Allow pointer and keyboard input',
        subtitle: 'Allows clicks, typing, key presses, scrolling, and dragging.',
        active: appSettings.computerUseInputEnabled,
    });
    const workspaceRow = new Adw.SwitchRow({
        title: 'Allow workspace switching',
        subtitle: 'Allows an agent to activate another GNOME workspace.',
        active: appSettings.computerUseWorkspaceSwitchingEnabled,
    });
    const timeoutAdjustment = new Gtk.Adjustment({
        lower: 5,
        upper: 120,
        step_increment: 5,
        page_increment: 15,
        value: appSettings.computerUseActionTimeoutSeconds,
    });
    const timeoutRow = new Adw.SpinRow({
        title: 'Action timeout',
        subtitle: 'Maximum seconds for one computer-use operation.',
        adjustment: timeoutAdjustment,
        digits: 0,
    });
    const statusRow = new Adw.ActionRow({
        title: 'GNOME Shell integration',
        subtitle: 'Checking…',
    });
    const refreshButton = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        tooltip_text: 'Recheck GNOME integration',
        valign: Gtk.Align.CENTER,
    });
    refreshButton.add_css_class('flat');
    statusRow.add_suffix(refreshButton);

    const syncSensitivity = () => {
        const enabled = enabledRow.get_active();
        captureRow.set_sensitive(enabled);
        inputRow.set_sensitive(enabled);
        workspaceRow.set_sensitive(enabled && inputRow.get_active());
        timeoutRow.set_sensitive(enabled);
    };
    const refreshStatus = async () => {
        refreshButton.set_sensitive(false);
        statusRow.set_subtitle('Checking…');
        const status = computerUse
            ? await computerUse.status()
            : { available: false, reason: 'Computer-use service is unavailable.' };
        statusRow.set_subtitle(statusSubtitle(status));
        refreshButton.set_sensitive(true);
    };

    enabledRow.connect('notify::active', () => {
        appSettings.setComputerUseEnabled(enabledRow.get_active());
        syncSensitivity();
        const update = computerUse
            ? computerUse.setEnabled(enabledRow.get_active())
            : Promise.resolve();
        update.catch(error => {
            logError(error, 'Failed to change computer-use state');
        }).finally(refreshStatus);
        onChanged({ computerUseChanged: true });
    });
    captureRow.connect('notify::active', () => {
        appSettings.setComputerUseCaptureEnabled(captureRow.get_active());
        onChanged({ computerUseChanged: true });
    });
    inputRow.connect('notify::active', () => {
        appSettings.setComputerUseInputEnabled(inputRow.get_active());
        syncSensitivity();
        onChanged({ computerUseChanged: true });
    });
    workspaceRow.connect('notify::active', () => {
        appSettings.setComputerUseWorkspaceSwitchingEnabled(workspaceRow.get_active());
        onChanged({ computerUseChanged: true });
    });
    timeoutRow.connect('notify::value', () => {
        appSettings.setComputerUseActionTimeoutSeconds(timeoutRow.get_value());
        onChanged({ computerUseChanged: true });
    });
    refreshButton.connect('clicked', refreshStatus);

    group.add(enabledRow);
    group.add(captureRow);
    group.add(inputRow);
    group.add(workspaceRow);
    group.add(timeoutRow);
    group.add(statusRow);
    syncSensitivity();
    refreshStatus().catch(error => logError(error, 'Failed to check computer-use integration'));
    return group;
}
