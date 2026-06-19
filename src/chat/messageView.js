import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Pango from 'gi://Pango?version=1.0';

import { markdownToPangoMarkup, parseMarkdownBlocks } from './markdown.js';

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

function copyTextToClipboard(text) {
    const display = Gdk.Display.get_default();
    const clipboard = display?.get_clipboard();

    clipboard?.set(text);
}

function createCodeBlock(block, options) {
    const outer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
    });
    outer.add_css_class('cusco-code-block');

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

    buffer.set_highlight_syntax(Boolean(language));
    buffer.set_text(block.content, -1);

    const view = new GtkSource.View({
        buffer,
        editable: false,
        cursor_visible: false,
        monospace: true,
    });
    view.add_css_class('cusco-code-view');

    const lineCount = Math.max(1, block.content.split('\n').length);
    const scroller = new Gtk.ScrolledWindow({
        child: view,
        hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
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
        else
            container.append(createMarkdownLabel(block.content, options.role));
    }
}

export function createMessageContent(body, options = {}) {
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
    });
    renderMessageContent(container, body, options);
    container.updateContent = (nextBody) => renderMessageContent(container, nextBody, options);
    return container;
}
