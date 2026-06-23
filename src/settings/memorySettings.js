import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

function formatMemorySubtitle(memory, memoryManager) {
    const parts = [];

    if (!memory.enabled)
        parts.push('Disabled');

    if (memory.pinned)
        parts.push('Pinned');

    const useCount = memoryManager.getAuditLog(memory.id).length;
    parts.push(`${useCount} uses`);

    return parts.join(' / ');
}

function createActionButton(iconName, tooltipText, onClicked) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });
    button.add_css_class('flat');
    button.connect('clicked', onClicked);
    return button;
}

function getFilePath(file) {
    const path = file?.get_path();

    if (!path)
        throw new Error('Only local memory import/export paths are supported right now');

    return path;
}

function editMemory(parent, memoryManager, memory, onChanged) {
    const entry = new Gtk.Entry({
        text: memory.content,
        hexpand: true,
    });
    const dialog = new Adw.AlertDialog({
        heading: 'Edit Memory',
    });
    dialog.set_extra_child(entry);
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('save', 'Save');
    dialog.set_default_response('save');
    dialog.set_close_response('cancel');
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.choose(parent, null, (_dialog, result) => {
        if (dialog.choose_finish(result) !== 'save')
            return;

        try {
            memoryManager.updateMemory(memory.id, { content: entry.get_text() });
            onChanged();
        } catch (error) {
            logError(error, 'Failed to edit memory');
        }
    });
}

function exportMemories(parent, memoryManager) {
    const dialog = new Gtk.FileDialog({
        title: 'Export Memories',
        initial_name: 'cusco-memories.json',
    });

    dialog.save(parent, null, (_dialog, result) => {
        try {
            const file = dialog.save_finish(result);
            GLib.file_set_contents(getFilePath(file), `${memoryManager.exportData()}\n`);
        } catch (error) {
            logError(error, 'Failed to export memories');
        }
    });
}

function importMemories(parent, memoryManager, onChanged) {
    const dialog = new Gtk.FileDialog({
        title: 'Import Memories',
    });

    dialog.open(parent, null, (_dialog, result) => {
        try {
            const file = dialog.open_finish(result);
            const [, contents] = GLib.file_get_contents(getFilePath(file));
            memoryManager.importData(new TextDecoder().decode(contents));
            onChanged();
        } catch (error) {
            logError(error, 'Failed to import memories');
        }
    });
}

function createMemoryRow(parent, memoryManager, memory, onChanged) {
    const row = new Adw.ExpanderRow({
        title: memory.content,
        subtitle: formatMemorySubtitle(memory, memoryManager),
    });

    const enabledRow = new Adw.SwitchRow({
        title: 'Enabled',
        subtitle: 'Use this memory in chat context.',
        active: memory.enabled,
    });
    enabledRow.connect('notify::active', () => {
        memoryManager.updateMemory(memory.id, { enabled: enabledRow.get_active() });
        onChanged();
    });
    row.add_row(enabledRow);

    const pinnedRow = new Adw.SwitchRow({
        title: 'Pinned',
        subtitle: 'Prioritize this memory when chat memory is enabled.',
        active: memory.pinned,
    });
    pinnedRow.connect('notify::active', () => {
        memoryManager.updateMemory(memory.id, { pinned: pinnedRow.get_active() });
        onChanged();
    });
    row.add_row(pinnedRow);

    const auditRow = new Adw.ActionRow({
        title: 'Audit trail',
        subtitle: memoryManager.getAuditLog(memory.id)
            .map((entry) => `${entry.usedAt} in ${entry.conversationId || 'unknown chat'}`)
            .slice(0, 3)
            .join('\n') || 'This memory has not been used yet.',
    });
    row.add_row(auditRow);

    const editRow = new Adw.ActionRow({
        title: 'Edit',
        subtitle: 'Update the saved memory text.',
    });
    editRow.add_suffix(createActionButton('document-edit-symbolic', 'Edit memory', () => {
        editMemory(parent, memoryManager, memory, onChanged);
    }));
    row.add_row(editRow);

    const deleteRow = new Adw.ActionRow({
        title: 'Delete',
        subtitle: 'Remove this memory and its audit entries.',
    });
    deleteRow.add_suffix(createActionButton('user-trash-symbolic', 'Delete memory', () => {
        try {
            memoryManager.deleteMemory(memory.id);
            onChanged();
        } catch (error) {
            logError(error, 'Failed to delete memory');
        }
    }));
    row.add_row(deleteRow);

    return row;
}

export function createMemorySettingsPage(parent, memoryManager, onChanged = () => {}) {
    const page = new Adw.PreferencesPage({
        title: 'Memory',
        icon_name: 'user-bookmarks-symbolic',
    });
    const managementGroup = new Adw.PreferencesGroup({
        title: 'Memory Manager',
        description: 'Saved memories are only written after explicit approval.',
    });
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: 'Search memories',
        hexpand: true,
        margin_top: 6,
        margin_bottom: 6,
    });
    const searchRow = new Gtk.ListBoxRow({
        activatable: false,
        child: searchEntry,
        selectable: false,
    });
    const rows = [];

    const refreshRows = () => {
        for (const row of rows)
            managementGroup.remove(row);

        rows.splice(0);

        const memories = memoryManager.searchMemories(searchEntry.get_text());

        if (memories.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No memories',
                subtitle: 'Approved memories will appear here.',
            });
            rows.push(emptyRow);
            managementGroup.add(emptyRow);
            return;
        }

        for (const memory of memories) {
            const row = createMemoryRow(parent, memoryManager, memory, () => {
                refreshRows();
                onChanged();
            });
            rows.push(row);
            managementGroup.add(row);
        }
    };

    searchEntry.connect('search-changed', refreshRows);
    managementGroup.add(searchRow);
    refreshRows();

    const transferGroup = new Adw.PreferencesGroup({
        title: 'Import and Export',
    });
    const exportRow = new Adw.ActionRow({
        title: 'Export memories',
        subtitle: 'Write memories and audit entries to a JSON file.',
    });
    exportRow.add_suffix(createActionButton('document-save-symbolic', 'Export memories', () => {
        exportMemories(parent, memoryManager);
    }));
    transferGroup.add(exportRow);

    const importRow = new Adw.ActionRow({
        title: 'Import memories',
        subtitle: 'Merge memories and audit entries from a JSON file.',
    });
    importRow.add_suffix(createActionButton('document-open-symbolic', 'Import memories', () => {
        importMemories(parent, memoryManager, () => {
            refreshRows();
            onChanged();
        });
    }));
    transferGroup.add(importRow);

    page.add(managementGroup);
    page.add(transferGroup);
    return page;
}
