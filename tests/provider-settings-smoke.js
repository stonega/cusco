import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { ProviderConfigStore } from '../src/providers/config.js';
import { MemoryApiKeyStore } from '../src/secrets/apiKeyStore.js';
import { createProviderSettingsPage } from '../src/settings/providerSettings.js';

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

if (Gtk.init_check()) {
    Adw.init();

    const providerConfigs = new ProviderConfigStore(undefined, {
        settings: null,
        apiKeyStore: new MemoryApiKeyStore(),
        envLookup: () => '',
    });
    const page = createProviderSettingsPage(providerConfigs, () => {});

    if (!page)
        throw new Error('Provider settings page was not created');

    const imageProviderRow = findComboRowByTitle(page, 'Provider');
    const imageModelRow = findComboRowByTitle(page, 'Model');

    if (!imageProviderRow || !imageModelRow)
        throw new Error('Image generation provider rows were not created');

    const imageProviders = providerConfigs.listImageProviders();
    const customImageProviderIndex = imageProviders
        .findIndex((provider) => provider.id === 'openai-compatible');
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
