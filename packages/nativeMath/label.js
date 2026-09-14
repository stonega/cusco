import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Graphene from 'gi://Graphene?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import PangoCairo from 'gi://PangoCairo?version=1.0';

import { renderMath } from './render.js';

const encoder = new TextEncoder();
const textures = new Map();
let cachedPixels = 0;
const MAX_CACHED_PIXELS = 4_000_000;

function insertAttribute(attributes, attribute, start, end) {
    attribute.start_index = start;
    attribute.end_index = end;
    attributes.insert(attribute);
}

function rectangle(x = 0, y = 0, width = 0, height = 0) {
    return new Pango.Rectangle({
        x: Math.round(x * Pango.SCALE), y: Math.round(y * Pango.SCALE),
        width: Math.round(width * Pango.SCALE), height: Math.round(height * Pango.SCALE),
    });
}

function mathTexture(math, width, height, color, scale) {
    const key = `${math.svg}\0${width}\0${height}\0${color}\0${scale}`;
    if (textures.has(key))
        return textures.get(key).texture;

    const svg = math.svg.replace(/currentColor/g, color);
    const loader = GdkPixbuf.PixbufLoader.new_with_type('svg');
    loader.set_size(Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)));
    loader.write(encoder.encode(svg));
    loader.close();
    const texture = Gdk.Texture.new_for_pixbuf(loader.get_pixbuf());
    const pixels = texture.get_width() * texture.get_height();
    while (textures.size && (textures.size >= 128 || cachedPixels + pixels > MAX_CACHED_PIXELS)) {
        const oldest = textures.keys().next().value;
        cachedPixels -= textures.get(oldest).pixels;
        textures.delete(oldest);
    }
    if (pixels <= MAX_CACHED_PIXELS) {
        textures.set(key, { texture, pixels });
        cachedPixels += pixels;
    }
    return texture;
}

function mathFontSize(label, index) {
    const context = label.get_pango_context();
    const font = context.get_font_description().copy();
    const iterator = label.get_layout().get_attributes()?.get_iterator();
    if (iterator) {
        while (iterator.range()[1] <= index && iterator.next()) {
            // Include heading sizes and other surrounding font attributes.
        }
        iterator.get_font(font);
    }
    const dpi = PangoCairo.context_get_resolution(context);
    return font.get_size() / Pango.SCALE
        * (font.get_size_is_absolute() ? 1 : (dpi > 0 ? dpi : 96) / 72);
}

// Keep the original TeX in the label for selection, clipboard and accessibility.
// Empty Pango shapes hide its glyphs; the first character reserves the SVG's space.
export const MathLabel = GObject.registerClass(
class MathLabel extends Gtk.Label {
    _init(properties = {}) {
        super._init(properties);
        this._mathSpans = [];
        this._referenceAttributes = null;
    }

    setMathModel(model) {
        this.set_markup(model?.markup || ' ');
        this._mathSpans = (model?.mathRanges ?? []).flatMap((range) => {
            const math = renderMath(range.tex, range.display);
            return math ? [{ ...range, math }] : [];
        });
        this._updateMathAttributes();
    }

    setReferenceAttributes(attributes) {
        this._referenceAttributes = attributes;
        this._updateMathAttributes();
    }

    _updateMathAttributes() {
        const attributes = this._referenceAttributes?.copy() ?? new Pango.AttrList();
        const renderedSpans = [];
        for (const span of this._mathSpans) {
            const em = mathFontSize(this, span.start);
            const [, , svgWidth, svgHeight] = span.math.viewBox;
            const scale = Math.min(em / 1000, 1600 / svgWidth, 600 / svgHeight);
            span.width = svgWidth * scale;
            span.height = svgHeight * scale;
            span.ascent = span.height * (1 - span.math.depthRatio);
            try {
                // Confirm rasterization before hiding the readable source glyphs.
                mathTexture(span.math, span.width, span.height,
                    this.get_color().to_string(), this.get_scale_factor());
            } catch (_error) {
                continue;
            }
            const logical = rectangle(0, -span.ascent, span.width + 2, span.height);
            insertAttribute(attributes, Pango.attr_shape_new(rectangle(), logical), span.start, span.start + 1);
            insertAttribute(attributes, Pango.attr_shape_new(rectangle(), rectangle()), span.start + 1, span.end);
            insertAttribute(attributes, Pango.attr_allow_breaks_new(false), span.start, span.end);
            renderedSpans.push(span);
        }
        this._mathSpans = renderedSpans;
        this.set_attributes(attributes);
    }

    vfunc_css_changed(change) {
        super.vfunc_css_changed(change);
        if (this._mathSpans?.length)
            this._updateMathAttributes();
    }

    snapshotMath(snapshot) {
        if (!this._mathSpans?.length)
            return;

        const layout = this.get_layout();
        const [offsetX, offsetY] = this.get_layout_offsets();
        const iterator = layout.get_iter();
        const baselines = [];
        do {
            const line = iterator.get_line_readonly();
            baselines.push({ start: line.start_index, baseline: iterator.get_baseline() / Pango.SCALE });
        } while (iterator.next_line());

        for (const span of this._mathSpans) {
            const position = layout.index_to_pos(span.start);
            const line = baselines.findLast((entry) => entry.start <= span.start);
            if (!line)
                continue;
            const bounds = new Graphene.Rect();
            bounds.init(offsetX + position.x / Pango.SCALE + 1,
                offsetY + line.baseline - span.ascent, span.width, span.height);
            const texture = mathTexture(span.math, span.width, span.height,
                this.get_color().to_string(), this.get_scale_factor());
            snapshot.append_texture(texture, bounds);
        }
    }

    vfunc_snapshot(snapshot) {
        super.vfunc_snapshot(snapshot);
        this.snapshotMath(snapshot);
    }
});
