import Adw from 'gi://Adw?version=1';

import {
    APP_AUTHOR,
    APP_ID,
    APP_LICENSE,
    APP_NAME,
    APP_SUMMARY,
    APP_VERSION,
} from '../appInfo.js';

function createInfoRow(title, value) {
    return new Adw.ActionRow({
        title,
        subtitle: value,
    });
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
    group.add(createInfoRow('Application ID', APP_ID));
    group.add(createInfoRow('License', APP_LICENSE));

    page.add(group);
    return page;
}
