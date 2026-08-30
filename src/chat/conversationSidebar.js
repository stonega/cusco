import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { createBundledIcon } from '../bundledIcons.js';
import {
    conversationListPageTarget,
    formatConversationUpdatedAt,
} from './presentation.js';

const CONVERSATION_LIST_PAGE_SIZE = 50;
const MORE_VERTICAL_ICON_FILE = 'more-vertical-symbolic.svg';
const PLUGINS_ICON_FILE = 'plugins-symbolic.svg';
const USAGE_ICON_FILE = 'usage-symbolic.svg';

function clearConversationListRow(container) {
    container?._conversationRow?._releaseConversationRow?.();
    container._conversationRow = null;

    for (let child = container?.get_first_child?.(); child;) {
        const next = child.get_next_sibling();
        container.remove(child);
        child = next;
    }
}

function isCronConversation(conversation) {
    return conversation?.conversationType === 'cron' && Boolean(conversation.cronJobId);
}

export function conversationListSplices(previousIds, nextIds, changedIds = new Set()) {
    const previous = Array.isArray(previousIds) ? previousIds : [];
    const next = Array.isArray(nextIds) ? nextIds : [];
    const changed = changedIds instanceof Set ? changedIds : new Set(changedIds);
    let prefixLength = 0;

    while (prefixLength < previous.length
        && prefixLength < next.length
        && previous[prefixLength] === next[prefixLength]) {
        prefixLength++;
    }

    let suffixLength = 0;

    while (suffixLength < previous.length - prefixLength
        && suffixLength < next.length - prefixLength
        && previous[previous.length - 1 - suffixLength] === next[next.length - 1 - suffixLength]) {
        suffixLength++;
    }

    const splices = [];
    const removedCount = previous.length - prefixLength - suffixLength;
    const additions = next.slice(prefixLength, next.length - suffixLength);

    if (removedCount > 0 || additions.length > 0) {
        splices.push({
            position: prefixLength,
            removedCount,
            additions,
        });
    }

    for (let index = 0; index < next.length; index++) {
        const insideReplacement = index >= prefixLength
            && index < next.length - suffixLength;

        if (!insideReplacement && changed.has(next[index])) {
            splices.push({
                position: index,
                removedCount: 1,
                additions: [next[index]],
            });
        }
    }

    return splices;
}

export class ConversationSidebar {
    constructor({
        conversations,
        isConversationBusy = () => false,
        getAutomationJob = () => null,
        onNewChat = () => {},
        onNewAutomation = () => {},
        onSettings = () => {},
        onShowUsage = () => {},
        onShowPlugins = () => {},
        onSelectConversation = () => {},
        onRenameConversation = () => {},
        onArchiveConversation = () => {},
        onExportConversation = () => {},
        onDeleteConversation = () => {},
        onDeleteCronConversation = () => {},
        onEditAutomation = () => {},
        onRunAutomation = () => {},
        onToggleAutomation = () => {},
        onModeChanged = () => {},
    }) {
        this._conversations = conversations;
        this._isConversationBusy = isConversationBusy;
        this._getAutomationJob = getAutomationJob;
        this._callbacks = {
            onNewChat,
            onNewAutomation,
            onSettings,
            onShowUsage,
            onShowPlugins,
            onSelectConversation,
            onRenameConversation,
            onArchiveConversation,
            onExportConversation,
            onDeleteConversation,
            onDeleteCronConversation,
            onEditAutomation,
            onRunAutomation,
            onToggleAutomation,
            onModeChanged,
        };
        this._mode = 'chats';
        this._settingMode = false;
        this._selectedConversationByMode = new Map();
        this._results = [];
        this._loadedCount = 0;
        this._hasMore = false;
        this._query = '';
        this._isLoadingPage = false;
        this._isRefreshing = false;
        this._rowFingerprints = new Map();
        this.widget = this._createWidget();
    }

    _createWidget() {
        const sidebar = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        sidebar.add_css_class('sidebar');
        sidebar.add_css_class('cusco-sidebar');
        sidebar.set_size_request(280, -1);

        const sidebarHandle = new Gtk.WindowHandle();
        const sidebarHeader = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        this.newChatButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'New chat',
        });
        this.newChatButton.add_css_class('flat');
        this.newChatButton.connect('clicked', () => {
            if (this._mode === 'automations')
                this._callbacks.onNewAutomation();
            else
                this._callbacks.onNewChat();
        });
        this.title = new Gtk.Label({ label: 'Chats', hexpand: true, xalign: 0.5 });
        this.title.add_css_class('heading');
        this.mainMenuButton = this._createMainMenuButton();
        sidebarHeader.append(this.newChatButton);
        sidebarHeader.append(this.title);
        sidebarHeader.append(this.mainMenuButton);
        sidebarHandle.set_child(sidebarHeader);
        sidebar.append(sidebarHandle);

        const sidebarContent = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            hexpand: true,
            vexpand: true,
        });
        this.search = new Gtk.SearchEntry({
            placeholder_text: 'Search chats',
            hexpand: true,
            margin_start: 6,
            margin_end: 6,
        });
        this.search.connect('search-changed', () => this.refresh({ resetPage: true }));
        sidebarContent.append(this.search);

        this.listModel = Gtk.StringList.new([]);
        this.selectionModel = new Gtk.SingleSelection({
            model: this.listModel,
            autoselect: false,
            can_unselect: true,
        });
        this._factory = new Gtk.SignalListItemFactory();
        this._factory.connect('setup', (_factory, listItem) => {
            listItem.set_child(new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                hexpand: true,
            }));
        });
        this._factory.connect('bind', (_factory, listItem) => {
            const container = listItem.get_child();
            const conversationId = listItem.get_item()?.get_string?.() ?? '';
            const conversation = this._conversations.getConversation(conversationId);
            clearConversationListRow(container);
            if (conversation) {
                container._conversationRow = this.createConversationRow(conversation);
                container.append(container._conversationRow);
            }
        });
        this._factory.connect('unbind', (_factory, listItem) => {
            clearConversationListRow(listItem.get_child());
        });
        this.list = new Gtk.ListView({
            model: this.selectionModel,
            factory: this._factory,
            hexpand: true,
            vexpand: true,
        });
        this.list.add_css_class('cusco-conversation-list');
        this.selectionModel.connect('notify::selected', () => {
            if (this._isRefreshing)
                return;
            const conversationId = this.selectionModel.get_selected_item()?.get_string?.() ?? '';
            if (conversationId)
                this._callbacks.onSelectConversation(conversationId);
        });
        this.scroller = new Gtk.ScrolledWindow({
            child: this.list,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        this.scroller.add_css_class('cusco-conversation-list-scroller');
        const adjustment = this.scroller.get_vadjustment();
        adjustment.connect('value-changed', () => this.maybeLoadNextPage());
        adjustment.connect('changed', () => this.maybeLoadNextPage());

        this.emptyState = new Adw.StatusPage({
            icon_name: 'alarm-symbolic',
            title: 'No automations yet',
            description: 'Create one to send an AI prompt on a schedule.',
        });
        this.emptyState.add_css_class('compact');
        this.resultsStack = new Gtk.Stack({
            hexpand: true,
            vexpand: true,
            hhomogeneous: false,
            vhomogeneous: false,
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 160,
        });
        this.resultsStack.add_named(this.scroller, 'list');
        this.resultsStack.add_named(this.emptyState, 'empty');
        this.resultsStack.set_visible_child_name('list');

        sidebarContent.append(this.resultsStack);
        sidebar.append(sidebarContent);

        const sidebarFooter = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        sidebarFooter.add_css_class('linked');
        sidebarFooter.add_css_class('cusco-sidebar-mode-switcher');
        this.chatsButton = new Gtk.ToggleButton({
            label: 'Chat',
            active: true,
            hexpand: true,
            tooltip_text: 'Show chats',
        });
        this.automationsButton = new Gtk.ToggleButton({
            label: 'Automations',
            hexpand: true,
            tooltip_text: 'Show scheduled AI tasks',
        });
        this.automationsButton.set_group(this.chatsButton);
        this.chatsButton.connect('toggled', () => {
            if (!this._settingMode && this.chatsButton.get_active())
                this.setMode('chats');
        });
        this.automationsButton.connect('toggled', () => {
            if (!this._settingMode && this.automationsButton.get_active())
                this.setMode('automations');
        });
        sidebarFooter.append(this.chatsButton);
        sidebarFooter.append(this.automationsButton);
        sidebar.append(sidebarFooter);
        return sidebar;
    }

    get mode() {
        return this._mode;
    }

    setMode(mode, options = {}) {
        const nextMode = mode === 'automations' ? 'automations' : 'chats';
        const activeConversation = this._conversations.activeConversation;

        if (activeConversation && this._conversationBelongsToMode(activeConversation, this._mode))
            this._selectedConversationByMode.set(this._mode, activeConversation.id);

        this._mode = nextMode;
        this.title?.set_label(nextMode === 'automations' ? 'Automations' : 'Chats');
        this.search?.set_placeholder_text(
            nextMode === 'automations' ? 'Search automations' : 'Search chats',
        );
        this.newChatButton?.set_tooltip_text(
            nextMode === 'automations' ? 'New automation' : 'New chat',
        );

        this._settingMode = true;
        try {
            if (this.chatsButton?.get_active() !== (nextMode === 'chats'))
                this.chatsButton?.set_active(nextMode === 'chats');
            if (this.automationsButton?.get_active() !== (nextMode === 'automations'))
                this.automationsButton?.set_active(nextMode === 'automations');
        } finally {
            this._settingMode = false;
        }

        this.refresh({ resetPage: true });
        this._callbacks.onModeChanged(nextMode);

        if (options.selectConversation === false)
            return;

        if (options.preserveSelection
            && activeConversation
            && this._conversationBelongsToMode(activeConversation, nextMode)) {
            return;
        }

        const rememberedId = this._selectedConversationByMode.get(nextMode);
        const nextConversation = this._results.find((conversation) => (
            conversation.id === rememberedId
        )) ?? this._results[0] ?? null;

        if (nextConversation && nextConversation.id !== activeConversation?.id)
            this._callbacks.onSelectConversation(nextConversation.id);
    }

    _conversationBelongsToMode(conversation, mode = this._mode) {
        return isCronConversation(conversation) === (mode === 'automations');
    }

    _createMainMenuButton() {
        const menuButton = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'Main menu',
        });
        menuButton.add_css_class('flat');
        const popover = new Gtk.Popover();
        const menu = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const addMenuItem = (icon, label, callback) => {
            const item = new Gtk.Button({
                halign: Gtk.Align.FILL,
                tooltip_text: label,
            });
            item.add_css_class('flat');
            item.add_css_class('cusco-sidebar-menu-item');
            const content = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                margin_top: 4,
                margin_bottom: 4,
                margin_start: 6,
                margin_end: 6,
            });
            content.append(icon);
            content.append(new Gtk.Label({ label, xalign: 0, hexpand: true }));
            item.set_child(content);
            item.connect('clicked', () => {
                popover.popdown();
                callback();
            });
            menu.append(item);
        };

        addMenuItem(
            createBundledIcon(PLUGINS_ICON_FILE, 'application-x-addon-symbolic', { pixelSize: 18 }),
            'Plugins',
            this._callbacks.onShowPlugins,
        );
        addMenuItem(
            createBundledIcon(USAGE_ICON_FILE, 'view-list-symbolic', { pixelSize: 18 }),
            'Usage',
            this._callbacks.onShowUsage,
        );
        addMenuItem(
            new Gtk.Image({ icon_name: 'emblem-system-symbolic', pixel_size: 18 }),
            'Settings',
            this._callbacks.onSettings,
        );

        popover.set_child(menu);
        menuButton.set_popover(popover);
        return menuButton;
    }

    dispose() {
        this.list?.set_model(null);
        this.list?.set_factory(null);
        this._results = [];
        this._rowFingerprints.clear();
    }

    _conversationRowFingerprint(conversation) {
        const automationJob = isCronConversation(conversation)
            ? this._getAutomationJob(conversation.cronJobId)
            : null;

        return JSON.stringify([
            conversation?.title ?? '',
            conversation?.updatedAt ?? conversation?.createdAt ?? '',
            this._isConversationBusy(conversation?.id),
            automationJob?.enabled ?? null,
            automationJob?.schedule ?? '',
            automationJob?.prompt ?? '',
        ]);
    }

    refresh({ resetPage = false } = {}) {
        this._isRefreshing = true;
        try {
            const activeConversation = this._conversations.activeConversation;
            const query = this.search?.get_text() ?? '';
            const conversationType = this._mode === 'automations' ? 'cron' : 'chat';
            const queryChanged = query !== this._query;
            const requestedCount = resetPage || queryChanged
                ? CONVERSATION_LIST_PAGE_SIZE
                : Math.max(CONVERSATION_LIST_PAGE_SIZE, this._loadedCount);
            const activePosition = query.trim()
                ? -1
                : this._conversations.conversationPosition(activeConversation?.id, {
                    conversationType,
                });
            const targetCount = conversationListPageTarget(
                Number.MAX_SAFE_INTEGER,
                requestedCount,
                activePosition,
            );
            const page = this._conversations.conversationPage(query, {
                conversationType,
                limit: targetCount,
            });
            const activeIndex = page.conversations.findIndex((conversation) => (
                conversation.id === activeConversation?.id
            ));
            const previousIds = this._results.map((conversation) => conversation.id);
            const conversationIds = page.conversations.map((conversation) => conversation.id);
            const nextFingerprints = new Map(page.conversations.map((conversation) => [
                conversation.id,
                this._conversationRowFingerprint(conversation),
            ]));
            const changedIds = new Set(conversationIds.filter((conversationId) => (
                this._rowFingerprints.has(conversationId)
                && this._rowFingerprints.get(conversationId) !== nextFingerprints.get(conversationId)
            )));
            this._results = page.conversations;
            this._loadedCount = page.conversations.length;
            this._hasMore = page.hasMore;
            this._query = query;
            this._rowFingerprints = nextFingerprints;

            for (const splice of conversationListSplices(previousIds, conversationIds, changedIds)) {
                this.listModel.splice(
                    splice.position,
                    splice.removedCount,
                    splice.additions,
                );
            }

            this._syncEmptyState(query);
            if (activeIndex >= 0 && activeIndex < this._loadedCount)
                this.selectionModel.set_selected(activeIndex);
            else
                this.selectionModel.set_selected(Gtk.INVALID_LIST_POSITION);
        } finally {
            this._isRefreshing = false;
        }
    }

    _syncEmptyState(query = '') {
        if (this._results.length > 0) {
            this.resultsStack?.set_visible_child_name('list');
            return;
        }

        const hasQuery = Boolean(String(query ?? '').trim());
        const automations = this._mode === 'automations';
        this.emptyState?.set_icon_name(hasQuery ? 'system-search-symbolic' : (
            automations ? 'alarm-symbolic' : 'mail-message-new-symbolic'
        ));
        this.emptyState?.set_title(hasQuery
            ? `No matching ${automations ? 'automations' : 'chats'}`
            : automations ? 'No automations yet' : 'No chats yet');
        this.emptyState?.set_description(hasQuery
            ? 'Try a different search.'
            : automations
                ? 'Create one to send an AI prompt on a schedule.'
                : 'Start a chat to see it here.');
        this.resultsStack?.set_visible_child_name('empty');
    }

    maybeLoadNextPage() {
        if (this._isRefreshing || this._isLoadingPage || !this._hasMore)
            return;
        const adjustment = this.scroller?.get_vadjustment?.();
        if (!adjustment)
            return;
        const remaining = adjustment.get_upper()
            - adjustment.get_page_size()
            - adjustment.get_value();
        if (remaining > 128)
            return;
        this._isLoadingPage = true;
        try {
            const page = this._conversations.conversationPage(this._query, {
                conversationType: this._mode === 'automations' ? 'cron' : 'chat',
                offset: this._loadedCount,
                limit: CONVERSATION_LIST_PAGE_SIZE,
            });
            this.listModel.splice(
                this.listModel.get_n_items(),
                0,
                page.conversations.map((conversation) => conversation.id),
            );
            for (const conversation of page.conversations) {
                this._rowFingerprints.set(
                    conversation.id,
                    this._conversationRowFingerprint(conversation),
                );
            }
            this._results.push(...page.conversations);
            this._loadedCount += page.conversations.length;
            this._hasMore = page.hasMore;
        } finally {
            this._isLoadingPage = false;
        }
    }

    createConversationRow(conversation, hoverTarget = null) {
        const automationJob = isCronConversation(conversation)
            ? this._getAutomationJob(conversation.cronJobId)
            : null;
        const rowBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 6,
            margin_end: 6,
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        const title = new Gtk.Label({
            label: conversation.title,
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        });
        const titleRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            hexpand: true,
        });
        if (isCronConversation(conversation)) {
            const cronIcon = new Gtk.Image({
                icon_name: 'alarm-symbolic',
                tooltip_text: 'Automation',
                valign: Gtk.Align.CENTER,
            });
            cronIcon.set_pixel_size(14);
            cronIcon.add_css_class('cusco-automation-icon');
            titleRow.append(cronIcon);
        }
        titleRow.append(title);
        const subtitle = new Gtk.Label({
            label: isCronConversation(conversation)
                ? [
                    automationJob
                        ? (automationJob.enabled ? 'Active' : 'Paused')
                        : 'Schedule unavailable',
                    automationJob?.schedule ?? '',
                ].filter(Boolean).join(' · ')
                : formatConversationUpdatedAt(conversation.updatedAt ?? conversation.createdAt),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
        });
        subtitle.add_css_class('caption');
        subtitle.add_css_class('dim-label');
        box.append(titleRow);
        box.append(subtitle);

        const activeDot = this._isConversationBusy(conversation.id)
            ? new Gtk.Box({
                width_request: 8,
                height_request: 8,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
                can_target: false,
            })
            : null;
        activeDot?.add_css_class('cusco-conversation-active-dot');
        activeDot?.update_property([Gtk.AccessibleProperty.LABEL], ['Response in progress']);
        const actionsOverlay = new Gtk.Overlay({
            valign: Gtk.Align.CENTER,
            tooltip_text: activeDot ? 'Response in progress' : null,
        });
        const actions = this.createConversationMenuButton(conversation, hoverTarget ?? rowBox, {
            onVisibilityChanged: (menuVisible) => activeDot?.set_visible(!menuVisible),
        });
        actionsOverlay.set_child(actions);
        if (activeDot)
            actionsOverlay.add_overlay(activeDot);
        rowBox.append(box);
        rowBox.append(actionsOverlay);
        rowBox._releaseConversationRow = () => {
            actions._releaseConversationMenu?.();
            rowBox._releaseConversationRow = null;
        };
        return rowBox;
    }

    createConversationMenuButton(conversation, hoverTarget, options = {}) {
        const menuButton = new Gtk.MenuButton({
            tooltip_text: isCronConversation(conversation) ? 'Automation actions' : 'Chat actions',
            valign: Gtk.Align.CENTER,
        });
        menuButton.set_child(createBundledIcon(MORE_VERTICAL_ICON_FILE, 'view-more-symbolic'));
        menuButton.add_css_class('flat');
        menuButton.add_css_class('cusco-conversation-menu-button');
        const popover = new Gtk.Popover();
        const menu = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        menu.add_css_class('cusco-conversation-menu');
        const menuItems = [];
        const addMenuItem = (iconName, label, onClicked, itemOptions = {}) => {
            const item = this.createConversationMenuItem(iconName, label, () => {
                popover.popdown();
                onClicked();
            }, itemOptions);
            menuItems.push(item);
            menu.append(item);
        };
        if (isCronConversation(conversation)) {
            const automationJob = this._getAutomationJob(conversation.cronJobId);

            if (automationJob?.prompt) {
                addMenuItem('media-playback-start-symbolic', 'Run now', () => {
                    this._callbacks.onRunAutomation(conversation.id);
                });
                addMenuItem('document-edit-symbolic', 'Edit automation', () => {
                    this._callbacks.onEditAutomation(conversation.id);
                });
                addMenuItem(
                    automationJob.enabled
                        ? 'media-playback-pause-symbolic'
                        : 'media-playback-start-symbolic',
                    automationJob.enabled ? 'Pause automation' : 'Resume automation',
                    () => this._callbacks.onToggleAutomation(conversation.id),
                );
            }
            addMenuItem('user-trash-symbolic', 'Delete automation', () => {
                this._callbacks.onDeleteCronConversation(conversation.id);
            }, { destructive: true });
        } else {
            addMenuItem('document-edit-symbolic', 'Rename chat', () => {
                this._callbacks.onRenameConversation(conversation.id);
            });
            addMenuItem('folder-documents-symbolic', 'Archive chat', () => {
                this._callbacks.onArchiveConversation(conversation.id);
            });
            addMenuItem('document-save-symbolic', 'Export chat', () => {
                this._callbacks.onExportConversation(conversation.id);
            });
            addMenuItem('user-trash-symbolic', 'Delete chat', () => {
                this._callbacks.onDeleteConversation(conversation.id);
            }, { destructive: true });
        }
        popover.set_child(menu);
        menuButton.set_popover(popover);
        const setMenuVisible = (visible) => {
            menuButton.set_opacity(visible ? 1 : 0);
            menuButton.set_sensitive(visible);
            options.onVisibilityChanged?.(visible);
        };
        let isHovered = false;
        const syncMenuVisibility = () => setMenuVisible(isHovered || popover.get_visible());
        const motionController = new Gtk.EventControllerMotion();
        const enterSignalId = motionController.connect('enter', () => {
            isHovered = true;
            syncMenuVisibility();
        });
        const leaveSignalId = motionController.connect('leave', () => {
            isHovered = false;
            syncMenuVisibility();
        });
        const closedSignalId = popover.connect('closed', syncMenuVisibility);
        hoverTarget.add_controller(motionController);
        setMenuVisible(false);
        menuButton._setConversationMenuVisible = setMenuVisible;
        menuButton._releaseConversationMenu = () => {
            motionController.disconnect(enterSignalId);
            motionController.disconnect(leaveSignalId);
            popover.disconnect(closedSignalId);
            hoverTarget.remove_controller(motionController);
            for (const item of menuItems)
                item._releaseConversationMenuItem?.();
            popover.set_child(null);
            menuButton.set_popover(null);
            menuButton._setConversationMenuVisible = null;
            menuButton._releaseConversationMenu = null;
        };
        return menuButton;
    }

    createConversationMenuItem(iconName, label, onClicked, options = {}) {
        const button = new Gtk.Button({
            icon_name: iconName,
            tooltip_text: label,
            halign: Gtk.Align.FILL,
        });
        button.add_css_class('flat');
        button.add_css_class('cusco-conversation-menu-item');
        if (options.destructive)
            button.add_css_class('destructive-action');
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 6,
            margin_end: 6,
        });
        content.append(new Gtk.Image({ icon_name: iconName }));
        content.append(new Gtk.Label({ label, xalign: 0, hexpand: true }));
        button.set_child(content);
        const clickedSignalId = button.connect('clicked', onClicked);
        button._releaseConversationMenuItem = () => {
            button.disconnect(clickedSignalId);
            button._releaseConversationMenuItem = null;
        };
        return button;
    }
}
