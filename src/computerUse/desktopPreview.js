import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

const REFRESH_SECONDS = 1;
const HIDE_DELAY_MS = 500;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 200;

function createPicture(width, height) {
    const picture = new Gtk.Picture({
        can_shrink: true,
        content_fit: Gtk.ContentFit.CONTAIN,
        hexpand: true,
        vexpand: true,
    });
    picture.set_size_request(width, height);
    return picture;
}

function createFrameTextures(bytes) {
    const full = Gdk.Texture.new_from_bytes(new GLib.Bytes(bytes));
    const pixbuf = Gdk.pixbuf_get_from_texture(full);
    const scale = Math.min(1, PREVIEW_WIDTH / pixbuf.get_width(), PREVIEW_HEIGHT / pixbuf.get_height());
    const thumbnail = scale < 1
        ? pixbuf.scale_simple(
            Math.max(1, Math.round(pixbuf.get_width() * scale)),
            Math.max(1, Math.round(pixbuf.get_height() * scale)),
            GdkPixbuf.InterpType.BILINEAR)
        : pixbuf;
    return {
        full,
        thumbnail: Gdk.Texture.new_for_pixbuf(thumbnail),
    };
}

export class BackgroundDesktopPreview {
    constructor({ anchor, parentWindow, manager, canPreview }) {
        this._anchor = anchor;
        this._parentWindow = parentWindow;
        this._manager = manager;
        this._canPreview = canPreview;
        this._window = null;
        this._windowPicture = null;
        this._windowStatus = null;
        this._texture = null;
        this._status = 'Connecting to agent desktop…';
        this._refreshSourceId = 0;
        this._hideSourceId = 0;
        this._cancellable = null;
        this._generation = 0;
        this._refreshing = false;
        this._disposed = false;

        this._popoverPicture = createPicture(PREVIEW_WIDTH, PREVIEW_HEIGHT);
        this._popoverStatus = new Gtk.Label({
            label: 'Connecting…',
            xalign: 0,
            wrap: true,
            hexpand: true,
            max_width_chars: 18,
        });
        this._popoverStatus.add_css_class('caption');
        this._popoverStatus.add_css_class('dim-label');

        const openButton = new Gtk.Button({
            icon_name: 'window-new-symbolic',
            tooltip_text: 'Open in window',
        });
        openButton.add_css_class('flat');
        openButton.update_property([Gtk.AccessibleProperty.LABEL], ['Open in window']);
        openButton.connect('clicked', () => this.openWindow());
        const footer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        footer.append(this._popoverStatus);
        footer.append(openButton);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10,
        });
        content.append(this._popoverPicture);
        content.append(footer);

        this._popover = new Gtk.Popover({
            child: content,
            autohide: false,
            position: Gtk.PositionType.BOTTOM,
        });
        this._popover.set_parent(anchor);
        this._popover.connect('closed', () => this._stopRefreshingIfHidden());

        this._anchorMotion = new Gtk.EventControllerMotion();
        this._anchorMotion.connect('enter', () => {
            this._cancelHide();
            this._showPopover();
        });
        this._anchorMotion.connect('leave', () => this._scheduleHide());
        anchor.add_controller(this._anchorMotion);

        const popoverMotion = new Gtk.EventControllerMotion();
        popoverMotion.connect('enter', () => this._cancelHide());
        popoverMotion.connect('leave', () => this._scheduleHide());
        this._popover.add_controller(popoverMotion);
    }

    _showPopover() {
        if (this._disposed || !this._canPreview())
            return;
        this._popover.popup();
        this._startRefreshing();
    }

    _cancelHide() {
        if (!this._hideSourceId)
            return;
        GLib.Source.remove(this._hideSourceId);
        this._hideSourceId = 0;
    }

    _scheduleHide() {
        if (this._disposed)
            return;
        this._cancelHide();
        this._hideSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            this._hideSourceId = 0;
            this._popover.popdown();
            this._stopRefreshingIfHidden();
            return GLib.SOURCE_REMOVE;
        });
    }

    _isVisible() {
        return this._popover.get_visible() || Boolean(this._window);
    }

    _setStatus(message, compactMessage = message) {
        this._status = message;
        this._popoverStatus.set_label(compactMessage);
        this._windowStatus?.set_label(message);
    }

    _startRefreshing() {
        if (this._refreshSourceId)
            return;
        void this._refresh();
        this._refreshSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            if (!this._canPreview()) {
                this._refreshSourceId = 0;
                this.sync();
                return GLib.SOURCE_REMOVE;
            }
            if (!this._isVisible()) {
                this._refreshSourceId = 0;
                this._stopRefreshingIfHidden(true);
                return GLib.SOURCE_REMOVE;
            }
            void this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (this._refreshing || !this._canPreview())
            return;
        this._refreshing = true;
        const generation = this._generation;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        try {
            const frame = await this._manager.captureBackgroundDesktopPreview(cancellable);
            if (generation !== this._generation || cancellable.is_cancelled())
                return;
            const textures = createFrameTextures(frame.bytes);
            this._texture = textures.full;
            this._popoverPicture.set_paintable(textures.thumbnail);
            this._windowPicture?.set_paintable(this._texture);
            this._setStatus(
                `Live agent desktop · ${frame.width} × ${frame.height}`,
                `Live · ${frame.width} × ${frame.height}`);
        } catch (error) {
            if (generation === this._generation && !cancellable.is_cancelled())
                this._setStatus(`Preview unavailable: ${error.message ?? error}`, 'Preview unavailable');
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            this._refreshing = false;
        }
    }

    _stopRefreshingIfHidden(force = false) {
        if (!force && this._isVisible())
            return;
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        this._generation += 1;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    openWindow() {
        if (this._disposed || !this._canPreview())
            return;
        this._cancelHide();
        if (this._window) {
            this._window.present();
            this._popover.popdown();
            return;
        }

        const picture = createPicture(800, 500);
        if (this._texture)
            picture.set_paintable(this._texture);
        const status = new Gtk.Label({ label: this._status, xalign: 0 });
        status.add_css_class('caption');
        status.add_css_class('dim-label');
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        content.append(picture);
        content.append(status);

        const window = new Gtk.Window({
            application: this._parentWindow.get_application(),
            title: 'Agent desktop',
            default_width: 960,
            default_height: 640,
            child: content,
        });
        this._window = window;
        this._windowPicture = picture;
        this._windowStatus = status;
        window.connect('close-request', () => {
            this._window = null;
            this._windowPicture = null;
            this._windowStatus = null;
            this._stopRefreshingIfHidden();
            return false;
        });
        window.present();
        this._popover.popdown();
        this._startRefreshing();
    }

    sync() {
        if (this._disposed || this._canPreview())
            return;
        this._cancelHide();
        this._popover.popdown();
        this._window?.close();
        this._stopRefreshingIfHidden(true);
        this._texture = null;
        this._popoverPicture.set_paintable(null);
        this._setStatus('Connecting to agent desktop…', 'Connecting…');
    }

    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        this._cancelHide();
        this._popover.popdown();
        this._window?.close();
        this._stopRefreshingIfHidden(true);
        this._anchor.remove_controller(this._anchorMotion);
        this._popover.unparent();
    }
}
