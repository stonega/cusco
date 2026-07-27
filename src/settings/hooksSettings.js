import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

function createActionButton(iconName, tooltipText, onClicked) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });
    button.add_css_class('flat');
    button.connect('clicked', onClicked);
    return button;
}

export function createHooksConfigGroup(hookManager) {
    const configGroup = new Adw.PreferencesGroup({
        title: 'Hooks Config File',
        description: 'Cusco loads user lifecycle hooks from this file.',
    });
    const configRow = new Adw.ActionRow({
        title: 'hooks.json',
    });

    const refresh = () => {
        const source = hookManager.listHooks().sources
            .find((candidate) => candidate.scope === 'user');
        const subtitle = source?.errors.length > 0
            ? source.errors.join(' ')
            : source?.path ?? 'User hooks config file is unavailable.';

        configRow.set_subtitle(subtitle);
    };

    configRow.add_suffix(createActionButton(
        'view-refresh-symbolic',
        'Reload Hooks config file',
        refresh,
    ));
    configGroup.add(configRow);
    refresh();
    return configGroup;
}
