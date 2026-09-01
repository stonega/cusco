import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { createBundledIcon } from '../bundledIcons.js';
import {
    extractPromptVariables,
    formatPromptVariables,
    renderPromptTemplate,
} from '../workspace/promptVariables.js';

const PROMPT_ICON_FILE = 'prompt-symbolic.svg';
const MORE_VERTICAL_ICON_FILE = 'more-vertical-symbolic.svg';

function createLabeledControlRow(label, control) {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        margin_top: 3,
        margin_bottom: 3,
        margin_start: 3,
        margin_end: 3,
    });
    const labelWidget = new Gtk.Label({
        label,
        xalign: 0,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    });

    row.append(labelWidget);
    row.append(control);
    return row;
}

export class ComposerMenus {
    constructor({
        workspace,
        getParentWindow,
        getState,
        setState,
        focusComposer,
        getComposerText,
        setComposerText,
        handleMemoryToggleChanged,
        handleAgentModeToggleChanged,
        handleSkillsToggleChanged,
    }) {
        this._workspace = workspace;
        this._getParentWindow = getParentWindow;
        this.focusComposer = focusComposer;
        this._getComposerText = getComposerText;
        this._setComposerText = setComposerText;
        this._handleMemoryToggleChanged = handleMemoryToggleChanged;
        this._handleAgentModeToggleChanged = handleAgentModeToggleChanged;
        this._handleSkillsToggleChanged = handleSkillsToggleChanged;

        for (const name of [
            '_agentModeToggleButton',
            '_chatOptionsMenuButton',
            '_composer',
            '_composerBuffer',
            '_memoryToggleButton',
            '_promptMenuButton',
            '_promptMenuPopover',
            '_skillsToggleButton',
        ]) {
            Object.defineProperty(this, name, {
                configurable: true,
                get: () => getState(name),
                set: (value) => setState(name, value),
            });
        }
    }

    _createChatOptionsMenuButton() {
        const menuButton = new Gtk.MenuButton({
            tooltip_text: 'Chat options',
            valign: Gtk.Align.CENTER,
        });
        const popover = new Gtk.Popover();
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10,
        });

        menuButton.set_child(createBundledIcon(MORE_VERTICAL_ICON_FILE, 'view-more-symbolic'));

        this._memoryToggleButton = new Gtk.Switch({
            tooltip_text: 'Use memories for this chat',
            valign: Gtk.Align.CENTER,
        });
        this._memoryToggleButton.connect('notify::active', () => this._handleMemoryToggleChanged());

        this._agentModeToggleButton = new Gtk.Switch({
            tooltip_text: 'Agent',
            valign: Gtk.Align.CENTER,
        });
        this._agentModeToggleButton.connect('notify::active', () => this._handleAgentModeToggleChanged());

        this._skillsToggleButton = new Gtk.Switch({
            tooltip_text: 'Use enabled skills for this chat',
            valign: Gtk.Align.CENTER,
        });
        this._skillsToggleButton.connect('notify::active', () => this._handleSkillsToggleChanged());

        content.append(createLabeledControlRow('Memory', this._memoryToggleButton));
        content.append(createLabeledControlRow('Agent', this._agentModeToggleButton));
        content.append(createLabeledControlRow('Skills', this._skillsToggleButton));

        popover.set_child(new Gtk.ScrolledWindow({
            child: content,
            max_content_height: 240,
            min_content_width: 320,
            propagate_natural_height: true,
        }));
        this._chatOptionsMenuButton = menuButton;
        menuButton.set_popover(popover);
        return menuButton;
    }

    _createPromptMenuButton() {
        const menuButton = new Gtk.MenuButton({
            tooltip_text: 'Insert prompt',
        });
        const popover = new Gtk.Popover();

        menuButton.set_child(createBundledIcon(PROMPT_ICON_FILE, 'insert-text-symbolic'));
        menuButton.set_popover(popover);
        this._promptMenuButton = menuButton;
        this._promptMenuPopover = popover;
        this._refreshPromptMenu();
        return menuButton;
    }

    _refreshPromptMenu() {
        if (!this._promptMenuPopover || !this._promptMenuButton)
            return;

        const prompts = this._workspace.prompts;
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });

        if (prompts.length === 0) {
            const emptyLabel = new Gtk.Label({
                label: 'No saved prompts',
                xalign: 0,
            });
            emptyLabel.add_css_class('dim-label');
            box.append(emptyLabel);
        }

        for (const prompt of prompts) {
            const variableText = formatPromptVariables(prompt.content);
            const button = new Gtk.Button({
                halign: Gtk.Align.FILL,
                tooltip_text: [prompt.content, variableText].filter(Boolean).join('\n'),
            });
            button.add_css_class('flat');

            const labels = new Gtk.Box({
                margin_top: 4,
                margin_bottom: 4,
                margin_start: 6,
                margin_end: 6,
            });
            const titleLabel = new Gtk.Label({
                label: prompt.title,
                xalign: 0,
                ellipsize: Pango.EllipsizeMode.END,
                lines: 1,
                single_line_mode: true,
            });

            labels.append(titleLabel);

            button.set_child(labels);
            button.connect('clicked', () => {
                this._promptMenuPopover.popdown();
                this._insertPrompt(prompt);
            });
            box.append(button);
        }

        this._promptMenuPopover.set_child(new Gtk.ScrolledWindow({
            child: box,
            max_content_height: 360,
            min_content_width: 320,
            propagate_natural_height: true,
        }));
    }

    _insertPrompt(prompt) {
        const content = String(prompt?.content ?? '').trim();

        if (!content || !this._composer)
            return;

        const variables = extractPromptVariables(content);

        if (variables.length > 0) {
            this._promptForPromptVariables(prompt, variables);
            return;
        }

        this._insertPromptContent(content);
    }

    _promptForPromptVariables(prompt, variables) {
        const entries = new Map();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Fill Prompt Variables',
            body: String(prompt?.title ?? ''),
        });

        const syncInsertEnabled = () => {
            dialog.set_response_enabled('insert', variables.every((name) => (
                entries.get(name)?.get_text().trim()
            )));
        };

        for (const name of variables) {
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 3,
            });
            const label = new Gtk.Label({
                label: name,
                xalign: 0,
            });
            const entry = new Gtk.Entry({
                placeholder_text: name,
                hexpand: true,
                activates_default: true,
            });

            entry.connect('changed', syncInsertEnabled);
            entries.set(name, entry);
            row.append(label);
            row.append(entry);
            box.append(row);
        }

        dialog.set_extra_child(box);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('insert', 'Insert');
        dialog.set_default_response('insert');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('insert', Adw.ResponseAppearance.SUGGESTED);
        syncInsertEnabled();
        dialog.choose(this._getParentWindow(), null, (_dialog, result) => {
            if (dialog.choose_finish(result) !== 'insert')
                return;

            const values = {};

            for (const name of variables)
                values[name] = entries.get(name).get_text().trim();

            this._insertPromptContent(renderPromptTemplate(prompt.content, values).trim());
        });
    }

    _insertPromptContent(content) {
        const existingText = this._getComposerText();
        const cursorIter = this._composerBuffer.get_iter_at_mark(this._composerBuffer.get_insert());
        const cursorPosition = Math.max(cursorIter.get_offset(), 0);
        const before = existingText.slice(0, cursorPosition);
        const after = existingText.slice(cursorPosition);
        const beforeSeparator = before && !/\s$/.test(before) ? ' ' : '';
        const afterSeparator = after && !/^\s/.test(after) ? ' ' : '';
        const nextText = `${before}${beforeSeparator}${content}${afterSeparator}${after}`;
        const nextCursorPosition = before.length + beforeSeparator.length + content.length;

        this._setComposerText(nextText, { preserveReferences: true });
        this._composerBuffer.place_cursor(this._composerBuffer.get_iter_at_offset(nextCursorPosition));
        this.focusComposer();
    }

}
