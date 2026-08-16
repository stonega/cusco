import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { getBundledImagePath } from '../bundledIcons.js';

const EMPTY_STATE_IMAGE_DARK = 'machupicchu_dark.png';
const EMPTY_STATE_IMAGE_LIGHT = 'machupicchu_light.png';
const EMPTY_STATE_FADE_DURATION_MS = 220;

export class EmptyConversationPresenter {
    constructor({
        appSettings,
        getState,
        setState,
    }) {
        this._appSettings = appSettings;

        for (const name of [
            '_conversationLoadingView',
            '_conversationStack',
            '_emptyConversationFadeTimeoutId',
            '_emptyConversationPicture',
            '_emptyConversationState',
            '_emptyConversationThemeHandlerId',
        ]) {
            Object.defineProperty(this, name, {
                configurable: true,
                get: () => getState(name),
                set: (value) => setState(name, value),
            });
        }
    }

    _createEmptyConversationState() {
        const revealer = new Gtk.Revealer({
            halign: Gtk.Align.START,
            valign: Gtk.Align.START,
            transition_type: Gtk.RevealerTransitionType.CROSSFADE,
            transition_duration: EMPTY_STATE_FADE_DURATION_MS,
            reveal_child: false,
            visible: false,
            can_target: false,
        });
        revealer.add_css_class('cusco-empty-conversation-state');

        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            can_target: false,
        });

        const frame = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });
        frame.add_css_class('cusco-empty-photo-frame');

        const lip = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });
        lip.add_css_class('cusco-empty-photo-lip');

        const mat = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
        });
        mat.add_css_class('cusco-empty-photo-mat');

        this._emptyConversationPicture = new Gtk.Picture({
            hexpand: true,
            vexpand: true,
            can_shrink: true,
            content_fit: Gtk.ContentFit.COVER,
        });
        this._emptyConversationPicture.add_css_class('cusco-empty-photo');

        mat.append(this._emptyConversationPicture);
        lip.append(mat);
        frame.append(lip);
        container.append(frame);
        revealer.set_child(container);

        const styleManager = Adw.StyleManager.get_default();
        this._emptyConversationThemeHandlerId = styleManager.connect('notify::dark', () => {
            this._updateEmptyConversationImage();
        });
        this._updateEmptyConversationImage();

        return revealer;
    }

    _syncEmptyConversationState(conversation = this._conversations.activeConversation) {
        if (!this._emptyConversationState)
            return;

        const isEmpty = (conversation?.messages?.length ?? 0) === 0;

        if (isEmpty)
            this._showEmptyConversationState();
        else
            this._hideEmptyConversationState();
    }

    _showConversationLoadingState() {
        this._conversationStack?.set_visible_child(this._conversationLoadingView);
        this._showEmptyConversationState();
    }

    _showEmptyConversationState() {
        if (!this._emptyConversationState)
            return;

        if (this._emptyConversationFadeTimeoutId) {
            GLib.source_remove(this._emptyConversationFadeTimeoutId);
            this._emptyConversationFadeTimeoutId = 0;
        }

        this._updateEmptyConversationImage();
        this._emptyConversationState.set_visible(true);
        this._emptyConversationState.set_reveal_child(true);
    }

    _hideEmptyConversationState() {
        if (!this._emptyConversationState)
            return;

        if (this._emptyConversationFadeTimeoutId) {
            GLib.source_remove(this._emptyConversationFadeTimeoutId);
            this._emptyConversationFadeTimeoutId = 0;
        }

        if (!this._emptyConversationState.get_visible()) {
            this._emptyConversationState.set_reveal_child(false);
            return;
        }

        this._emptyConversationState.set_reveal_child(false);
        this._emptyConversationFadeTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            EMPTY_STATE_FADE_DURATION_MS,
            () => {
                this._emptyConversationFadeTimeoutId = 0;

                if (!this._emptyConversationState?.get_reveal_child?.())
                    this._emptyConversationState?.set_visible(false);

                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _updateEmptyConversationImage() {
        if (!this._emptyConversationPicture)
            return;

        const customPath = this._appSettings.emptyChatImagePath;
        let path = customPath && GLib.file_test(customPath, GLib.FileTest.IS_REGULAR)
            ? customPath
            : null;

        if (!path) {
            const styleManager = Adw.StyleManager.get_default();
            const filename = styleManager.get_dark() ? EMPTY_STATE_IMAGE_DARK : EMPTY_STATE_IMAGE_LIGHT;
            path = getBundledImagePath(filename);
        }

        if (!path) {
            this._emptyConversationPicture.set_visible(false);
            return;
        }

        this._emptyConversationPicture.set_filename(path);
        this._emptyConversationPicture.set_visible(true);
    }

}
