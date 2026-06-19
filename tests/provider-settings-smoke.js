import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { ProviderConfigStore } from '../src/providers/config.js';
import { createProviderSettingsPage } from '../src/settings/providerSettings.js';

if (Gtk.init_check()) {
    Adw.init();

    const providerConfigs = new ProviderConfigStore(undefined, { settings: null });
    const page = createProviderSettingsPage(providerConfigs, () => {});

    if (!page)
        throw new Error('Provider settings page was not created');

    print('Cusco provider settings smoke passed');
} else {
    print('Cusco provider settings smoke skipped: no display');
}
