import Cairo from 'cairo';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';

import {
    inlineMarkdownToPangoMarkup,
    markdownToPangoMarkup,
    parseMarkdownBlocks,
} from '../../chat/markdown.js';

const INLINE_PREVIEW_HEIGHT = 260;
const SOURCE_LANGUAGE_ALIASES = {
    javascript: 'js',
    typescript: 'js',
    python: 'python3',
    py: 'python3',
    shell: 'sh',
    bash: 'sh',
    yml: 'yaml',
};

function errorView(message) {
    const label = new Gtk.Label({
        label: String(message ?? 'Artifact preview is unavailable.'),
        wrap: true,
        xalign: 0,
        margin_top: 18,
        margin_bottom: 18,
        margin_start: 18,
        margin_end: 18,
    });
    label.add_css_class('dim-label');
    return label;
}

function sourceLanguageId(resolved) {
    const format = String(resolved.artifact.format ?? '').toLowerCase();
    const mimeType = String(resolved.artifact.mimeType ?? '').toLowerCase();

    if (resolved.artifact.kind === 'svg')
        return 'xml';

    if (resolved.artifact.kind === 'html')
        return 'html';

    if (format === 'markdown' || mimeType === 'text/markdown')
        return 'markdown';

    if (format === 'json' || mimeType === 'application/json' || resolved.artifact.kind === 'chart')
        return 'json';

    if (format === 'csv' || mimeType === 'text/csv')
        return 'csv';

    return format === 'text' ? '' : SOURCE_LANGUAGE_ALIASES[format] ?? format;
}

function createSourceView(manager, resolved, options = {}) {
    let source;

    try {
        source = manager.readText(
            resolved.artifact.id,
            resolved.revision.id,
            options.path ?? resolved.revision.manifest.entrypoint,
        );
    } catch (error) {
        logError(error, `Failed to read artifact ${resolved.artifact.id}`);
        return errorView('Artifact source is missing or unreadable.');
    }

    const buffer = new GtkSource.Buffer();
    const languageId = sourceLanguageId(resolved);
    const language = languageId
        ? GtkSource.LanguageManager.get_default().get_language(languageId)
        : null;

    buffer.set_text(source, -1);

    if (language)
        buffer.set_language(language);

    buffer.set_highlight_syntax(Boolean(language));
    const view = new GtkSource.View({
        buffer,
        editable: Boolean(options.editable),
        cursor_visible: Boolean(options.editable),
        monospace: true,
        hexpand: true,
        vexpand: true,
        wrap_mode: resolved.artifact.kind === 'document'
            ? Gtk.WrapMode.WORD_CHAR
            : Gtk.WrapMode.NONE,
    });
    view.add_css_class('cusco-artifact-source-view');
    const scroller = new Gtk.ScrolledWindow({
        child: view,
        hexpand: true,
        vexpand: true,
        min_content_height: options.inline ? 120 : 320,
        max_content_height: options.inline ? INLINE_PREVIEW_HEIGHT : -1,
        propagate_natural_height: Boolean(options.inline),
        hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });

    scroller.artifactSourceBuffer = buffer;
    scroller.artifactSourcePath = options.path ?? resolved.revision.manifest.entrypoint;
    return scroller;
}

export class NativeImageArtifactRenderer {
    supports(resolved) {
        return resolved.artifact.kind === 'image' || resolved.artifact.kind === 'svg';
    }

    _createView(manager, resolved, options = {}) {
        const path = manager.filePath(
            resolved.artifact.id,
            resolved.revision.id,
            resolved.revision.manifest.entrypoint,
        );

        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
            return errorView('Artifact image is missing.');

        const picture = Gtk.Picture.new_for_filename(path);
        picture.set_can_shrink(true);
        picture.set_keep_aspect_ratio(true);
        picture.set_content_fit(Gtk.ContentFit.CONTAIN);
        picture.set_hexpand(true);
        picture.set_vexpand(!options.inline);
        picture.set_size_request(options.inline ? 360 : 480, options.inline ? 240 : 360);
        picture.add_css_class('cusco-artifact-picture');

        if (!options.onOpenImage)
            return picture;

        const button = new Gtk.Button({
            child: picture,
            tooltip_text: 'Open image',
            hexpand: true,
            vexpand: !options.inline,
        });
        button.add_css_class('flat');
        button.add_css_class('cusco-artifact-picture-button');
        button.connect('clicked', () => options.onOpenImage({
            path,
            title: resolved.artifact.title,
            mimeType: resolved.artifact.mimeType,
            sourceKind: 'managed-artifact',
            artifactId: resolved.artifact.id,
            revisionId: resolved.revision.id,
        }));
        return button;
    }

    createInlineView(manager, resolved, options = {}) {
        return this._createView(manager, resolved, { ...options, inline: true });
    }

    createWorkspaceView(manager, resolved, options = {}) {
        return this._createView(manager, resolved, options);
    }
}

export class NativeSourceArtifactRenderer {
    supports(resolved) {
        return ['document', 'code', 'data', 'chart', 'diagram'].includes(resolved.artifact.kind);
    }

    createInlineView(manager, resolved, options = {}) {
        return createSourceView(manager, resolved, { ...options, inline: true });
    }

    createWorkspaceView(manager, resolved, options = {}) {
        return createSourceView(manager, resolved, options);
    }
}

function markdownTableXalign(alignment) {
    if (alignment === 'center')
        return 0.5;

    if (alignment === 'right')
        return 1;

    return 0;
}

function createMarkdownDocumentLabel(content) {
    const label = new Gtk.Label({
        selectable: true,
        wrap: true,
        xalign: 0,
        yalign: 0,
        hexpand: true,
    });
    label.set_use_markup(true);
    label.set_markup(markdownToPangoMarkup(content) || ' ');
    label.add_css_class('cusco-message-markdown');
    return label;
}

function createMarkdownDocumentTableCell(content, options = {}) {
    const columnCount = Math.max(1, options.columnCount ?? 1);
    const label = new Gtk.Label({
        selectable: true,
        wrap: true,
        xalign: markdownTableXalign(options.alignment),
        yalign: 0,
        hexpand: true,
        max_width_chars: Math.max(12, Math.min(36, Math.floor(82 / columnCount) + 8)),
    });
    const markup = inlineMarkdownToPangoMarkup(content) || ' ';

    label.set_use_markup(true);
    label.set_markup(options.header ? `<b>${markup}</b>` : markup);
    label.add_css_class('cusco-table-cell');

    if (options.header)
        label.add_css_class('cusco-table-header-cell');

    return label;
}

function createMarkdownDocumentTable(block) {
    const columnCount = block.headers.length;
    const grid = new Gtk.Grid({
        column_spacing: 0,
        row_spacing: 0,
        hexpand: true,
        accessible_role: Gtk.AccessibleRole.TABLE,
    });
    grid.add_css_class('cusco-markdown-table');

    block.headers.forEach((header, column) => {
        grid.attach(createMarkdownDocumentTableCell(header, {
            alignment: block.alignments[column],
            columnCount,
            header: true,
        }), column, 0, 1, 1);
    });

    block.rows.forEach((row, rowIndex) => {
        row.forEach((cell, column) => {
            grid.attach(createMarkdownDocumentTableCell(cell, {
                alignment: block.alignments[column],
                columnCount,
            }), column, rowIndex + 1, 1, 1);
        });
    });

    return grid;
}

function createMarkdownDocumentDivider() {
    const separator = new Gtk.Separator({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
    });
    separator.add_css_class('cusco-markdown-divider');
    return separator;
}

function createMarkdownDocumentCodeBlock(block) {
    const label = new Gtk.Label({
        label: block.content || ' ',
        selectable: true,
        wrap: false,
        xalign: 0,
        yalign: 0,
        hexpand: true,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 8,
        margin_end: 8,
    });
    label.add_css_class('monospace');
    label.add_css_class('cusco-code-block');
    return label;
}

function createMarkdownDocumentContent(source) {
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: true,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });

    for (const block of parseMarkdownBlocks(source)) {
        if (block.type === 'table')
            content.append(createMarkdownDocumentTable(block));
        else if (block.type === 'divider')
            content.append(createMarkdownDocumentDivider());
        else if (block.type === 'code')
            content.append(createMarkdownDocumentCodeBlock(block));
        else
            content.append(createMarkdownDocumentLabel(block.content));
    }

    return content;
}

export class NativeDocumentArtifactRenderer {
    supports(resolved) {
        return resolved.artifact.kind === 'document'
            && resolved.artifact.format === 'markdown';
    }

    _createView(manager, resolved, options = {}) {
        let source;

        try {
            source = manager.readText(
                resolved.artifact.id,
                resolved.revision.id,
                resolved.revision.manifest.entrypoint,
            );
        } catch (error) {
            logError(error, 'Failed to read document artifact');
            return errorView('Document artifact is unreadable.');
        }

        const scroller = new Gtk.ScrolledWindow({
            child: createMarkdownDocumentContent(source),
            hexpand: true,
            vexpand: !options.inline,
            min_content_height: options.inline ? 100 : 320,
            max_content_height: options.inline ? INLINE_PREVIEW_HEIGHT : -1,
            propagate_natural_height: Boolean(options.inline),
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        return scroller;
    }

    createInlineView(manager, resolved) {
        return this._createView(manager, resolved, { inline: true });
    }

    createWorkspaceView(manager, resolved) {
        return this._createView(manager, resolved);
    }
}

function parseCsvRows(source) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < source.length; index++) {
        const character = source[index];

        if (character === '"') {
            if (quoted && source[index + 1] === '"') {
                cell += '"';
                index++;
            } else {
                quoted = !quoted;
            }
        } else if (character === ',' && !quoted) {
            row.push(cell);
            cell = '';
        } else if ((character === '\n' || character === '\r') && !quoted) {
            if (character === '\r' && source[index + 1] === '\n')
                index++;

            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += character;
        }
    }

    if (cell || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }

    return rows;
}

function tabularData(source, format) {
    if (format === 'csv') {
        const rows = parseCsvRows(source);
        return {
            columns: rows[0] ?? [],
            rows: rows.slice(1),
        };
    }

    const value = JSON.parse(source);
    const records = Array.isArray(value) ? value : [value];

    if (records.every((record) => record && typeof record === 'object' && !Array.isArray(record))) {
        const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
        return {
            columns,
            rows: records.map((record) => columns.map((column) => record[column])),
        };
    }

    if (records.every(Array.isArray)) {
        const width = Math.max(0, ...records.map((record) => record.length));
        return {
            columns: Array.from({ length: width }, (_unused, index) => `Column ${index + 1}`),
            rows: records,
        };
    }

    return {
        columns: ['Value'],
        rows: records.map((record) => [record]),
    };
}

function tableCell(value, header = false) {
    const serialized = value && typeof value === 'object'
        ? JSON.stringify(value)
        : String(value ?? '');
    const label = new Gtk.Label({
        label: serialized.length > 240 ? `${serialized.slice(0, 239)}…` : serialized,
        xalign: 0,
        yalign: 0,
        selectable: true,
        wrap: true,
        margin_top: 5,
        margin_bottom: 5,
        margin_start: 7,
        margin_end: 7,
    });
    label.add_css_class('cusco-table-cell');

    if (header)
        label.add_css_class('heading');

    return label;
}

export class NativeDataArtifactRenderer {
    supports(resolved) {
        return resolved.artifact.kind === 'data';
    }

    _createView(manager, resolved, options = {}) {
        let data;

        try {
            data = tabularData(
                manager.readText(
                    resolved.artifact.id,
                    resolved.revision.id,
                    resolved.revision.manifest.entrypoint,
                ),
                resolved.artifact.format,
            );
        } catch (error) {
            logError(error, 'Failed to parse data artifact');
            return errorView('Data artifact is not valid JSON or CSV.');
        }

        const grid = new Gtk.Grid({
            column_homogeneous: false,
            row_homogeneous: false,
            hexpand: true,
            accessible_role: Gtk.AccessibleRole.TABLE,
        });
        grid.add_css_class('cusco-markdown-table');
        data.columns.slice(0, 20).forEach((column, index) => {
            grid.attach(tableCell(column, true), index, 0, 1, 1);
        });
        data.rows.slice(0, options.inline ? 12 : 200).forEach((row, rowIndex) => {
            data.columns.slice(0, 20).forEach((_column, columnIndex) => {
                grid.attach(tableCell(row[columnIndex]), columnIndex, rowIndex + 1, 1, 1);
            });
        });
        const scroller = new Gtk.ScrolledWindow({
            child: grid,
            hexpand: true,
            vexpand: !options.inline,
            min_content_height: options.inline ? 120 : 320,
            max_content_height: options.inline ? INLINE_PREVIEW_HEIGHT : -1,
            propagate_natural_height: Boolean(options.inline),
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        return scroller;
    }

    createInlineView(manager, resolved) {
        return this._createView(manager, resolved, { inline: true });
    }

    createWorkspaceView(manager, resolved) {
        return this._createView(manager, resolved);
    }
}

function normalizeChartSpec(value) {
    const source = value && typeof value === 'object' ? value : {};
    const simpleData = Array.isArray(source.data) ? source.data : [];
    const labels = Array.isArray(source.labels)
        ? source.labels.map((label) => String(label))
        : simpleData.map((item) => String(item?.label ?? ''));
    const series = Array.isArray(source.series) && source.series.length > 0
        ? source.series.map((item, index) => ({
            name: String(item?.name ?? `Series ${index + 1}`),
            values: Array.isArray(item?.values)
                ? item.values.map((number) => Number(number) || 0)
                : [],
            color: String(item?.color ?? ''),
        }))
        : [{
            name: String(source.seriesName ?? source.title ?? 'Value'),
            values: simpleData.map((item) => Number(item?.value) || 0),
            color: String(source.color ?? ''),
        }];

    return {
        type: source.type === 'line' ? 'line' : 'bar',
        title: String(source.title ?? ''),
        labels,
        series: series.filter((item) => item.values.length > 0),
    };
}

function setChartColor(cr, series, index) {
    if (series.color) {
        const match = /^#([0-9a-f]{6})$/i.exec(series.color);

        if (match) {
            const value = Number.parseInt(match[1], 16);
            cr.setSourceRGB(
                ((value >> 16) & 255) / 255,
                ((value >> 8) & 255) / 255,
                (value & 255) / 255,
            );
            return;
        }
    }

    const palette = [
        [0.21, 0.52, 0.89],
        [0.20, 0.70, 0.39],
        [0.91, 0.33, 0.38],
        [0.56, 0.35, 0.76],
        [0.96, 0.65, 0.14],
    ];
    cr.setSourceRGB(...palette[index % palette.length]);
}

function drawChart(area, cr, width, height, spec) {
    const left = 46;
    const right = 16;
    const top = 18;
    const bottom = 38;
    const plotWidth = Math.max(1, width - left - right);
    const plotHeight = Math.max(1, height - top - bottom);
    const values = spec.series.flatMap((series) => series.values);

    if (values.length === 0 || spec.labels.length === 0)
        return;

    const minimum = Math.min(0, ...values);
    const maximum = Math.max(0, ...values);
    const range = maximum - minimum || 1;
    const valueY = (value) => top + ((maximum - value) / range) * plotHeight;
    const baselineY = valueY(0);
    const foreground = area.get_style_context().get_color();

    cr.setSourceRGBA(foreground.red, foreground.green, foreground.blue, 0.28);
    cr.setLineWidth(1);
    cr.moveTo(left, top);
    cr.lineTo(left, top + plotHeight);
    cr.lineTo(left + plotWidth, top + plotHeight);
    cr.stroke();
    cr.moveTo(left, baselineY);
    cr.lineTo(left + plotWidth, baselineY);
    cr.stroke();

    const groupWidth = plotWidth / Math.max(1, spec.labels.length);

    if (spec.type === 'bar') {
        const barWidth = Math.max(2, (groupWidth * 0.72) / Math.max(1, spec.series.length));

        spec.series.forEach((series, seriesIndex) => {
            setChartColor(cr, series, seriesIndex);
            series.values.slice(0, spec.labels.length).forEach((value, index) => {
                const x = left + index * groupWidth + (groupWidth - barWidth * spec.series.length) / 2
                    + seriesIndex * barWidth;
                const y = valueY(value);
                cr.rectangle(x, Math.min(y, baselineY), Math.max(1, barWidth - 2), Math.abs(baselineY - y));
                cr.fill();
            });
        });
    } else {
        spec.series.forEach((series, seriesIndex) => {
            setChartColor(cr, series, seriesIndex);
            cr.setLineWidth(2);
            series.values.slice(0, spec.labels.length).forEach((value, index) => {
                const x = left + groupWidth * (index + 0.5);
                const y = valueY(value);

                if (index === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            });
            cr.stroke();
        });
    }

    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
    cr.setFontSize(10);
    cr.setSourceRGBA(foreground.red, foreground.green, foreground.blue, 0.72);
    const labelStep = Math.max(1, Math.ceil(spec.labels.length / 10));

    spec.labels.forEach((label, index) => {
        if (index % labelStep !== 0)
            return;

        const text = label.length > 10 ? `${label.slice(0, 9)}…` : label;
        const extents = cr.textExtents(text);
        const x = left + groupWidth * (index + 0.5) - extents.width / 2;
        cr.moveTo(Math.max(left, x), height - 14);
        cr.showText(text);
    });
}

export class NativeChartArtifactRenderer {
    supports(resolved) {
        return resolved.artifact.kind === 'chart';
    }

    _createView(manager, resolved, options = {}) {
        let spec;

        try {
            spec = normalizeChartSpec(JSON.parse(manager.readText(
                resolved.artifact.id,
                resolved.revision.id,
                resolved.revision.manifest.entrypoint,
            )));
        } catch (error) {
            if (!(error instanceof SyntaxError))
                logError(error, 'Failed to parse chart artifact');
            return errorView('Chart specification is invalid.');
        }

        if (spec.labels.length === 0 || spec.series.length === 0)
            return errorView('Chart specification has no data.');

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
            vexpand: !options.inline,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });

        if (spec.title) {
            const title = new Gtk.Label({
                label: spec.title,
                xalign: 0,
            });
            title.add_css_class('heading');
            box.append(title);
        }

        const drawing = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: !options.inline,
            accessible_role: Gtk.AccessibleRole.IMG,
            content_width: options.inline ? 360 : 620,
            content_height: options.inline ? 220 : 420,
            tooltip_text: `${spec.title || resolved.artifact.title}: ${spec.labels.join(', ')}`,
        });
        drawing.set_draw_func((area, cr, width, height) => drawChart(area, cr, width, height, spec));
        box.append(drawing);
        return box;
    }

    createInlineView(manager, resolved) {
        return this._createView(manager, resolved, { inline: true });
    }

    createWorkspaceView(manager, resolved) {
        return this._createView(manager, resolved);
    }
}

export class NativePdfArtifactRenderer {
    supports(resolved) {
        return resolved.artifact.kind === 'pdf';
    }

    createInlineView(_manager, _resolved, options = {}) {
        const button = new Gtk.Button({
            label: 'Open PDF in the artifact workspace',
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        button.connect('clicked', () => options.onOpenArtifact?.());
        return button;
    }

    createWorkspaceView(manager, resolved, options = {}) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
        });
        const icon = new Gtk.Image({
            icon_name: 'application-pdf-symbolic',
            pixel_size: 64,
        });
        const label = new Gtk.Label({
            label: 'PDF preview is handled by your desktop document viewer.',
            wrap: true,
        });
        const openButton = new Gtk.Button({ label: 'Open PDF' });
        openButton.connect('clicked', () => options.onOpenExternal?.(
            manager.filePath(resolved.artifact.id, resolved.revision.id),
        ));
        box.append(icon);
        box.append(label);
        box.append(openButton);
        return box;
    }
}

export class FallbackArtifactRenderer {
    supports() {
        return true;
    }

    createInlineView(_manager, resolved, options = {}) {
        const button = new Gtk.Button({
            label: `Open ${resolved.artifact.format || resolved.artifact.mimeType} artifact`,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        button.connect('clicked', () => options.onOpenArtifact?.());
        return button;
    }

    createWorkspaceView(manager, resolved, options = {}) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            vexpand: true,
        });
        const label = errorView(`No built-in preview is available for ${resolved.artifact.mimeType}.`);
        const openButton = new Gtk.Button({ label: 'Open with another application' });
        openButton.connect('clicked', () => options.onOpenExternal?.(
            manager.filePath(resolved.artifact.id, resolved.revision.id),
        ));
        box.append(label);
        box.append(openButton);
        return box;
    }
}

export function createEditableArtifactSourceView(manager, resolved, path = '') {
    return createSourceView(manager, resolved, {
        editable: true,
        path: path || resolved.revision.manifest.entrypoint,
    });
}
