import Gtk from 'gi://Gtk?version=4.0';
import { importPackageModule } from '../packageLoader.js';
import { inlineMarkdownToPangoRenderModel } from './markdown.js';

export const { MathLabel } = await importPackageModule('nativeMath/label.js');

export function createMathBlock(content, options = {}) {
    const label = new MathLabel({
        selectable: options.selectable !== false,
        xalign: 0.5,
        hexpand: true,
        margin_top: 8,
        margin_bottom: 8,
    });
    label.add_css_class('cusco-message-markdown');
    label.setMathModel(inlineMarkdownToPangoRenderModel(content));
    const scroller = new Gtk.ScrolledWindow({
        child: label,
        hexpand: true,
        hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_height: true,
    });
    scroller.set_selectable = (value) => label.set_selectable(value);
    return scroller;
}
