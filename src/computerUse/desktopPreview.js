import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Graphene from 'gi://Graphene?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';

const REFRESH_MS = 1_000;
const CONTROL_REFRESH_MS = 150;
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
        this._controlling = false;
        this._takingOver = false;
        this._inputQueue = Promise.resolve();
        this._releasePromise = Promise.resolve();
        this._inputGeneration = 0;
        this._pressedKeys = new Map();
        this._pressedButtons = new Set();
        this._motionSourceId = 0;
        this._pendingMotion = null;
        this._lastPointerPoint = null;

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
        this._takeOverButton = new Gtk.Button({ label: 'Take over' });
        this._takeOverButton.add_css_class('flat');
        this._takeOverButton.connect('clicked', () => void this.takeOver());
        const footer = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        footer.append(this._popoverStatus);
        footer.append(this._takeOverButton);
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
        this._refreshSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._controlling ? CONTROL_REFRESH_MS : REFRESH_MS, () => {
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
                `${this._controlling ? 'You control this desktop' : 'Live agent desktop'} · ${frame.width} × ${frame.height}`,
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
        picture.set_focusable(true);
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
        this._windowControlButton = new Gtk.Button({ label: 'Take over' });
        this._windowControlButton.connect('clicked', () => {
            if (this._controlling)
                void this._stopControlling();
            else
                void this.takeOver();
        });
        const footer = new Gtk.Box({ spacing: 8 });
        status.set_hexpand(true);
        footer.append(status);
        footer.append(this._windowControlButton);
        content.append(footer);

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
        const input = new Gtk.EventControllerLegacy({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
        input.connect('event', (_controller, event) => this._handleDesktopEvent(picture, event));
        picture.add_controller(input);
        const focus = new Gtk.EventControllerFocus();
        focus.connect('leave', () => this._releaseHeldInput());
        picture.add_controller(focus);
        window.connect('notify::is-active', () => {
            if (!window.is_active)
                this._releaseHeldInput();
        });
        window.connect('close-request', () => {
            void this._stopControlling();
            this._window = null;
            this._windowPicture = null;
            this._windowStatus = null;
            this._windowControlButton = null;
            this._stopRefreshingIfHidden();
            return false;
        });
        window.present();
        this._popover.popdown();
        this._startRefreshing();
    }

    async takeOver() {
        if (this._disposed || !this._canPreview() || this._takingOver)
            return;
        this.openWindow();
        if (this._controlling) {
            this._windowPicture.grab_focus();
            return;
        }
        this._takingOver = true;
        this._takeOverButton.set_sensitive(false);
        this._windowControlButton?.set_sensitive(false);
        try {
            await this._releasePromise;
            if (this._disposed || !this._window || !this._canPreview())
                return;
            await this._manager.takeOverBackgroundDesktop();
            if (this._disposed || !this._window || !this._canPreview()) {
                await this._manager.releaseBackgroundDesktopControl();
                return;
            }
            this._controlling = true;
            this._windowControlButton.set_label('Stop controlling');
            this._window.set_title('Agent desktop — You are in control');
            this._windowPicture.grab_focus();
            this._setStatus('You control this desktop · Click, drag, scroll, or type');
            this._restartRefreshing();
        } catch (error) {
            this._setStatus(`Cannot take over: ${error.message ?? error}`, 'Take over unavailable');
        } finally {
            this._takingOver = false;
            this._takeOverButton.set_sensitive(true);
            this._windowControlButton?.set_sensitive(true);
        }
    }

    _restartRefreshing() {
        if (this._refreshSourceId)
            GLib.Source.remove(this._refreshSourceId);
        this._refreshSourceId = 0;
        if (!this._disposed && this._isVisible())
            this._startRefreshing();
    }

    _queueInput(event) {
        const generation = this._inputGeneration;
        this._inputQueue = this._inputQueue.then(async () => {
            if (!this._controlling || generation !== this._inputGeneration)
                return;
            await this._manager.sendBackgroundDesktopInput(event);
        }).catch(error => {
            if (this._controlling)
                this._setStatus(`Input unavailable: ${error.message ?? error}`);
        });
    }

    _flushMotion() {
        if (this._motionSourceId)
            GLib.Source.remove(this._motionSourceId);
        this._motionSourceId = 0;
        if (this._pendingMotion)
            this._queueInput(this._pendingMotion);
        this._pendingMotion = null;
    }

    _releaseHeldInput() {
        if (!this._controlling)
            return;
        this._flushMotion();
        this._inputGeneration++;
        this._pressedKeys.clear();
        this._pressedButtons.clear();
        this._lastPointerPoint = null;
        this._queueInput({ type: 'release_all' });
    }

    _stopControlling() {
        if (!this._controlling)
            return this._releasePromise;
        this._releaseHeldInput();
        this._controlling = false;
        this._windowControlButton?.set_label('Take over');
        this._window?.set_title('Agent desktop');
        this._setStatus('Live agent desktop');
        this._releasePromise = this._inputQueue.then(() => this._manager.releaseBackgroundDesktopControl())
            .catch(error => {
                if (!this._disposed)
                    this._setStatus(`Could not release desktop input: ${error.message ?? error}`);
            });
        this._restartRefreshing();
        return this._releasePromise;
    }

    _handleDesktopEvent(picture, event) {
        if (!this._controlling || !this._texture || !this._canPreview())
            return false;
        const type = event.get_event_type();
        if (type === Gdk.EventType.KEY_PRESS || type === Gdk.EventType.KEY_RELEASE) {
            const pressed = type === Gdk.EventType.KEY_PRESS;
            const code = event.get_keycode();
            const keyval = this._pressedKeys.get(code) ?? event.get_keyval();
            if (!pressed && !this._pressedKeys.has(code))
                return true;
            if (pressed)
                this._pressedKeys.set(code, keyval);
            else
                this._pressedKeys.delete(code);
            this._flushMotion();
            this._queueInput({ type: 'key', keyval, pressed });
            return true;
        }
        if (![Gdk.EventType.MOTION_NOTIFY, Gdk.EventType.BUTTON_PRESS,
            Gdk.EventType.BUTTON_RELEASE, Gdk.EventType.SCROLL].includes(type))
            return false;
        const [positioned, surfaceX, surfaceY] = event.get_position();
        let point = type === Gdk.EventType.SCROLL ? this._lastPointerPoint : null;
        if (positioned) {
            const [translated, origin] = picture.compute_point(picture.get_native(), new Graphene.Point());
            if (!translated)
                return false;
            const width = this._texture.get_width();
            const height = this._texture.get_height();
            const scale = Math.min(picture.get_width() / width, picture.get_height() / height);
            if (scale <= 0)
                return false;
            const x = (surfaceX - origin.x - (picture.get_width() - width * scale) / 2) / scale;
            const y = (surfaceY - origin.y - (picture.get_height() - height * scale) / 2) / scale;
            if ((x < 0 || y < 0 || x >= width || y >= height) && this._pressedButtons.size === 0)
                return false;
            point = { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)) };
            this._lastPointerPoint = point;
        }
        if (!point)
            return false;
        if (type === Gdk.EventType.MOTION_NOTIFY) {
            this._pendingMotion = { type: 'motion', ...point };
            if (!this._motionSourceId) {
                this._motionSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 24, () => {
                    this._motionSourceId = 0;
                    this._flushMotion();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            this._flushMotion();
            if (type === Gdk.EventType.SCROLL) {
                let [deltaX, deltaY] = event.get_deltas();
                const direction = event.get_direction();
                if (direction === Gdk.ScrollDirection.UP) deltaY = -1;
                if (direction === Gdk.ScrollDirection.DOWN) deltaY = 1;
                if (direction === Gdk.ScrollDirection.LEFT) deltaX = -1;
                if (direction === Gdk.ScrollDirection.RIGHT) deltaX = 1;
                const unitScale = event.get_unit?.() === Gdk.ScrollUnit.SURFACE ? 1 : 15;
                this._queueInput({ type: 'scroll', ...point, deltaX: deltaX * unitScale, deltaY: deltaY * unitScale });
            } else {
                const button = event.get_button();
                if (![1, 2, 3].includes(button))
                    return false;
                const pressed = type === Gdk.EventType.BUTTON_PRESS;
                if (pressed) {
                    picture.grab_focus();
                    this._pressedButtons.add(button);
                } else {
                    this._pressedButtons.delete(button);
                }
                this._queueInput({ type: 'button', ...point, button, pressed });
            }
        }
        return true;
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
