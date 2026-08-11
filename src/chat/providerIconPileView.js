import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    arrangeProviderIconBodies,
    createProviderIconBodies,
    providerIdsForUsageBreakdown,
    stepProviderIconBodies,
} from './providerIconPile.js';
import { getProviderIconPath } from '../providers/icons.js';

const ICON_TEXTURE_SIZE = 64;
const MAX_ANIMATION_SECONDS = 8;

export function createProviderIconPileView(providerConfigStore) {
    const iconCache = new Map();
    const activePixbufs = new Map();
    let bodies = [];
    let tickId = 0;

    const layer = new Gtk.DrawingArea({
        hexpand: true,
        vexpand: true,
        can_target: false,
    });

    const stop = () => {
        if (!tickId)
            return;

        layer.remove_tick_callback(tickId);
        tickId = 0;
    };

    const pixbufForProvider = (providerId) => {
        const provider = providerConfigStore.getProvider(providerId);
        const iconPath = getProviderIconPath(provider ?? providerId);

        if (!iconPath)
            return null;
        if (iconCache.has(iconPath))
            return iconCache.get(iconPath);

        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                iconPath,
                ICON_TEXTURE_SIZE,
                ICON_TEXTURE_SIZE,
                true,
            );
            iconCache.set(iconPath, pixbuf);
            return pixbuf;
        } catch (error) {
            iconCache.set(iconPath, null);
            logError(error, `Failed to load usage icon for ${providerId}`);
            return null;
        }
    };

    layer.set_draw_func((_widget, cr) => {
        for (const body of bodies) {
            const pixbuf = activePixbufs.get(body.providerId);

            if (!pixbuf)
                continue;

            const scale = body.size / Math.max(1, pixbuf.get_width());
            cr.save();
            cr.translate(body.x + body.size / 2, body.y + body.size / 2);
            cr.rotate(body.angle);
            cr.translate(-body.size / 2, -body.size / 2);
            cr.scale(scale, scale);
            Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
            cr.paint();
            cr.restore();
        }
    });

    layer.connect('resize', (widget, width, height) => {
        if (tickId || bodies.length === 0 || width < 1 || height < 1)
            return;

        arrangeProviderIconBodies(bodies, width, height);
        widget.queue_draw();
    });

    const setBreakdown = (breakdown) => {
        stop();
        bodies = [];
        activePixbufs.clear();

        for (const providerId of providerIdsForUsageBreakdown(breakdown)) {
            const pixbuf = pixbufForProvider(providerId);

            if (pixbuf)
                activePixbufs.set(providerId, pixbuf);
        }

        layer.queue_draw();
        if (activePixbufs.size === 0)
            return;

        let lastFrameTime = 0;
        let animationElapsed = 0;
        tickId = layer.add_tick_callback((widget, frameClock) => {
            const width = widget.get_width();
            const height = widget.get_height();

            if (width < 1 || height < 1)
                return GLib.SOURCE_CONTINUE;

            if (bodies.length === 0) {
                bodies = createProviderIconBodies(
                    [...activePixbufs.keys()],
                    width,
                );
            }

            if (!Adw.get_enable_animations(widget)) {
                arrangeProviderIconBodies(bodies, width, height);
                widget.queue_draw();
                tickId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const frameTime = frameClock.get_frame_time();
            const elapsedSeconds = lastFrameTime === 0
                ? 1 / 60
                : (frameTime - lastFrameTime) / 1000000;
            lastFrameTime = frameTime;
            animationElapsed += elapsedSeconds;
            const moving = stepProviderIconBodies(
                bodies,
                width,
                height,
                elapsedSeconds,
            );
            widget.queue_draw();

            if (moving && animationElapsed < MAX_ANIMATION_SECONDS)
                return GLib.SOURCE_CONTINUE;

            if (moving)
                arrangeProviderIconBodies(bodies, width, height);
            else {
                for (const body of bodies) {
                    body.vx = 0;
                    body.vy = 0;
                    body.angularVelocity = 0;
                }
            }

            widget.queue_draw();
            tickId = 0;
            return GLib.SOURCE_REMOVE;
        });
    };

    return { widget: layer, setBreakdown, stop };
}
