import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { createApplicationSettingsPage } from './appSettings.js';
import { createMemorySettingsPage } from './memorySettings.js';
import { createSkillsSettingsPage, createWorkspaceSettingsPage } from './workspaceSettings.js';

function createStringList(values) {
    const list = new Gtk.StringList();

    for (const value of values)
        list.append(value);

    return list;
}

function getDefaultModelIndex(provider) {
    const index = provider.models.findIndex((model) => model.id === provider.defaultModelId);
    return Math.max(index, 0);
}

function canDisableProvider(providerConfigs, provider) {
    const providerIsUsable = provider.implemented && (!provider.apiKeyRequired || provider.apiKeyConfigured);

    return !provider.enabled
        || !providerIsUsable
        || providerConfigs.listProviders({ enabledOnly: true }).length > 1;
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

function canDiscoverModels(provider) {
    return Boolean(provider.apiFormat)
        && provider.supportsModelDiscovery !== false
        && (!provider.apiKeyRequired || provider.apiKeyConfigured)
        && (!provider.customizable || Boolean(provider.baseUrl));
}

function createProviderEnabledSwitch() {
    return new Gtk.Switch({
        tooltip_text: 'Show this provider in chat provider pickers.',
        valign: Gtk.Align.CENTER,
    });
}

function createProviderRow(providerConfigs, providerId, onChanged, syncAllRows) {
    const provider = providerConfigs.getProvider(providerId);
    const row = new Adw.ExpanderRow({
        title: provider.name,
        subtitle: provider.description,
    });

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

            try {
                await providerConfigs.discoverModels(providerId);
                syncAllRows();
                onChanged();
            } catch (error) {
                syncAllRows();
                logError(error, 'Failed to discover provider models');
            } finally {
                discoverButton.set_sensitive(canDiscoverModels(providerConfigs.getProvider(providerId)));
            }
        });
        discoveryRow.add_suffix(discoverButton);
        row.add_row(discoveryRow);
        row._discoverButton = discoverButton;
    }

    if (provider.apiKeyRequired) {
        const apiKeyRow = new Adw.PasswordEntryRow({
            title: 'API key',
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

    const sync = () => {
        const currentProvider = providerConfigs.getProvider(providerId);
        const canEnableProvider = providerConfigs.canEnableProvider(providerId);

        enabledSwitch._syncing = true;
        enabledSwitch.set_active(currentProvider.enabled);
        enabledSwitch.set_sensitive(currentProvider.implemented
            && (currentProvider.enabled
                ? canDisableProvider(providerConfigs, currentProvider)
                : canEnableProvider));
        enabledSwitch.set_tooltip_text(getEnabledRowSubtitle(currentProvider, canEnableProvider));
        enabledSwitch._syncing = false;

        if (row._endpointRow)
            row._endpointRow.set_text(currentProvider.baseUrl ?? '');

        if (row._modelsEntryRow)
            row._modelsEntryRow.set_text(currentProvider.models.map((model) => model.id).join(', '));

        if (row._modelRow) {
            row._modelRow._syncing = true;
            row._modelRow.set_model(createStringList(currentProvider.models.map((model) => model.name)));
            row._modelRow.set_sensitive(currentProvider.models.length > 0);
            row._modelRow.set_selected(getDefaultModelIndex(currentProvider));
            row._modelRow._syncing = false;
        }

        row._apiKeyStatusRow?.set_subtitle(getApiKeySubtitle(providerConfigs, currentProvider));
        row._clearKeyButton?.set_sensitive(providerConfigs.getApiKeyStatus(providerId).source === 'secret');
        row._discoverButton?.set_sensitive(canDiscoverModels(currentProvider));
    };

    sync();

    return { row, sync };
}

export function createProviderSettingsPage(providerConfigs, onChanged) {
    providerConfigs.refreshApiKeyStatus();

    const page = new Adw.PreferencesPage({
        title: 'Providers',
        icon_name: 'network-server-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: 'Provider Management',
        description: 'Choose which providers are available and configure default models.',
    });

    const providerRows = [];
    const syncAllRows = () => {
        providerConfigs.refreshApiKeyStatus();

        for (const providerRow of providerRows)
            providerRow.sync();
    };

    for (const provider of providerConfigs.listProviders()) {
        const providerRow = createProviderRow(providerConfigs, provider.id, onChanged, syncAllRows);
        providerRows.push(providerRow);
        group.add(providerRow.row);
    }

    page.add(group);
    return page;
}

export function presentProviderSettingsDialog(
    parent,
    providerConfigs,
    appSettingsOrOnChanged,
    memoryManagerOrOnChanged = null,
    workspaceManagerOrOnChanged = null,
    maybeOnChanged = null,
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
    const onChanged = (typeof appSettingsOrOnChanged === 'function'
        ? appSettingsOrOnChanged
        : typeof memoryManagerOrOnChanged === 'function'
            ? memoryManagerOrOnChanged
            : typeof workspaceManagerOrOnChanged === 'function'
                ? workspaceManagerOrOnChanged
                : maybeOnChanged) ?? (() => {});
    const dialog = new Adw.PreferencesWindow({
        title: 'Settings',
        search_enabled: false,
    });
    dialog.set_transient_for(parent);

    if (appSettings)
        dialog.add(createApplicationSettingsPage(appSettings, onChanged));

    if (memoryManager)
        dialog.add(createMemorySettingsPage(dialog, memoryManager, onChanged));

    if (workspaceManager) {
        dialog.add(createWorkspaceSettingsPage(dialog, workspaceManager, onChanged));
        dialog.add(createSkillsSettingsPage(dialog, workspaceManager, onChanged));
    }

    const page = createProviderSettingsPage(providerConfigs, onChanged);
    dialog.add(page);
    dialog.present(parent);
}
