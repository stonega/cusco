import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import {
    filterComposerSuggestions,
    findComposerTrigger,
    HomeFileIndex,
    listPathExecutables,
} from './references.js';
import {
    composerReferenceKindForTrigger,
    composerReferenceRanges,
} from './presentation.js';

const COMPOSER_SUGGESTION_LIMIT = 8;

function clearContainer(container) {
    for (let child = container?.get_first_child?.(); child;) {
        const next = child.get_next_sibling();
        container.remove(child);
        child = next;
    }
}

export class ComposerSuggestions {
    constructor({
        workspace,
        artifacts,
        getActiveConversationId,
        getBuffer,
        getText,
        getReferences,
        addReference,
        isUpdatingReferences,
        setUpdatingReferences,
        syncReferenceTags,
        focusComposer,
        isQuestionActive,
    }) {
        this._workspace = workspace;
        this._artifacts = artifacts;
        this._getActiveConversationId = getActiveConversationId;
        this._getBuffer = getBuffer;
        this._getText = getText;
        this._getReferences = getReferences;
        this._addReference = addReference;
        this._isUpdatingReferences = isUpdatingReferences;
        this._setUpdatingReferences = setUpdatingReferences;
        this._syncReferenceTags = syncReferenceTags;
        this._focusComposer = focusComposer;
        this._isQuestionActive = isQuestionActive;
        this._items = [];
        this._refreshSourceId = 0;
        this._rowsKey = '';
        this._activeTrigger = null;
        this._dismissedTrigger = '';
        this._pathCommands = null;
        this._homeFileIndex = new HomeFileIndex({
            onChanged: () => {
                if (this._activeTrigger?.trigger === '@'
                    && this._activeTrigger?.referenceKind !== 'artifact') {
                    this.scheduleRefresh();
                }
            },
        });
    }

    createPanel() {
        const panel = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_bottom: 6,
        });
        panel.add_css_class('cusco-composer-suggestions');
        this._heading = new Gtk.Label({
            xalign: 0,
            margin_start: 10,
            margin_end: 10,
            margin_top: 7,
        });
        this._heading.add_css_class('caption');
        this._heading.add_css_class('dim-label');
        panel.append(this._heading);
        this._list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: true,
        });
        this._list.add_css_class('boxed-list');
        this._list.connect('row-activated', (_list, row) => {
            if (row?.composerSuggestion)
                this.insert(row.composerSuggestion);
        });
        this._scroller = new Gtk.ScrolledWindow({
            child: this._list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            max_content_height: 310,
            propagate_natural_height: true,
        });
        panel.append(this._scroller);
        this._status = new Gtk.Label({
            xalign: 0,
            margin_start: 10,
            margin_end: 10,
            margin_top: 5,
            margin_bottom: 8,
            visible: false,
        });
        this._status.add_css_class('dim-label');
        panel.append(this._status);
        this._revealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_UP,
            transition_duration: 140,
            reveal_child: false,
        });
        this._revealer.set_child(panel);
        return this._revealer;
    }

    dispose() {
        this._homeFileIndex.stop();
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
    }

    _skillItems() {
        return this._workspace.enabledSkills.map((skill) => ({
            kind: 'skill',
            value: skill.id,
            title: skill.name,
            subtitle: skill.description || skill.path,
            searchText: `${skill.name} ${skill.description ?? ''}`,
            insertText: `$${skill.name}`,
        }));
    }

    _artifactItems() {
        return this._artifacts.listArtifacts({
            conversationId: this._getActiveConversationId(),
        }).map((artifact) => ({
            kind: 'artifact',
            value: `${artifact.id}/${artifact.currentRevisionId}`,
            title: artifact.title,
            subtitle: `${artifact.format.toUpperCase()} · ${artifact.revisionIds.length} revision${artifact.revisionIds.length === 1 ? '' : 's'}`,
            searchText: `${artifact.title} ${artifact.kind} ${artifact.format}`,
            insertText: `@artifact:${artifact.title}`,
        }));
    }

    _itemsForTrigger(trigger) {
        switch (trigger) {
        case '$':
            return this._skillItems();
        case '@':
            this._homeFileIndex.start();
            return this._homeFileIndex.items;
        case '#':
            this._pathCommands ??= listPathExecutables();
            return this._pathCommands;
        default:
            return [];
        }
    }

    _triggerKey(trigger) {
        return trigger ? `${trigger.trigger}:${trigger.startOffset}:${trigger.query}` : '';
    }

    scheduleRefresh() {
        if (this._isQuestionActive(this._getActiveConversationId()) || this._refreshSourceId)
            return;
        this._refreshSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshSourceId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        if (this._isQuestionActive(this._getActiveConversationId())) {
            this.hide();
            return;
        }
        const buffer = this._getBuffer();
        if (this._isUpdatingReferences() || !buffer || !this._revealer)
            return;
        const text = this._getText();
        const cursor = buffer.get_iter_at_mark(buffer.get_insert()).get_offset();
        const trigger = findComposerTrigger(text, cursor);
        const triggerKey = this._triggerKey(trigger);
        if (!trigger || triggerKey === this._dismissedTrigger) {
            this._activeTrigger = null;
            this.hide();
            return;
        }
        this._dismissedTrigger = '';
        this._activeTrigger = trigger;
        const isArtifactTrigger = trigger.trigger === '@'
            && trigger.query.toLowerCase().startsWith('artifact:');
        const artifactQuery = isArtifactTrigger ? trigger.query.slice('artifact:'.length) : '';
        trigger.referenceKind = isArtifactTrigger
            ? 'artifact'
            : composerReferenceKindForTrigger(trigger.trigger);
        trigger.displayQuery = isArtifactTrigger ? artifactQuery : trigger.query;
        const items = isArtifactTrigger
            ? this._artifactItems()
            : this._itemsForTrigger(trigger.trigger);
        this._items = isArtifactTrigger
            ? filterComposerSuggestions(items, artifactQuery, COMPOSER_SUGGESTION_LIMIT)
            : trigger.trigger === '@'
                ? this._homeFileIndex.search(trigger.query, COMPOSER_SUGGESTION_LIMIT)
                : filterComposerSuggestions(items, trigger.query, COMPOSER_SUGGESTION_LIMIT);
        this._render();
    }

    _render() {
        if (!this._list || !this._activeTrigger)
            return;
        const kind = this._activeTrigger.referenceKind
            ?? composerReferenceKindForTrigger(this._activeTrigger.trigger);
        const heading = {
            skill: 'Skills',
            file: 'Files in Home',
            command: 'Commands on PATH',
            artifact: 'Artifacts in this chat',
        }[kind];
        this._heading.set_label(this._activeTrigger.displayQuery
            ? `${heading} matching “${this._activeTrigger.displayQuery}”`
            : heading);
        const rowsKey = `${kind}:${this._items
            .map((item) => `${item.kind}\u0000${item.value}\u0000${item.title}\u0000${item.subtitle}`)
            .join('\u0001')}`;
        if (rowsKey !== this._rowsKey) {
            clearContainer(this._list);
            for (const item of this._items) {
                const row = new Gtk.ListBoxRow({ activatable: true, selectable: true });
                row.composerSuggestion = item;
                const content = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 10,
                    margin_top: 7,
                    margin_bottom: 7,
                    margin_start: 9,
                    margin_end: 9,
                });
                const prefix = new Gtk.Label({
                    label: this._activeTrigger.trigger,
                    width_chars: 2,
                    valign: Gtk.Align.CENTER,
                });
                prefix.add_css_class('title-4');
                prefix.add_css_class(`cusco-composer-reference-${kind}`);
                const labels = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 1,
                    hexpand: true,
                });
                const title = new Gtk.Label({
                    label: item.title,
                    xalign: 0,
                    ellipsize: Pango.EllipsizeMode.END,
                });
                const subtitle = new Gtk.Label({
                    label: item.subtitle,
                    xalign: 0,
                    ellipsize: Pango.EllipsizeMode.MIDDLE,
                });
                subtitle.add_css_class('caption');
                subtitle.add_css_class('dim-label');
                labels.append(title);
                labels.append(subtitle);
                content.append(prefix);
                content.append(labels);
                row.set_child(content);
                this._list.append(row);
            }
            this._rowsKey = rowsKey;
        }
        const hasItems = this._items.length > 0;
        const isIndexingFiles = kind === 'file' && this._homeFileIndex.loading;
        this._scroller.set_visible(hasItems);
        this._status.set_visible(!hasItems || isIndexingFiles);
        this._status.set_label(hasItems && isIndexingFiles
            ? 'More files are still being indexed…'
            : isIndexingFiles
                ? 'Searching your Home folder…'
                : `No matching ${kind}s`);
        this._revealer.set_reveal_child(true);
        if (hasItems && !this._list.get_selected_row())
            this._list.select_row(this._list.get_row_at_index(0));
    }

    isVisible() {
        return Boolean(this._revealer?.get_reveal_child());
    }

    hide() {
        this._revealer?.set_reveal_child(false);
        this._items = [];
        this._rowsKey = '';
    }

    dismiss() {
        this._dismissedTrigger = this._triggerKey(this._activeTrigger);
        this._activeTrigger = null;
        this.hide();
        this._focusComposer();
    }

    handleKey(keyval) {
        if (!this.isVisible())
            return false;
        if (keyval === Gdk.KEY_Escape) {
            this.dismiss();
            return true;
        }
        const isPrevious = keyval === Gdk.KEY_Up;
        const isNext = keyval === Gdk.KEY_Down;
        if ((isPrevious || isNext) && this._items.length > 0) {
            const selectedIndex = this._list.get_selected_row()?.get_index() ?? 0;
            const delta = isPrevious ? -1 : 1;
            const nextIndex = (selectedIndex + delta + this._items.length) % this._items.length;
            this._list.select_row(this._list.get_row_at_index(nextIndex));
            return true;
        }
        const isSelect = keyval === Gdk.KEY_Tab
            || keyval === Gdk.KEY_ISO_Left_Tab
            || keyval === Gdk.KEY_Return
            || keyval === Gdk.KEY_KP_Enter;
        if (!isSelect)
            return false;
        const suggestion = this._list.get_selected_row()?.composerSuggestion;
        if (!suggestion)
            return false;
        this.insert(suggestion);
        return true;
    }

    insert(suggestion) {
        const trigger = this._activeTrigger;
        const buffer = this._getBuffer();
        if (!trigger || !suggestion?.insertText || !buffer)
            return;
        const textCharacters = [...this._getText()];
        const hasWhitespaceAfter = trigger.endOffset < textCharacters.length
            && /\s/u.test(textCharacters[trigger.endOffset]);
        const replacement = `${suggestion.insertText}${hasWhitespaceAfter ? '' : ' '}`;
        const replacementLength = [...replacement].length;
        this._setUpdatingReferences(true);
        buffer.begin_user_action();
        buffer.delete(
            buffer.get_iter_at_offset(trigger.startOffset),
            buffer.get_iter_at_offset(trigger.endOffset),
        );
        buffer.insert(buffer.get_iter_at_offset(trigger.startOffset), replacement, -1);
        buffer.place_cursor(buffer.get_iter_at_offset(trigger.startOffset + replacementLength));
        buffer.end_user_action();
        this._addReference({
            kind: suggestion.kind,
            value: suggestion.value,
            title: suggestion.title,
            insertText: suggestion.insertText,
        });
        this._setUpdatingReferences(false);
        this._activeTrigger = null;
        this._dismissedTrigger = '';
        this.hide();
        this._syncReferenceTags();
        this._focusComposer();
    }

    deleteReferenceAtCursor(keyval) {
        const isBackspace = keyval === Gdk.KEY_BackSpace;
        const isDelete = keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_KP_Delete;
        const buffer = this._getBuffer();
        if ((!isBackspace && !isDelete) || !buffer)
            return false;
        const [hasSelection] = buffer.get_selection_bounds();
        if (hasSelection)
            return false;
        const text = this._getText();
        const characters = [...text];
        const cursor = buffer.get_iter_at_mark(buffer.get_insert()).get_offset();
        const range = composerReferenceRanges(text, this._getReferences()).find((candidate) => (
            isBackspace
                ? cursor > candidate.startOffset && cursor <= candidate.endOffset
                : cursor >= candidate.startOffset && cursor < candidate.endOffset
        ));
        if (!range)
            return false;
        let endOffset = range.endOffset;
        if (characters[endOffset] === ' ')
            endOffset += 1;
        this._setUpdatingReferences(true);
        buffer.delete(
            buffer.get_iter_at_offset(range.startOffset),
            buffer.get_iter_at_offset(endOffset),
        );
        buffer.place_cursor(buffer.get_iter_at_offset(range.startOffset));
        this._setUpdatingReferences(false);
        this._syncReferenceTags();
        this.refresh();
        return true;
    }
}
