import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { createBundledIcon } from '../bundledIcons.js';
import {
    conversationListPageTarget,
    formatConversationUpdatedAt,
} from './presentation.js';

const CONVERSATION_LIST_PAGE_SIZE = 50;
const MORE_VERTICAL_ICON_FILE = 'more-vertical-symbolic.svg';
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

export class ConversationSidebar {
    constructor({
        conversations,
        isConversationBusy = () => false,
        onNewChat = () => {},
        onSettings = () => {},
        onShowUsage = () => {},
        onSelectConversation = () => {},
        onRenameConversation = () => {},
        onArchiveConversation = () => {},
        onExportConversation = () => {},
        onDeleteConversation = () => {},
        onDeleteCronConversation = () => {},
    }) {
        this._conversations = conversations;
        this._isConversationBusy = isConversationBusy;
        this._callbacks = {
            onNewChat,
            onSettings,
            onShowUsage,
            onSelectConversation,
            onRenameConversation,
            onArchiveConversation,
            onExportConversation,
            onDeleteConversation,
            onDeleteCronConversation,
        };
        this._results = [];
        this._loadedCount = 0;
        this._hasMore = false;
        this._query = '';
        this._isLoadingPage = false;
        this._isRefreshing = false;
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
        this.newChatButton.connect('clicked', this._callbacks.onNewChat);
        this.title = new Gtk.Label({ label: 'Chats', hexpand: true, xalign: 0.5 });
        this.title.add_css_class('heading');
        this.settingsButton = new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: 'Preferences',
        });
        this.settingsButton.connect('clicked', this._callbacks.onSettings);
        sidebarHeader.append(this.newChatButton);
        sidebarHeader.append(this.title);
        sidebarHeader.append(this.settingsButton);
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

        const conversationOverlay = new Gtk.Overlay({
            hexpand: true,
            vexpand: true,
        });
        conversationOverlay.set_child(this.scroller);

        const usageButtonContent = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
        });
        usageButtonContent.append(createBundledIcon(
            USAGE_ICON_FILE,
            'view-list-symbolic',
            { pixelSize: 18 },
        ));
        usageButtonContent.append(new Gtk.Label({ label: 'Usage', xalign: 0, hexpand: true }));
        this.usageButton = new Gtk.ToggleButton({
            child: usageButtonContent,
            hexpand: true,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.END,
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 12,
            tooltip_text: 'Usage',
        });
        this.usageButton.add_css_class('cusco-sidebar-destination');
        this.usageButton.connect('clicked', this._callbacks.onShowUsage);
        conversationOverlay.add_overlay(this.usageButton);
        sidebarContent.append(conversationOverlay);
        sidebar.append(sidebarContent);
        return sidebar;
    }

    dispose() {
        this.list?.set_model(null);
        this.list?.set_factory(null);
        this._results = [];
    }

    refresh({ resetPage = false } = {}) {
        this._isRefreshing = true;
        try {
            const activeConversation = this._conversations.activeConversation;
            const query = this.search?.get_text() ?? '';
            const queryChanged = query !== this._query;
            const requestedCount = resetPage || queryChanged
                ? CONVERSATION_LIST_PAGE_SIZE
                : Math.max(CONVERSATION_LIST_PAGE_SIZE, this._loadedCount);
            const activePosition = query.trim()
                ? -1
                : this._conversations.conversationPosition(activeConversation?.id);
            const targetCount = conversationListPageTarget(
                Number.MAX_SAFE_INTEGER,
                requestedCount,
                activePosition,
            );
            const page = this._conversations.conversationPage(query, { limit: targetCount });
            const activeIndex = page.conversations.findIndex((conversation) => (
                conversation.id === activeConversation?.id
            ));
            const conversationIds = page.conversations.map((conversation) => conversation.id);
            this._results = page.conversations;
            this._loadedCount = page.conversations.length;
            this._hasMore = page.hasMore;
            this._query = query;
            this.listModel.splice(0, this.listModel.get_n_items(), conversationIds);
            if (activeIndex >= 0 && activeIndex < this._loadedCount)
                this.selectionModel.set_selected(activeIndex);
            else
                this.selectionModel.set_selected(Gtk.INVALID_LIST_POSITION);
        } finally {
            this._isRefreshing = false;
        }
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
                offset: this._loadedCount,
                limit: CONVERSATION_LIST_PAGE_SIZE,
            });
            this.listModel.splice(
                this.listModel.get_n_items(),
                0,
                page.conversations.map((conversation) => conversation.id),
            );
            this._results.push(...page.conversations);
            this._loadedCount += page.conversations.length;
            this._hasMore = page.hasMore;
        } finally {
            this._isLoadingPage = false;
        }
    }

    createConversationRow(conversation, hoverTarget = null) {
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
                tooltip_text: 'Cron job chat',
                valign: Gtk.Align.CENTER,
            });
            cronIcon.set_pixel_size(14);
            cronIcon.add_css_class('cusco-cron-chat-icon');
            titleRow.append(cronIcon);
        }
        titleRow.append(title);
        const subtitle = new Gtk.Label({
            label: formatConversationUpdatedAt(conversation.updatedAt ?? conversation.createdAt),
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
            tooltip_text: 'Chat actions',
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
        addMenuItem('document-edit-symbolic', 'Rename chat', () => {
            this._callbacks.onRenameConversation(conversation.id);
        });
        if (isCronConversation(conversation)) {
            addMenuItem('user-trash-symbolic', 'Delete cron job', () => {
                this._callbacks.onDeleteCronConversation(conversation.id);
            }, { destructive: true });
        } else {
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
