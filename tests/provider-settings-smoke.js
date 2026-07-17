import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { ProviderConfigStore } from '../src/providers/config.js';
import { MemoryApiKeyStore } from '../src/secrets/apiKeyStore.js';
import { createProviderSettingsPage } from '../src/settings/providerSettings.js';
import { ModelPicker } from '../src/window.js';

function walkWidgets(widget, callback) {
    callback(widget);

    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        walkWidgets(child, callback);
}

function findComboRowByTitle(root, title) {
    let found = null;

    walkWidgets(root, (widget) => {
        if (!found && widget instanceof Adw.ComboRow && widget.get_title() === title)
            found = widget;
    });

    return found;
}

function findPasswordEntryRowByTitle(root, title) {
    let found = null;

    walkWidgets(root, (widget) => {
        if (!found && widget instanceof Adw.PasswordEntryRow && widget.get_title() === title)
            found = widget;
    });

    return found;
}

function findPreferencesGroupByTitle(root, title) {
    let found = null;

    walkWidgets(root, (widget) => {
        if (!found && widget instanceof Adw.PreferencesGroup && widget.get_title() === title)
            found = widget;
    });

    return found;
}

function findActionRowByTitle(root, title) {
    let found = null;

    walkWidgets(root, (widget) => {
        if (!found && widget instanceof Adw.ActionRow && widget.get_title() === title)
            found = widget;
    });

    return found;
}

function findExpanderRowByTitle(root, title) {
    let found = null;

    walkWidgets(root, (widget) => {
        if (!found && widget instanceof Adw.ExpanderRow && widget.get_title() === title)
            found = widget;
    });

    return found;
}

function findToggleButtonByLabel(root, label) {
    let found = null;

    walkWidgets(root, (widget) => {
        if (!found && widget instanceof Gtk.ToggleButton && widget.get_label() === label)
            found = widget;
    });

    return found;
}

if (Gtk.init_check()) {
    Adw.init();

    const composerModelPicker = new ModelPicker();
    const shortModelName = 'OpenAI: GPT-5.6 Luna Pro';
    const longModelName = 'KwaiPilot: KAT-Coder-Pro V1 Fast Thinking Preview';
    composerModelPicker.append('short', shortModelName);
    composerModelPicker.append('long', longModelName);
    composerModelPicker.set_active_id('short');
    const shortModelWidth = composerModelPicker.measure(Gtk.Orientation.HORIZONTAL, -1)[1];
    composerModelPicker.set_active_id('long');
    const longModelWidth = composerModelPicker.measure(Gtk.Orientation.HORIZONTAL, -1)[1];

    if (longModelWidth <= shortModelWidth)
        throw new Error('Composer model selector did not resize to follow the active model name');

    composerModelPicker.set_active_id('short');

    if (composerModelPicker.measure(Gtk.Orientation.HORIZONTAL, -1)[1] !== shortModelWidth)
        throw new Error('Composer model selector remained sized to the longest model option');

    let sawFullLongModelLabel = false;
    walkWidgets(composerModelPicker.get_popover(), (widget) => {
        if (widget instanceof Gtk.Label && widget.get_text() === longModelName) {
            sawFullLongModelLabel = widget.get_ellipsize() === Pango.EllipsizeMode.NONE;
        }
    });

    if (!sawFullLongModelLabel)
        throw new Error('Composer model dropdown did not retain the complete model name');

    const providerConfigs = new ProviderConfigStore(undefined, {
        settings: null,
        apiKeyStore: new MemoryApiKeyStore(),
        envLookup: () => '',
    });
    const firstCustomProvider = providerConfigs.addCustomProvider({
        name: 'Local Models',
        baseUrl: 'http://127.0.0.1:1234/v1',
        models: ['local-small'],
        apiKey: 'local-key',
    });
    providerConfigs.addCustomProvider({
        name: 'Hosted Models',
        baseUrl: 'https://models.example/v1',
        models: ['hosted-large'],
        apiKey: 'hosted-key',
    });
    const page = createProviderSettingsPage(providerConfigs, () => {});

    if (!page)
        throw new Error('Provider settings page was not created');

    if (!findPasswordEntryRowByTitle(page, 'API key (GEMINI_API_KEY)'))
        throw new Error('Gemini API key row did not show its environment variable');

    if (!findPasswordEntryRowByTitle(page, 'API key (XAI_API_KEY)'))
        throw new Error('Grok API key row did not show its environment variable');

    const builtInGroup = findPreferencesGroupByTitle(page, 'Built-in Providers');
    const customGroup = findPreferencesGroupByTitle(page, 'Custom APIs');

    if (!builtInGroup || !customGroup)
        throw new Error('Built-in and custom providers were not shown as separate lists');

    if (!findActionRowByTitle(customGroup, 'Add Custom API'))
        throw new Error('Custom provider list did not include an add action');

    if (!findExpanderRowByTitle(customGroup, 'Local Models')
        || !findExpanderRowByTitle(customGroup, 'Hosted Models')) {
        throw new Error('Multiple custom providers were not shown in the custom provider list');
    }

    if (!findComboRowByTitle(page, 'Default model')?.get_list_factory())
        throw new Error('Settings model selector did not install the full-name list factory');

    const kimiRow = findExpanderRowByTitle(builtInGroup, 'Kimi');
    const kimiEndpointRow = findActionRowByTitle(kimiRow, 'Endpoint');
    const kimiCnButton = findToggleButtonByLabel(kimiEndpointRow, 'CN');

    if (!kimiEndpointRow || !kimiCnButton)
        throw new Error('Kimi endpoint row did not include the CN button');

    if (kimiCnButton.get_active())
        throw new Error('Kimi CN endpoint button should initially be inactive');

    kimiCnButton.set_active(true);

    if (providerConfigs.getProvider('kimi').baseUrl !== 'https://api.moonshot.cn/v1'
        || kimiEndpointRow.get_subtitle() !== 'https://api.moonshot.cn/v1') {
        throw new Error('Kimi CN endpoint button did not activate the China endpoint');
    }

    kimiCnButton.set_active(false);

    if (providerConfigs.getProvider('kimi').baseUrl !== 'https://api.moonshot.ai/v1'
        || kimiEndpointRow.get_subtitle() !== 'https://api.moonshot.ai/v1') {
        throw new Error('Kimi CN endpoint button did not restore the global endpoint');
    }

    const imageProviderRow = findComboRowByTitle(page, 'Provider');
    const imageModelRow = findComboRowByTitle(page, 'Model');

    if (!imageProviderRow || !imageModelRow)
        throw new Error('Image generation provider rows were not created');

    const imageProviders = providerConfigs.listImageProviders();
    const customImageProviderIndex = imageProviders
        .findIndex((provider) => provider.id === firstCustomProvider.id);
    const geminiImageProviderIndex = imageProviders
        .findIndex((provider) => provider.id === 'gemini');

    if (customImageProviderIndex < 0)
        throw new Error('Custom image provider was not available in settings');

    if (geminiImageProviderIndex < 0)
        throw new Error('Gemini image provider was not available in settings');

    imageProviderRow.set_selected(customImageProviderIndex);

    if (imageModelRow.get_selected() !== Gtk.INVALID_LIST_POSITION)
        throw new Error('Empty image model row should have no selected item');

    const geminiImageModels = providerConfigs.getProvider('gemini').imageModels;
    const geminiImageModelIndex = geminiImageModels.length - 1;
    const geminiImageModel = geminiImageModels[geminiImageModelIndex];

    imageProviderRow.set_selected(geminiImageProviderIndex);
    imageModelRow.set_selected(geminiImageModelIndex);

    const imageSelection = providerConfigs.getImageGenerationSelection();

    if (imageSelection.provider.id !== 'gemini' || imageSelection.model.id !== geminiImageModel.id)
        throw new Error('Image generation model selection was not updated');

    print('Cusco provider settings smoke passed');
} else {
    print('Cusco provider settings smoke skipped: no display');
}
