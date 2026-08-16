import Gio from 'gi://Gio?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { getProviderGIcon } from './icons.js';
import { getThinkingLevelLabel, normalizeThinkingLevel } from './thinking.js';

const ID_COLUMN = 0;
const NAME_COLUMN = 1;
const ICON_COLUMN = 2;

export class ChatSelectionController {
    constructor({
        providerConfigs,
        conversations,
        workspace,
        appSettings,
        getProviderPicker,
        getModelPicker,
        getThinkingLevelPicker,
        getProviderConfigButton,
        getMemoryToggle,
        getAgentModeToggle,
        getSkillsToggle,
        refreshConversationList,
        discardUnsupportedImages,
        updateUsage,
        showProviderSettings,
    }) {
        this._providerConfigs = providerConfigs;
        this._conversations = conversations;
        this._workspace = workspace;
        this._appSettings = appSettings;
        this._getProviderPicker = getProviderPicker;
        this._getModelPicker = getModelPicker;
        this._getThinkingLevelPicker = getThinkingLevelPicker;
        this._getProviderConfigButton = getProviderConfigButton;
        this._getMemoryToggle = getMemoryToggle;
        this._getAgentModeToggle = getAgentModeToggle;
        this._getSkillsToggle = getSkillsToggle;
        this._refreshConversationList = refreshConversationList;
        this._discardUnsupportedImages = discardUnsupportedImages;
        this._updateUsage = updateUsage;
        this._showProviderSettings = showProviderSettings;
        this._updating = false;
    }

    createProviderPicker() {
        const picker = new Gtk.ComboBox({ id_column: ID_COLUMN });
        const iconRenderer = new Gtk.CellRendererPixbuf({ xpad: 2 });
        const textRenderer = new Gtk.CellRendererText({ ellipsize: Pango.EllipsizeMode.END });
        picker.pack_start(iconRenderer, false);
        picker.add_attribute(iconRenderer, 'gicon', ICON_COLUMN);
        picker.pack_start(textRenderer, true);
        picker.add_attribute(textRenderer, 'text', NAME_COLUMN);
        picker.add_css_class('cusco-selector-picker');
        return picker;
    }

    createProviderConfigButton() {
        const button = new Gtk.Button({
            label: 'Configure Provider',
            tooltip_text: 'Configure an AI provider',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        button.add_css_class('suggested-action');
        button.connect('clicked', () => this._showProviderSettings());
        return button;
    }

    populateProviders() {
        const picker = this._getProviderPicker();
        const providerStore = new Gtk.ListStore();
        let providerCount = 0;
        providerStore.set_column_types([
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            Gio.Icon.$gtype,
        ]);
        for (const provider of this._providerConfigs.listProviders({
            enabledOnly: true,
            usableOnly: false,
        })) {
            const iter = providerStore.append();
            providerCount += 1;
            providerStore.set(iter, [ID_COLUMN, NAME_COLUMN, ICON_COLUMN], [
                provider.id,
                provider.name,
                getProviderGIcon(provider),
            ]);
        }
        picker.set_model(providerStore);
        picker.set_id_column(ID_COLUMN);
        this.syncVisibility(providerCount > 0);
    }

    syncVisibility(hasEnabledProviders) {
        this._getProviderPicker()?.set_visible(hasEnabledProviders);
        this._getModelPicker()?.set_visible(hasEnabledProviders);
        if (!hasEnabledProviders)
            this._getThinkingLevelPicker()?.set_visible(false);
        this._getProviderConfigButton()?.set_visible(!hasEnabledProviders);
    }

    populateModels(providerId, selectedModelId = null) {
        const picker = this._getModelPicker();
        const provider = this._providerConfigs.getProvider(providerId);
        picker.remove_all();
        for (const model of provider?.models ?? [])
            picker.append(model.id, model.name);
        const fallbackModel = this._providerConfigs.getDefaultModel(providerId);
        picker.set_active_id(selectedModelId ?? fallbackModel?.id ?? null);
    }

    populateThinkingLevels(conversation) {
        const picker = this._getThinkingLevelPicker();
        if (!picker)
            return;
        picker.remove_all();
        if (!conversation) {
            picker.set_visible(false);
            picker.set_sensitive(false);
            return;
        }
        const levels = this._providerConfigs.getThinkingLevels(
            conversation.providerId,
            conversation.modelId,
        );
        if (levels.length === 0) {
            picker.set_visible(false);
            picker.set_tooltip_text('Thinking is not supported by this provider and model.');
            picker.set_sensitive(false);
            return;
        }
        for (const level of levels)
            picker.append(level, getThinkingLevelLabel(level));
        picker.set_active_id(this.resolveThinkingLevel(
            conversation.providerId,
            conversation.modelId,
            conversation.thinkingLevel,
        ));
        picker.set_tooltip_text('Thinking level for this chat');
        picker.set_visible(true);
        picker.set_sensitive(true);
    }

    sync(conversation) {
        if (!conversation) {
            this.populateThinkingLevels(null);
            return;
        }
        this._updating = true;
        try {
            this._getProviderPicker().set_active_id(conversation.providerId);
            this.populateModels(conversation.providerId, conversation.modelId);
            this.populateThinkingLevels(conversation);
            this._getMemoryToggle().set_active(conversation.memoryEnabled !== false);
            this._getAgentModeToggle().set_active(Boolean(conversation.agentModeEnabled));
            const skillsToggle = this._getSkillsToggle();
            skillsToggle.set_active(this._workspace.getSkillsForConversation(conversation).length > 0);
            skillsToggle.set_sensitive(this._workspace.enabledSkills.length > 0);
        } finally {
            this._updating = false;
        }
        this._discardUnsupportedImages();
    }

    handleMemoryChanged() {
        if (this._updating)
            return;
        const conversation = this._conversations.activeConversation;
        if (!conversation)
            return;
        this._conversations.setMemoryEnabled(conversation.id, this._getMemoryToggle().get_active());
        this._refreshConversationList();
    }

    handleAgentModeChanged() {
        if (this._updating)
            return;
        const conversation = this._conversations.activeConversation;
        if (!conversation)
            return;
        this._conversations.setAgentModeEnabled(
            conversation.id,
            this._getAgentModeToggle().get_active(),
        );
        this._refreshConversationList();
    }

    handleSkillsChanged() {
        if (this._updating)
            return;
        const conversation = this._conversations.activeConversation;
        if (!conversation)
            return;
        const skillIds = this._getSkillsToggle().get_active()
            ? this._workspace.enabledSkills.map((skill) => skill.id)
            : [];
        this._conversations.setSkillIds(conversation.id, skillIds);
        this._refreshConversationList();
    }

    resolveThinkingLevel(providerId, modelId, currentLevel) {
        const levels = this._providerConfigs.getThinkingLevels(providerId, modelId);
        const normalizedLevel = normalizeThinkingLevel(
            currentLevel ?? this._appSettings.thinkingLevel,
        );
        if (levels.length === 0 || levels.includes(normalizedLevel))
            return normalizedLevel;
        return this._providerConfigs.getDefaultThinkingLevel(providerId, modelId, normalizedLevel);
    }

    handleThinkingLevelChanged() {
        if (this._updating)
            return;
        const conversation = this._conversations.activeConversation;
        const thinkingLevel = this._getThinkingLevelPicker().get_active_id();
        if (!conversation || !thinkingLevel)
            return;
        this._conversations.setThinkingLevel(conversation.id, thinkingLevel);
        this._refreshConversationList();
    }

    handleProviderChanged() {
        if (this._updating)
            return;
        const conversation = this._conversations.activeConversation;
        const providerId = this._getProviderPicker().get_active_id();
        if (!conversation || !providerId)
            return;
        const model = this._providerConfigs.getDefaultModel(providerId);
        this._conversations.updateProviderConfig(conversation.id, {
            providerId,
            modelId: model?.id ?? '',
        });
        this._conversations.setThinkingLevel(
            conversation.id,
            this.resolveThinkingLevel(providerId, model?.id ?? '', conversation.thinkingLevel),
        );
        this._providerConfigs.setActiveSelection(providerId, model?.id ?? '');
        this.sync(conversation);
        this._discardUnsupportedImages();
        this._updateUsage(conversation);
        this._refreshConversationList();
    }

    handleModelChanged() {
        if (this._updating)
            return;
        const conversation = this._conversations.activeConversation;
        const modelId = this._getModelPicker().get_active_id();
        if (!conversation || !modelId)
            return;
        this._conversations.updateProviderConfig(conversation.id, {
            providerId: conversation.providerId,
            modelId,
        });
        this._conversations.setThinkingLevel(
            conversation.id,
            this.resolveThinkingLevel(conversation.providerId, modelId, conversation.thinkingLevel),
        );
        this._providerConfigs.setActiveSelection(conversation.providerId, modelId);
        this.sync(conversation);
        this._updateUsage(conversation);
        this._refreshConversationList();
    }
}
