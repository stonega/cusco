import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { createProviderIcon } from '../providers/icons.js';
import { createAppInfoSettingsPage } from './appInfoSettings.js';
import { createApplicationSettingsPage } from './appSettings.js';
import { createMemorySettingsPage } from './memorySettings.js';
import { createSkillsSettingsPage, createWorkspaceSettingsPage } from './workspaceSettings.js';

function createStringList(values) {
    const list = new Gtk.StringList();

    for (const value of values)
        list.append(value);

    return list;
}

function createFullModelNameFactory() {
    const factory = new Gtk.SignalListItemFactory();

    factory.connect('setup', (_factory, listItem) => {
        listItem.set_child(new Gtk.Label({
            ellipsize: Pango.EllipsizeMode.NONE,
            single_line_mode: true,
            xalign: 0,
        }));
    });
    factory.connect('bind', (_factory, listItem) => {
        const label = listItem.get_child();
        const modelName = listItem.get_item()?.get_string() ?? '';
        label.set_label(modelName);
        label.set_tooltip_text(modelName);
    });
    return factory;
}

function stringListMatches(list, values) {
    if (list.get_n_items() === values.length) {
        for (let index = 0; index < values.length; index++) {
            if (list.get_string(index) !== values[index])
                return false;
        }

        return true;
    }

    return false;
}

function syncComboRowStringList(row, list, values) {
    if (stringListMatches(list, values))
        return;

    row.set_selected(Gtk.INVALID_LIST_POSITION);
    list.splice(0, list.get_n_items(), values);
}

function selectedIndexOrNone(index, itemCount) {
    if (itemCount === 0)
        return Gtk.INVALID_LIST_POSITION;

    return Math.max(index, 0);
}

function getDefaultModelIndex(provider) {
    const index = provider.models.findIndex((model) => model.id === provider.defaultModelId);
    return selectedIndexOrNone(index, provider.models.length);
}

function getDefaultImageModelIndex(provider) {
    const imageModels = provider.imageModels ?? [];
    const index = imageModels.findIndex((model) => model.id === provider.defaultImageModelId);
    return selectedIndexOrNone(index, imageModels.length);
}

function getImageModelIndex(provider, modelId) {
    const imageModels = provider?.imageModels ?? [];
    const index = imageModels.findIndex((model) => model.id === modelId);
    return selectedIndexOrNone(index, imageModels.length);
}

function getImageProviderIndex(providers, providerId) {
    const index = providers.findIndex((provider) => provider.id === providerId);
    return selectedIndexOrNone(index, providers.length);
}

function canDisableProvider(providerConfigs, provider) {
    return !provider.enabled || provider.implemented;
}

function getEnabledRowSubtitle(provider, canEnableProvider) {
    if (!provider.implemented)
        return 'This provider is not implemented yet.';

    if (provider.customizable && (!provider.baseUrl || provider.models.length === 0))
        return 'Configure an endpoint and at least one model before enabling this provider.';

    if (!provider.enabled && !canEnableProvider)
        return 'Configure credentials before enabling this provider.';

    return 'Show this provider in chat provider pickers.';
}

function getApiKeySubtitle(providerConfigs, provider) {
    if (!provider.apiKeyRequired)
        return 'No API key required for this provider.';

    const status = providerConfigs.getApiKeyStatus(provider.id);

    if (status.source === 'secret')
        return 'Stored in Secret Service.';

    if (status.source === 'environment')
        return `${provider.apiKeyEnvVar} is available in the environment.`;

    if (status.error)
        return 'Secret Service is unavailable; environment variables can still be used.';

    return `Store a key in Secret Service or set ${provider.apiKeyEnvVar}.`;
}

function getWebSearchApiKeySubtitle(providerConfigs) {
    const status = providerConfigs.getWebSearchApiKeyStatus();

    if (status.source === 'secret')
        return 'Stored in Secret Service.';

    if (status.source === 'environment')
        return 'BRAVE_SEARCH_API_KEY is available in the environment.';

    if (status.error)
        return 'Secret Service is unavailable; BRAVE_SEARCH_API_KEY can still be used.';

    return 'Used when the selected model does not provide native web search.';
}

function canDiscoverModels(provider) {
    return Boolean(provider?.apiFormat)
        && provider.supportsModelDiscovery !== false
        && (!provider.apiKeyRequired || provider.apiKeyConfigured)
        && (!provider.customizable || Boolean(provider.baseUrl));
}

function canDiscoverImageModels(provider) {
    return Boolean(provider?.imageApiFormat)
        && provider.supportsImageModelDiscovery !== false
        && (!provider.customizable || Boolean(provider.baseUrl))
        && (
            provider.imageModelDiscoveryRequiresApiKey === false
            || !provider.apiKeyRequired
            || provider.apiKeyConfigured
        );
}

function createProviderEnabledSwitch() {
    return new Gtk.Switch({
        tooltip_text: 'Show this provider in chat provider pickers.',
        valign: Gtk.Align.CENTER,
    });
}

function createProviderRow(providerConfigs, providerId, onChanged, syncAllRows, options = {}) {
    const provider = providerConfigs.getProvider(providerId);
    const row = new Adw.ExpanderRow({
        title: provider.name,
        subtitle: provider.description,
    });
    row.add_prefix(createProviderIcon(provider, { pixelSize: 32 }));

    const enabledSwitch = createProviderEnabledSwitch();
    enabledSwitch.connect('notify::active', () => {
        if (enabledSwitch._syncing)
            return;

        try {
            providerConfigs.setProviderEnabled(providerId, enabledSwitch.get_active());
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to update provider enabled state');
        }
    });
    row.add_suffix(enabledSwitch);

    const applyCustomProviderConfig = () => {
        try {
            providerConfigs.setCustomProviderConfig(providerId, {
                name: row._nameRow?.get_text(),
                baseUrl: row._endpointRow?.get_text() ?? '',
                models: row._modelsEntryRow?.get_text() ?? '',
            });
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to update custom provider settings');
        }
    };

    if (provider.customizable) {
        const nameRow = new Adw.EntryRow({
            title: 'Name',
            text: provider.name,
        });
        nameRow.set_show_apply_button(true);
        nameRow.connect('apply', applyCustomProviderConfig);
        row.add_row(nameRow);
        row._nameRow = nameRow;

        const endpointRow = new Adw.EntryRow({
            title: 'Base URL',
            text: provider.baseUrl,
        });
        endpointRow.set_show_apply_button(true);
        endpointRow.connect('apply', applyCustomProviderConfig);
        row.add_row(endpointRow);
        row._endpointRow = endpointRow;

        const modelsEntryRow = new Adw.EntryRow({
            title: 'Model IDs',
            text: provider.models.map((model) => model.id).join(', '),
        });
        modelsEntryRow.set_show_apply_button(true);
        modelsEntryRow.connect('apply', applyCustomProviderConfig);
        row.add_row(modelsEntryRow);
        row._modelsEntryRow = modelsEntryRow;
    }

    if (provider.models.length > 0 || provider.customizable) {
        const modelNames = createStringList(provider.models.map((model) => model.name));
        const modelRow = new Adw.ComboRow({
            title: 'Default model',
            subtitle: 'Used when this provider is selected by default.',
            model: modelNames,
            sensitive: provider.models.length > 0,
        });
        modelRow.set_list_factory(createFullModelNameFactory());
        modelRow.connect('notify::selected', () => {
            if (modelRow._syncing)
                return;

            const currentProvider = providerConfigs.getProvider(providerId);
            const selectedModel = currentProvider.models[modelRow.get_selected()];

            if (!selectedModel)
                return;

            providerConfigs.setDefaultModel(providerId, selectedModel.id);
            syncAllRows();
            onChanged();
        });
        row.add_row(modelRow);
        row._modelRow = modelRow;
        row._modelNames = modelNames;
    } else if (!provider.customizable) {
        row.add_row(new Adw.ActionRow({
            title: 'Models',
            subtitle: 'Model discovery will be available when this provider is implemented.',
        }));
    }

    if (provider.baseUrl && !provider.customizable) {
        row.add_row(new Adw.ActionRow({
            title: 'Endpoint',
            subtitle: provider.baseUrl,
        }));
    }

    if (provider.apiFormat) {
        const discoveryRow = new Adw.ActionRow({
            title: 'Model discovery',
            subtitle: 'Refresh the model list from this provider.',
        });
        const discoverButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh models',
            valign: Gtk.Align.CENTER,
        });
        discoverButton.add_css_class('flat');
        discoverButton.connect('clicked', async () => {
            discoverButton.set_sensitive(false);
            row._discoveryStatus = 'Fetching models…';
            discoveryRow.set_subtitle(row._discoveryStatus);

            try {
                await providerConfigs.discoverModels(providerId);
                const modelCount = providerConfigs.getProvider(providerId)?.models.length ?? 0;
                row._discoveryStatus = `Found ${modelCount} model${modelCount === 1 ? '' : 's'}.`;
                syncAllRows();
                onChanged();
            } catch (error) {
                row._discoveryStatus = error.userMessage ?? error.message ?? 'Could not fetch models.';
                syncAllRows();
                logError(error, 'Failed to discover provider models');
            } finally {
                discoveryRow.set_subtitle(row._discoveryStatus || 'Refresh the model list from this provider.');
                discoverButton.set_sensitive(canDiscoverModels(providerConfigs.getProvider(providerId)));
            }
        });
        discoveryRow.add_suffix(discoverButton);
        row.add_row(discoveryRow);
        row._discoveryRow = discoveryRow;
        row._discoverButton = discoverButton;
    }

    if (provider.apiKeyRequired) {
        const apiKeyRow = new Adw.PasswordEntryRow({
            title: `API key (${provider.apiKeyEnvVar})`,
        });
        apiKeyRow.set_show_apply_button(true);
        apiKeyRow.connect('apply', () => {
            const apiKey = apiKeyRow.get_text().trim();

            if (!apiKey)
                return;

            try {
                providerConfigs.setApiKey(providerId, apiKey);
                apiKeyRow.set_text('');
                syncAllRows();
                onChanged();
            } catch (error) {
                syncAllRows();
                logError(error, 'Failed to store provider API key');
            }
        });

        const clearKeyButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Clear stored key',
            valign: Gtk.Align.CENTER,
        });
        clearKeyButton.add_css_class('flat');
        clearKeyButton.connect('clicked', () => {
            try {
                providerConfigs.clearApiKey(providerId);
                apiKeyRow.set_text('');
                syncAllRows();
                onChanged();
            } catch (error) {
                syncAllRows();
                logError(error, 'Failed to clear provider API key');
            }
        });
        apiKeyRow.add_suffix(clearKeyButton);
        row.add_row(apiKeyRow);
        row._apiKeyStatusRow = new Adw.ActionRow({
            title: 'Credentials',
            subtitle: getApiKeySubtitle(providerConfigs, provider),
        });
        row.add_row(row._apiKeyStatusRow);
        row._apiKeyRow = apiKeyRow;
        row._clearKeyButton = clearKeyButton;
    } else {
        row._apiKeyStatusRow = new Adw.ActionRow({
            title: 'Credentials',
            subtitle: getApiKeySubtitle(providerConfigs, provider),
        });
        row.add_row(row._apiKeyStatusRow);
    }

    if (provider.customizable && options.onRemove) {
        const removeRow = new Adw.ActionRow({
            title: 'Remove custom API',
            subtitle: 'Delete this endpoint and its stored API key.',
        });
        const removeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: 'Remove custom API',
            valign: Gtk.Align.CENTER,
        });
        removeButton.add_css_class('flat');
        removeButton.add_css_class('destructive-action');
        removeButton.connect('clicked', () => options.onRemove(providerId));
        removeRow.add_suffix(removeButton);
        row.add_row(removeRow);
        row._removeButton = removeButton;
    }

    const sync = () => {
        const currentProvider = providerConfigs.getProvider(providerId);

        if (!currentProvider)
            return;

        const canEnableProvider = providerConfigs.canEnableProvider(providerId);

        row.set_title(currentProvider.name);

        enabledSwitch._syncing = true;
        enabledSwitch.set_active(currentProvider.enabled);
        enabledSwitch.set_sensitive(currentProvider.implemented
            && (currentProvider.enabled
                ? canDisableProvider(providerConfigs, currentProvider)
                : canEnableProvider));
        enabledSwitch.set_tooltip_text(getEnabledRowSubtitle(currentProvider, canEnableProvider));
        enabledSwitch._syncing = false;

        if (row._nameRow)
            row._nameRow.set_text(currentProvider.name);

        if (row._endpointRow)
            row._endpointRow.set_text(currentProvider.baseUrl ?? '');

        if (row._modelsEntryRow)
            row._modelsEntryRow.set_text(currentProvider.models.map((model) => model.id).join(', '));

        if (row._modelRow) {
            row._modelRow._syncing = true;
            syncComboRowStringList(
                row._modelRow,
                row._modelNames,
                currentProvider.models.map((model) => model.name),
            );
            row._modelRow.set_sensitive(currentProvider.models.length > 0);
            row._modelRow.set_selected(getDefaultModelIndex(currentProvider));
            row._modelRow._syncing = false;
        }

        row._apiKeyStatusRow?.set_subtitle(getApiKeySubtitle(providerConfigs, currentProvider));
        row._clearKeyButton?.set_sensitive(providerConfigs.getApiKeyStatus(providerId).source === 'secret');
        row._discoveryRow?.set_subtitle(row._discoveryStatus || 'Refresh the model list from this provider.');
        row._discoverButton?.set_sensitive(canDiscoverModels(currentProvider));
    };

    sync();

    return { row, sync };
}

function createImageGenerationSettingsGroup(providerConfigs, onChanged, syncAllRows) {
    const group = new Adw.PreferencesGroup({
        title: 'Image Generation',
        description: 'Choose the provider and model used by the image generation tool. This is independent from the active chat provider.',
    });
    const providerNames = createStringList([]);
    const modelNames = createStringList([]);
    const providerRow = new Adw.ComboRow({
        title: 'Provider',
        subtitle: 'Used by image_gen in every chat.',
        model: providerNames,
    });
    const modelRow = new Adw.ComboRow({
        title: 'Model',
        subtitle: 'Default image generation model.',
        model: modelNames,
    });
    modelRow.set_list_factory(createFullModelNameFactory());
    const customImageModelsEntryRow = new Adw.EntryRow({
        title: 'Custom image model IDs',
    });
    const discoveryRow = new Adw.ActionRow({
        title: 'Image model discovery',
        subtitle: 'Refresh image generation models for the selected image provider.',
    });
    const discoverButton = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        tooltip_text: 'Refresh image models',
        valign: Gtk.Align.CENTER,
    });

    customImageModelsEntryRow.set_show_apply_button(true);
    discoverButton.add_css_class('flat');
    discoveryRow.add_suffix(discoverButton);

    const selectedProviderFromRow = () => {
        const providers = providerRow._providers ?? [];
        return providers[providerRow.get_selected()] ?? null;
    };

    providerRow.connect('notify::selected', () => {
        if (providerRow._syncing)
            return;

        const provider = selectedProviderFromRow();

        if (!provider)
            return;

        try {
            providerConfigs.setDefaultImageProvider(provider.id);
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to update default image provider');
        }
    });

    modelRow.connect('notify::selected', () => {
        if (modelRow._syncing)
            return;

        const provider = selectedProviderFromRow();
        const selectedModel = provider?.imageModels?.[modelRow.get_selected()];

        if (!provider || !selectedModel)
            return;

        try {
            providerConfigs.setDefaultImageSelection(provider.id, selectedModel.id);
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to update default image generation model');
        }
    });

    customImageModelsEntryRow.connect('apply', () => {
        const provider = selectedProviderFromRow();

        if (!provider)
            return;

        try {
            providerConfigs.setCustomImageModels(provider.id, customImageModelsEntryRow.get_text());
            providerConfigs.setDefaultImageProvider(provider.id);
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to update custom image generation models');
        }
    });

    discoverButton.connect('clicked', async () => {
        const provider = selectedProviderFromRow();

        if (!provider)
            return;

        discoverButton.set_sensitive(false);

        try {
            await providerConfigs.discoverImageModels(provider.id);
            providerConfigs.setDefaultImageProvider(provider.id);
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to discover provider image models');
        } finally {
            discoverButton.set_sensitive(canDiscoverImageModels(providerConfigs.getProvider(provider.id)));
        }
    });

    const sync = () => {
        const providers = providerConfigs.listImageProviders();
        const selection = providerConfigs.getImageGenerationSelection();
        const selectedProvider = selection.provider ?? providers[0] ?? null;
        const selectedProviderId = selectedProvider?.id ?? '';
        const providerIndex = getImageProviderIndex(providers, selectedProviderId);
        const currentProvider = selectedProviderId
            ? providerConfigs.getProvider(selectedProviderId)
            : null;
        const imageModels = currentProvider?.imageModels ?? [];
        const selectedModelId = selection.provider?.id === currentProvider?.id
            ? selection.model?.id
            : currentProvider?.defaultImageModelId;

        providerRow._syncing = true;
        providerRow._providers = providers;
        syncComboRowStringList(
            providerRow,
            providerNames,
            providers.map((provider) => provider.name),
        );
        providerRow.set_sensitive(providers.length > 0);
        providerRow.set_selected(providerIndex);
        providerRow._syncing = false;

        modelRow._syncing = true;
        syncComboRowStringList(modelRow, modelNames, imageModels.map((model) => model.name));
        modelRow.set_sensitive(imageModels.length > 0);
        modelRow.set_selected(getImageModelIndex(currentProvider, selectedModelId));
        modelRow._syncing = false;

        customImageModelsEntryRow.set_sensitive(Boolean(currentProvider));
        customImageModelsEntryRow.set_text((currentProvider?.customImageModels ?? []).map((model) => model.id).join(', '));
        discoverButton.set_sensitive(canDiscoverImageModels(currentProvider));
    };

    group.add(providerRow);
    group.add(modelRow);
    group.add(customImageModelsEntryRow);
    group.add(discoveryRow);
    sync();

    return { group, sync };
}

function createWebSearchSettingsGroup(providerConfigs, onChanged, syncAllRows) {
    const group = new Adw.PreferencesGroup({
        title: 'Web Search',
        description: 'Supported models use their provider-native search. Brave Search is the fallback for other models and explicit /search commands.',
    });
    const apiKeyRow = new Adw.PasswordEntryRow({
        title: 'Brave Search API key',
    });
    const clearKeyButton = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        tooltip_text: 'Clear stored Brave Search key',
        valign: Gtk.Align.CENTER,
    });
    const statusRow = new Adw.ActionRow({
        title: 'Fallback credentials',
    });

    apiKeyRow.set_show_apply_button(true);
    clearKeyButton.add_css_class('flat');
    apiKeyRow.add_suffix(clearKeyButton);

    apiKeyRow.connect('apply', () => {
        const apiKey = apiKeyRow.get_text().trim();

        if (!apiKey)
            return;

        try {
            providerConfigs.setWebSearchApiKey(apiKey);
            apiKeyRow.set_text('');
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to store Brave Search API key');
        }
    });

    clearKeyButton.connect('clicked', () => {
        try {
            providerConfigs.clearWebSearchApiKey();
            apiKeyRow.set_text('');
            syncAllRows();
            onChanged();
        } catch (error) {
            syncAllRows();
            logError(error, 'Failed to clear Brave Search API key');
        }
    });

    const sync = () => {
        const status = providerConfigs.getWebSearchApiKeyStatus();

        statusRow.set_subtitle(getWebSearchApiKeySubtitle(providerConfigs));
        clearKeyButton.set_sensitive(status.source === 'secret');
    };

    group.add(apiKeyRow);
    group.add(statusRow);
    sync();
    return { group, sync };
}

function showProviderMessage(parent, heading, body) {
    const dialog = new Adw.AlertDialog({
        heading,
        body: String(body ?? ''),
    });
    dialog.add_response('close', 'Close');
    dialog.set_default_response('close');
    dialog.set_close_response('close');
    dialog.choose(parent, null, (_dialog, result) => dialog.choose_finish(result));
}

function createDialogField(labelText, entry) {
    const field = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
    });
    const label = new Gtk.Label({
        label: labelText,
        xalign: 0,
    });
    label.add_css_class('dim-label');
    field.append(label);
    field.append(entry);
    return field;
}

function presentAddCustomProviderDialog(parent, providerConfigs, onChanged, syncAllRows) {
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 6,
        margin_end: 6,
    });
    const nameEntry = new Gtk.Entry({
        placeholder_text: 'My API',
        activates_default: true,
        hexpand: true,
    });
    const endpointEntry = new Gtk.Entry({
        placeholder_text: 'https://api.example.com/v1',
        activates_default: true,
        hexpand: true,
    });
    const apiKeyEntry = new Gtk.Entry({
        placeholder_text: 'API key',
        activates_default: true,
        hexpand: true,
        visibility: false,
        input_purpose: Gtk.InputPurpose.PASSWORD,
    });
    const dialog = new Adw.AlertDialog({
        heading: 'Add Custom API',
        body: 'Cusco will securely store the key and fetch available models from the OpenAI-compatible /models endpoint.',
    });

    content.append(createDialogField('Name', nameEntry));
    content.append(createDialogField('Base URL', endpointEntry));
    content.append(createDialogField('API key', apiKeyEntry));
    dialog.set_extra_child(content);
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('add', 'Add');
    dialog.set_default_response('add');
    dialog.set_close_response('cancel');
    dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

    const syncAddEnabled = () => {
        dialog.set_response_enabled('add', Boolean(
            nameEntry.get_text().trim()
            && endpointEntry.get_text().trim()
            && apiKeyEntry.get_text().trim()
        ));
    };

    nameEntry.connect('changed', syncAddEnabled);
    endpointEntry.connect('changed', syncAddEnabled);
    apiKeyEntry.connect('changed', syncAddEnabled);
    syncAddEnabled();

    dialog.choose(parent, null, async (_dialog, result) => {
        if (dialog.choose_finish(result) !== 'add')
            return;

        let provider = null;

        try {
            provider = providerConfigs.addCustomProvider({
                name: nameEntry.get_text(),
                baseUrl: endpointEntry.get_text(),
                apiKey: apiKeyEntry.get_text(),
            });
            syncAllRows();
            await providerConfigs.discoverModels(provider.id);
        } catch (error) {
            const heading = provider
                ? 'Custom API Added Without Models'
                : 'Could Not Add Custom API';
            const detail = provider
                ? `${error.userMessage ?? error.message}\n\nYou can edit the endpoint or enter model IDs manually, then refresh models.`
                : error.userMessage ?? error.message;
            showProviderMessage(parent, heading, detail);
            logError(error, 'Failed to add custom provider');
        } finally {
            syncAllRows();

            if (provider)
                onChanged();
        }
    });
}

function presentRemoveCustomProviderDialog(parent, providerConfigs, providerId, onChanged, syncAllRows) {
    const provider = providerConfigs.getProvider(providerId);

    if (!provider)
        return;

    const dialog = new Adw.AlertDialog({
        heading: `Remove ${provider.name}?`,
        body: 'This removes the endpoint, its model list, and its stored API key.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('remove', 'Remove');
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.choose(parent, null, (_dialog, result) => {
        if (dialog.choose_finish(result) !== 'remove')
            return;

        try {
            providerConfigs.removeCustomProvider(providerId);
            syncAllRows();
            onChanged();
        } catch (error) {
            showProviderMessage(parent, 'Could Not Remove Custom API', error.userMessage ?? error.message);
            logError(error, 'Failed to remove custom provider');
        }
    });
}

export function createProviderSettingsPage(providerConfigs, onChanged) {
    providerConfigs.refreshApiKeyStatus();

    const page = new Adw.PreferencesPage({
        title: 'Providers',
        icon_name: 'network-server-symbolic',
    });

    const builtInGroup = new Adw.PreferencesGroup({
        title: 'Built-in Providers',
        description: 'Choose which built-in providers are available and configure default models.',
    });
    const customGroup = new Adw.PreferencesGroup({
        title: 'Custom APIs',
        description: 'Connect multiple OpenAI-compatible services. Each endpoint keeps its own models and credentials.',
    });
    const addCustomProviderRow = new Adw.ActionRow({
        title: 'Add Custom API',
        subtitle: 'Add an endpoint and fetch its available models automatically.',
    });
    const addCustomProviderButton = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: 'Add custom API',
        valign: Gtk.Align.CENTER,
    });
    addCustomProviderButton.add_css_class('flat');
    addCustomProviderRow.add_suffix(addCustomProviderButton);
    customGroup.add(addCustomProviderRow);

    const providerRows = [];
    const customProviderRows = new Map();
    let imageGenerationSettings = null;
    let webSearchSettings = null;
    let syncCustomProviderRows = () => {};
    const syncAllRows = () => {
        providerConfigs.refreshApiKeyStatus();
        syncCustomProviderRows();
        imageGenerationSettings?.sync();
        webSearchSettings?.sync();

        for (const providerRow of providerRows)
            providerRow.sync();
    };

    const settingsParent = () => page.get_root() ?? page;

    syncCustomProviderRows = () => {
        const customProviders = providerConfigs.listProviders()
            .filter((provider) => provider.customizable);
        const currentProviderIds = new Set(customProviders.map((provider) => provider.id));

        for (const [providerId, providerRow] of customProviderRows) {
            if (currentProviderIds.has(providerId))
                continue;

            customGroup.remove(providerRow.row);
            customProviderRows.delete(providerId);
        }

        for (const provider of customProviders) {
            let providerRow = customProviderRows.get(provider.id);

            if (!providerRow) {
                providerRow = createProviderRow(
                    providerConfigs,
                    provider.id,
                    onChanged,
                    syncAllRows,
                    {
                        onRemove: (providerId) => presentRemoveCustomProviderDialog(
                            settingsParent(),
                            providerConfigs,
                            providerId,
                            onChanged,
                            syncAllRows,
                        ),
                    },
                );
                customProviderRows.set(provider.id, providerRow);
                customGroup.remove(addCustomProviderRow);
                customGroup.add(providerRow.row);
                customGroup.add(addCustomProviderRow);
            }

            providerRow.sync();
        }
    };

    addCustomProviderButton.connect('clicked', () => presentAddCustomProviderDialog(
        settingsParent(),
        providerConfigs,
        onChanged,
        syncAllRows,
    ));

    imageGenerationSettings = createImageGenerationSettingsGroup(providerConfigs, onChanged, syncAllRows);
    webSearchSettings = createWebSearchSettingsGroup(providerConfigs, onChanged, syncAllRows);

    for (const provider of providerConfigs.listProviders().filter((item) => !item.customizable)) {
        const providerRow = createProviderRow(providerConfigs, provider.id, onChanged, syncAllRows);
        providerRows.push(providerRow);
        builtInGroup.add(providerRow.row);
    }

    syncCustomProviderRows();
    page.add(builtInGroup);
    page.add(customGroup);
    page.add(webSearchSettings.group);
    page.add(imageGenerationSettings.group);
    return page;
}

export function presentProviderSettingsDialog(
    parent,
    providerConfigs,
    appSettingsOrOnChanged,
    memoryManagerOrOnChanged = null,
    workspaceManagerOrOnChanged = null,
    mcpManagerOrOnChanged = null,
    maybeOnChanged = null,
    options = {},
) {
    const appSettings = typeof appSettingsOrOnChanged === 'function'
        ? null
        : appSettingsOrOnChanged;
    const memoryManager = typeof memoryManagerOrOnChanged === 'function'
        ? null
        : memoryManagerOrOnChanged;
    const workspaceManager = typeof workspaceManagerOrOnChanged === 'function'
        ? null
        : workspaceManagerOrOnChanged;
    const mcpManager = typeof mcpManagerOrOnChanged === 'function'
        ? null
        : mcpManagerOrOnChanged;
    const onChanged = [
        appSettingsOrOnChanged,
        memoryManagerOrOnChanged,
        workspaceManagerOrOnChanged,
        mcpManagerOrOnChanged,
        maybeOnChanged,
    ].find((value) => typeof value === 'function') ?? (() => {});
    const dialog = new Adw.PreferencesWindow({
        title: 'Settings',
        search_enabled: false,
    });
    dialog.set_transient_for(parent);

    if (appSettings) {
        dialog.add(createApplicationSettingsPage(appSettings, onChanged, {
            archivedChatCount: options.archivedChatCount ?? 0,
            onOpenArchivedChats: options.onOpenArchivedChats,
        }));
    }

    if (memoryManager)
        dialog.add(createMemorySettingsPage(dialog, memoryManager, onChanged));

    if (workspaceManager) {
        dialog.add(createWorkspaceSettingsPage(
            dialog,
            workspaceManager,
            mcpManager,
            onChanged,
            {
                appSettings,
                computerUse: options.computerUse ?? null,
            },
        ));
        dialog.add(createSkillsSettingsPage(dialog, workspaceManager, onChanged));
    }

    const page = createProviderSettingsPage(providerConfigs, onChanged);
    dialog.add(page);
    dialog.add(createAppInfoSettingsPage());

    if (options.initialPage === 'providers')
        dialog.set_visible_page(page);

    dialog.present();
}
