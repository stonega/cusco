import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Pango from 'gi://Pango?version=1.0';

import {
    inlineMarkdownToPangoMarkup,
    markdownToPangoMarkup,
    parseMarkdownBlocks,
} from './markdown.js';
import {
    getCodeThemeStyleScheme,
    getCodeThemeVariant,
} from './codeThemes.js';

const LANGUAGE_ALIASES = {
    bash: 'sh',
    shell: 'sh',
    javascript: 'js',
    typescript: 'js',
    py: 'python3',
    python: 'python3',
    rb: 'ruby',
    rs: 'rust',
    yml: 'yaml',
};
const DEFAULT_CODE_MIN_WIDTH = 360;

function tableAlignmentXalign(alignment) {
    if (alignment === 'right')
        return 1;

    if (alignment === 'center')
        return 0.5;

    return 0;
}

function clearBox(box) {
    let child = box.get_first_child();

    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}

function getLanguage(languageId) {
    if (!languageId)
        return null;

    const normalizedLanguageId = LANGUAGE_ALIASES[languageId.toLowerCase()] ?? languageId.toLowerCase();
    return GtkSource.LanguageManager.get_default().get_language(normalizedLanguageId);
}

function createMarkdownLabel(content, role) {
    const label = new Gtk.Label({
        wrap: true,
        selectable: true,
        xalign: 0,
        max_width_chars: role === 'user' ? 36 : 82,
    });
    label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    label.set_use_markup(true);
    label.set_markup(markdownToPangoMarkup(content) || ' ');
    label.add_css_class('cusco-message-markdown');

    return label;
}

function createTableCell(content, options = {}) {
    const columnCount = Math.max(1, options.columnCount ?? 1);
    const maxWidthChars = options.role === 'user'
        ? Math.max(14, Math.floor(36 / columnCount))
        : Math.max(16, Math.min(36, Math.floor(82 / columnCount) + 8));
    const label = new Gtk.Label({
        wrap: true,
        selectable: true,
        xalign: tableAlignmentXalign(options.alignment),
        max_width_chars: maxWidthChars,
        hexpand: true,
    });
    const markup = inlineMarkdownToPangoMarkup(content) || ' ';

    label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
    label.set_use_markup(true);
    label.set_markup(options.header ? `<b>${markup}</b>` : markup);
    label.add_css_class('cusco-table-cell');

    if (options.header)
        label.add_css_class('cusco-table-header-cell');

    return label;
}

function createMarkdownTable(block, options = {}) {
    const columnCount = block.headers.length;
    const grid = new Gtk.Grid({
        column_spacing: 0,
        row_spacing: 0,
        hexpand: true,
    });
    grid.add_css_class('cusco-markdown-table');

    block.headers.forEach((header, column) => {
        grid.attach(createTableCell(header, {
            alignment: block.alignments[column],
            columnCount,
            header: true,
            role: options.role,
        }), column, 0, 1, 1);
    });

    block.rows.forEach((row, rowIndex) => {
        row.forEach((cell, column) => {
            grid.attach(createTableCell(cell, {
                alignment: block.alignments[column],
                columnCount,
                role: options.role,
            }), column, rowIndex + 1, 1, 1);
        });
    });

    return grid;
}

function createMarkdownDivider() {
    const separator = new Gtk.Separator({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
    });
    separator.add_css_class('cusco-markdown-divider');
    return separator;
}

export function copyTextToClipboard(text) {
    const display = Gdk.Display.get_default();
    const clipboard = display?.get_clipboard();

    clipboard?.set(text);
}

function createCodeBlock(block, options) {
    const outer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        hexpand: true,
    });
    outer.add_css_class('cusco-code-block');
    outer.add_css_class(`cusco-code-block-${getCodeThemeVariant(options.codeTheme)}`);

    const header = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 8,
        margin_end: 8,
    });
    header.add_css_class('cusco-code-header');

    const languageLabel = new Gtk.Label({
        label: block.language || 'code',
        xalign: 0,
        hexpand: true,
    });
    languageLabel.add_css_class('caption');
    languageLabel.add_css_class('dim-label');

    const copyButton = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        tooltip_text: 'Copy code',
        valign: Gtk.Align.CENTER,
    });
    copyButton.add_css_class('flat');
    copyButton.connect('clicked', () => {
        copyTextToClipboard(block.content);
        options.onCopyCode?.();
    });

    header.append(languageLabel);
    header.append(copyButton);
    outer.append(header);

    const buffer = new GtkSource.Buffer();
    const language = getLanguage(block.language);

    if (language)
        buffer.set_language(language);

    const styleScheme = getCodeThemeStyleScheme(options.codeTheme);

    if (styleScheme)
        buffer.set_style_scheme(styleScheme);

    buffer.set_highlight_syntax(Boolean(language));
    buffer.set_text(block.content, -1);

    const view = new GtkSource.View({
        buffer,
        editable: false,
        cursor_visible: false,
        monospace: true,
        hexpand: true,
    });
    view.add_css_class('cusco-code-view');

    const lineCount = Math.max(1, block.content.split('\n').length);
    const scroller = new Gtk.ScrolledWindow({
        child: view,
        hexpand: true,
        hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        min_content_width: options.codeMinWidth ?? DEFAULT_CODE_MIN_WIDTH,
        min_content_height: Math.min(220, Math.max(72, lineCount * 22)),
        max_content_height: 280,
        propagate_natural_height: true,
    });
    outer.append(scroller);

    return outer;
}

export function renderMessageContent(container, body, options = {}) {
    clearBox(container);

    for (const block of parseMarkdownBlocks(body)) {
        if (block.type === 'code')
            container.append(createCodeBlock(block, options));
        else if (block.type === 'divider')
            container.append(createMarkdownDivider());
        else if (block.type === 'table')
            container.append(createMarkdownTable(block, options));
        else
            container.append(createMarkdownLabel(block.content, options.role));
    }
}

export function createMessageContent(body, options = {}) {
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: Boolean(options.hexpand),
    });
    renderMessageContent(container, body, options);
    container.updateContent = (nextBody) => renderMessageContent(container, nextBody, options);
    return container;
}
