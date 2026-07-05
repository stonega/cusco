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

    row.add_suffix(new Gtk.Image({
        icon_name: 'insert-link-symbolic',
        valign: Gtk.Align.CENTER,
    }));
    row.connect('activated', () => {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    });
    return row;
}

export function createAppInfoSettingsPage() {
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
    return page;
}
