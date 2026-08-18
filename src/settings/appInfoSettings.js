import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    APP_AUTHOR,
    APP_ICONS_URL,
    APP_ID,
    APP_LICENSE,
    APP_NAME,
    APP_REPOSITORY_URL,
    APP_SUMMARY,
    APP_VERSION,
} from '../appInfo.js';
import { createBundledIcon } from '../bundledIcons.js';

const EXTERNAL_LINK_ICON_FILE = 'external-link-symbolic.svg';

function createInfoRow(title, value) {
    return new Adw.ActionRow({
        title,
        subtitle: value,
    });
}

function createLinkRow(title, uri) {
    const row = new Adw.ActionRow({
        title,
        subtitle: uri,
        tooltip_text: `Open ${title}`,
        activatable: true,
    });

    const icon = createBundledIcon(EXTERNAL_LINK_ICON_FILE, 'insert-link-symbolic');
    icon.set_valign(Gtk.Align.CENTER);
    row.add_suffix(icon);
    row.connect('activated', () => {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    });
    return row;
}

function createDebugRow(onOpenStreamReplay) {
    const row = new Adw.ActionRow({
        title: 'Stream replay',
        subtitle: 'Replay custom provider output through the assistant message presentation.',
    });
    const button = new Gtk.Button({
        icon_name: 'go-next-symbolic',
        tooltip_text: 'Open Stream Replay',
        valign: Gtk.Align.CENTER,
    });

    button.add_css_class('flat');
    row.add_suffix(button);
    row.set_activatable_widget(button);
    button.connect('clicked', () => onOpenStreamReplay?.());
    return row;
}

export function createAppInfoSettingsPage(options = {}) {
    const page = new Adw.PreferencesPage({
        title: 'About',
        icon_name: 'help-about-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: APP_NAME,
        description: APP_SUMMARY,
    });

    group.add(createInfoRow('Name', APP_NAME));
    group.add(createInfoRow('Version', APP_VERSION));
    group.add(createInfoRow('Author', APP_AUTHOR));
    group.add(createLinkRow('GitHub', APP_REPOSITORY_URL));
    group.add(createLinkRow('Icons', APP_ICONS_URL));
    group.add(createInfoRow('Application ID', APP_ID));
    group.add(createInfoRow('License', APP_LICENSE));

    page.add(group);

    if (typeof options.onOpenStreamReplay === 'function') {
        const debugGroup = new Adw.PreferencesGroup({
            title: 'Debug',
            description: 'Inspect presentation behavior without sending a provider request.',
        });

        debugGroup.add(createDebugRow(options.onOpenStreamReplay));
        page.add(debugGroup);
    }

    return page;
}
