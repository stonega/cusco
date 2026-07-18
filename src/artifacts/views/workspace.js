import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { artifactReferenceFor } from '../model.js';
import { createEditableArtifactSourceView } from '../renderers/native.js';

function clearBox(box) {
    let child = box.get_first_child();

    while (child) {
        const next = child.get_next_sibling();
        child.disposeArtifactView?.();
        box.remove(child);
        child.releaseArtifactView?.();
        child = next;
    }
}

function isTextFile(file) {
    return file?.mimeType?.startsWith('text/')
        || ['application/json', 'image/svg+xml'].includes(file?.mimeType);
}

function exportName(artifact, revision) {
    const base = String(artifact.title ?? 'artifact')
        .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        || 'artifact';
    const entrypoint = revision.manifest.entrypoint;
    const extension = entrypoint.includes('.') ? `.${entrypoint.split('.').pop()}` : '';

    return base.toLowerCase().endsWith(extension.toLowerCase()) ? base : `${base}${extension}`;
}

function isFileDialogCancellation(error) {
    return Boolean(
        error?.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED)
        || error?.matches?.(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED)
        || error?.matches?.(Gtk.dialog_error_quark(), Gtk.DialogError.CANCELLED),
    );
}

function actionButton(iconName, tooltipText, onClicked) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
    });
    button.add_css_class('flat');
    button.connect('clicked', onClicked);
    return button;
}

export function createArtifactWorkspace(options = {}) {
    const manager = options.artifactManager;
    const registry = options.artifactRegistry;

    if (!manager || !registry)
        throw new Error('Artifact workspace requires an artifact manager and renderer registry.');

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    });
    root.add_css_class('cusco-artifact-workspace');
    let activeReference = null;
    let activeResolved = null;
    let activeConversationId = '';
    let suppressArtifactSelection = false;
    let suppressRevisionSelection = false;
    let suppressFileSelection = false;
    let sourceView = null;

    const header = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 8,
        margin_end: 8,
    });
    header.add_css_class('toolbar');
    const closeButton = actionButton('window-close-symbolic', 'Close artifact workspace', () => {
        options.onClose?.();
    });
    const artifactPicker = new Gtk.ComboBoxText({
        hexpand: true,
        tooltip_text: 'Artifact',
    });
    const revisionPicker = new Gtk.ComboBoxText({
        tooltip_text: 'Revision',
    });
    const reloadButton = actionButton('view-refresh-symbolic', 'Reload preview', () => {
        const child = previewContainer.get_first_child();
        child?.reloadArtifactView?.();

        if (!child?.reloadArtifactView)
            renderPreview();
    });
    const stopButton = actionButton('media-playback-stop-symbolic', 'Stop artifact', () => {
        previewContainer.get_first_child()?.stopArtifactView?.();
    });
    const renameButton = actionButton('document-edit-symbolic', 'Rename artifact', () => {
        renameActiveArtifact();
    });
    const forkButton = actionButton('edit-copy-symbolic', 'Fork this revision', () => {
        if (!activeResolved)
            return;

        try {
            const forked = manager.forkArtifact(
                activeResolved.artifact.id,
                activeResolved.revision.id,
                {
                    originConversationId: activeConversationId || activeResolved.artifact.originConversationId,
                    createdBy: 'user',
                },
            );
            populateArtifacts();
            openReference(forked.reference);
            options.onArtifactChanged?.(forked.reference, 'forked');
        } catch (error) {
            logError(error, 'Failed to fork artifact');
            setStatus(error.message);
        }
    });
    const exportButton = actionButton('document-save-symbolic', 'Export artifact', () => {
        exportActiveArtifact();
    });
    const archiveButton = actionButton('user-trash-symbolic', 'Archive artifact', () => {
        toggleArchiveActiveArtifact();
    });
    header.append(closeButton);
    header.append(artifactPicker);
    header.append(revisionPicker);
    header.append(reloadButton);
    header.append(stopButton);
    header.append(renameButton);
    header.append(forkButton);
    header.append(exportButton);
    header.append(archiveButton);
    root.append(header);

    const titleRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 6,
    });
    const titleLabel = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        ellipsize: Pango.EllipsizeMode.END,
    });
    titleLabel.add_css_class('title-4');
    const metadataLabel = new Gtk.Label({
        xalign: 1,
        ellipsize: Pango.EllipsizeMode.END,
    });
    metadataLabel.add_css_class('caption');
    metadataLabel.add_css_class('dim-label');
    titleRow.append(titleLabel);
    titleRow.append(metadataLabel);
    root.append(titleRow);

    const previewContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    });
    const sourceShell = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        hexpand: true,
        vexpand: true,
        margin_start: 6,
        margin_end: 6,
        margin_bottom: 6,
    });
    const sourceToolbar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
    });
    const filePicker = new Gtk.ComboBoxText({ hexpand: true });
    const historicalLabel = new Gtk.Label({
        label: 'Historical revision',
        visible: false,
    });
    historicalLabel.add_css_class('caption');
    historicalLabel.add_css_class('warning');
    const saveSourceButton = new Gtk.Button({
        label: 'Save revision',
        sensitive: false,
    });
    sourceToolbar.append(filePicker);
    sourceToolbar.append(historicalLabel);
    sourceToolbar.append(saveSourceButton);
    const sourceContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    });
    sourceShell.append(sourceToolbar);
    sourceShell.append(sourceContainer);

    const viewStack = new Adw.ViewStack({
        hexpand: true,
        vexpand: true,
    });
    viewStack.add_titled(previewContainer, 'preview', 'Preview');
    viewStack.add_titled(sourceShell, 'source', 'Source');
    const viewSwitcher = new Adw.ViewSwitcher({
        stack: viewStack,
        policy: Adw.ViewSwitcherPolicy.WIDE,
        halign: Gtk.Align.CENTER,
        margin_bottom: 6,
    });
    root.append(viewSwitcher);
    root.append(viewStack);

    const statusLabel = new Gtk.Label({
        xalign: 0,
        wrap: true,
        visible: false,
        margin_top: 4,
        margin_bottom: 6,
        margin_start: 12,
        margin_end: 12,
    });
    statusLabel.add_css_class('caption');
    statusLabel.add_css_class('dim-label');
    root.append(statusLabel);

    function setStatus(message = '') {
        statusLabel.set_label(String(message ?? ''));
        statusLabel.set_visible(Boolean(message));
    }

    function populateArtifacts() {
        const artifacts = manager.listArtifacts({
            conversationId: activeConversationId,
            includeArchived: true,
        });

        suppressArtifactSelection = true;
        artifactPicker.remove_all();

        for (const artifact of artifacts) {
            artifactPicker.append(
                artifact.id,
                artifact.archivedAt ? `${artifact.title} (Archived)` : artifact.title,
            );
        }

        if (activeResolved && artifacts.some((artifact) => artifact.id === activeResolved.artifact.id))
            artifactPicker.set_active_id(activeResolved.artifact.id);
        else if (artifacts.length > 0)
            artifactPicker.set_active(0);

        suppressArtifactSelection = false;
    }

    function populateRevisions() {
        suppressRevisionSelection = true;
        revisionPicker.remove_all();

        if (activeResolved) {
            activeResolved.artifact.revisionIds.forEach((revisionId, index) => {
                revisionPicker.append(revisionId, `r${index + 1}`);
            });
            revisionPicker.set_active_id(activeResolved.revision.id);
        }

        suppressRevisionSelection = false;
    }

    function renderPreview() {
        clearBox(previewContainer);
        stopButton.set_sensitive(false);

        if (!activeResolved)
            return;

        const view = registry.createWorkspaceView(activeResolved, {
            onExternalLink: (uri) => options.onExternalLink?.(uri),
            onOpenExternal: (path) => {
                if (options.onOpenExternal) {
                    options.onOpenExternal(path);
                    return;
                }

                try {
                    Gtk.show_uri(
                        options.parentWindow ?? null,
                        Gio.File.new_for_path(path).get_uri(),
                        0,
                    );
                } catch (error) {
                    logError(error, `Failed to open artifact file: ${path}`);
                    setStatus('The artifact could not be opened externally.');
                }
            },
            onTerminated: () => setStatus('The artifact renderer stopped unexpectedly. Reload to try again.'),
        });

        if (view) {
            previewContainer.append(view);
            stopButton.set_sensitive(Boolean(view.stopArtifactView));
        }
    }

    function renderSource(preferredPath = '') {
        clearBox(sourceContainer);
        sourceView = null;
        suppressFileSelection = true;
        filePicker.remove_all();

        if (!activeResolved) {
            suppressFileSelection = false;
            saveSourceButton.set_sensitive(false);
            return;
        }

        const textFiles = activeResolved.revision.manifest.files.filter(isTextFile);

        for (const file of textFiles)
            filePicker.append(file.path, file.path);

        const selectedPath = textFiles.some((file) => file.path === preferredPath)
            ? preferredPath
            : textFiles.some((file) => file.path === activeResolved.revision.manifest.entrypoint)
                ? activeResolved.revision.manifest.entrypoint
                : textFiles[0]?.path ?? '';

        if (!selectedPath) {
            const unavailable = new Gtk.Label({
                label: 'This artifact has no editable text files.',
                wrap: true,
                margin_top: 24,
                margin_bottom: 24,
            });
            unavailable.add_css_class('dim-label');
            sourceContainer.append(unavailable);
            suppressFileSelection = false;
            saveSourceButton.set_sensitive(false);
            return;
        }

        filePicker.set_active_id(selectedPath);
        suppressFileSelection = false;
        sourceView = createEditableArtifactSourceView(manager, activeResolved, selectedPath);
        sourceContainer.append(sourceView);
        const isHead = activeResolved.artifact.currentRevisionId === activeResolved.revision.id;
        historicalLabel.set_visible(!isHead);
        saveSourceButton.set_sensitive(isHead);
    }

    function openReference(reference) {
        const resolved = manager.resolveReference(reference);

        if (!resolved) {
            setStatus('This artifact revision is missing.');
            return false;
        }

        activeResolved = resolved;
        activeReference = artifactReferenceFor(resolved.artifact, resolved.revision.id, reference);
        activeConversationId = activeConversationId || resolved.artifact.originConversationId;
        titleLabel.set_label(resolved.artifact.title);
        const revisionNumber = resolved.artifact.revisionIds.indexOf(resolved.revision.id) + 1;
        const capabilityLabel = resolved.artifact.capabilities.length > 0
            ? ` · ${resolved.artifact.capabilities.join(', ')}`
            : '';
        metadataLabel.set_label(
            `${resolved.artifact.format.toUpperCase()} · Revision ${Math.max(1, revisionNumber)}${capabilityLabel}`,
        );
        archiveButton.set_icon_name(resolved.artifact.archivedAt
            ? 'edit-undo-symbolic'
            : 'user-trash-symbolic');
        archiveButton.set_tooltip_text(resolved.artifact.archivedAt
            ? 'Restore artifact'
            : 'Archive artifact');
        setStatus('');
        populateArtifacts();
        populateRevisions();
        renderPreview();
        renderSource();
        options.onOpened?.(activeReference);
        return true;
    }

    function saveSource() {
        if (!activeResolved || !sourceView?.artifactSourceBuffer)
            return;

        const buffer = sourceView.artifactSourceBuffer;
        const [start, end] = buffer.get_bounds();
        const content = buffer.get_text(start, end, true);
        const path = sourceView.artifactSourcePath;
        const descriptor = activeResolved.revision.manifest.files.find((file) => file.path === path);

        try {
            const updated = manager.updateArtifact(activeResolved.artifact.id, {
                baseRevisionId: activeResolved.revision.id,
                changes: [{
                    path,
                    content,
                    mimeType: descriptor?.mimeType,
                }],
                message: `Edited ${path}`,
            }, {
                createdBy: 'user',
            });
            openReference(updated.reference);
            options.onArtifactChanged?.(updated.reference, 'updated');
            setStatus('Saved as a new revision.');
        } catch (error) {
            logError(error, 'Failed to save artifact revision');
            setStatus(error.code === 'ARTIFACT_REVISION_CONFLICT'
                ? 'This artifact changed while you were editing it. Fork this revision or reopen the latest version.'
                : error.message);
        }
    }

    function renameActiveArtifact() {
        if (!activeResolved)
            return;

        const entry = new Gtk.Entry({
            text: activeResolved.artifact.title,
            activates_default: true,
            hexpand: true,
        });
        const dialog = new Adw.AlertDialog({
            heading: 'Rename artifact',
        });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('rename', 'Rename');
        dialog.set_default_response('rename');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
        dialog.choose(options.parentWindow ?? root.get_root(), null, (_dialog, result) => {
            try {
                if (dialog.choose_finish(result) !== 'rename')
                    return;

                manager.renameArtifact(activeResolved.artifact.id, entry.get_text());
                const artifact = manager.getArtifact(activeResolved.artifact.id);
                openReference(artifactReferenceFor(artifact, activeResolved.revision.id));
                options.onArtifactChanged?.(activeReference, 'renamed');
            } catch (error) {
                logError(error, 'Failed to rename artifact');
                setStatus(error.message);
            }
        });
    }

    function toggleArchiveActiveArtifact() {
        if (!activeResolved)
            return;

        try {
            const archived = !activeResolved.artifact.archivedAt;
            const artifact = manager.archiveArtifact(activeResolved.artifact.id, archived);
            openReference(artifactReferenceFor(artifact, activeResolved.revision.id));
            options.onArtifactChanged?.(activeReference, archived ? 'archived' : 'restored');
            setStatus(archived ? 'Artifact archived.' : 'Artifact restored.');
        } catch (error) {
            logError(error, 'Failed to change artifact archive state');
            setStatus(error.message);
        }
    }

    function exportActiveArtifact() {
        if (!activeResolved)
            return;

        const dialog = new Gtk.FileDialog({ title: `Export ${activeResolved.artifact.title}` });
        const isBundle = activeResolved.revision.manifest.files.length > 1;

        if (!isBundle) {
            dialog.set_initial_name(exportName(activeResolved.artifact, activeResolved.revision));
            dialog.save(options.parentWindow ?? null, null, (_dialog, result) => {
                try {
                    const file = dialog.save_finish(result);
                    const path = file.get_path();

                    if (!path)
                        throw new Error('Only local export paths are supported.');

                    manager.exportRevision(
                        activeResolved.artifact.id,
                        activeResolved.revision.id,
                        path,
                        { overwrite: true },
                    );
                    setStatus(`Exported to ${path}`);
                } catch (error) {
                    if (!isFileDialogCancellation(error)) {
                        logError(error, 'Failed to export artifact');
                        setStatus(error.message);
                    }
                }
            });
            return;
        }

        dialog.select_folder(options.parentWindow ?? null, null, (_dialog, result) => {
            try {
                const folder = dialog.select_folder_finish(result);
                const folderPath = folder.get_path();

                if (!folderPath)
                    throw new Error('Only local export folders are supported.');

                const baseName = exportName(activeResolved.artifact, {
                    manifest: { entrypoint: '' },
                }).replace(/\.$/, '') || 'artifact';
                let target = GLib.build_filenamev([folderPath, baseName]);
                let suffix = 2;

                while (GLib.file_test(target, GLib.FileTest.EXISTS)) {
                    target = GLib.build_filenamev([folderPath, `${baseName}-${suffix}`]);
                    suffix++;
                }

                manager.exportRevision(
                    activeResolved.artifact.id,
                    activeResolved.revision.id,
                    target,
                    { asDirectory: true },
                );
                setStatus(`Exported to ${target}`);
            } catch (error) {
                if (!isFileDialogCancellation(error)) {
                    logError(error, 'Failed to export artifact bundle');
                    setStatus(error.message);
                }
            }
        });
    }

    artifactPicker.connect('changed', () => {
        if (suppressArtifactSelection)
            return;

        const artifactId = artifactPicker.get_active_id();
        const artifact = manager.getArtifact(artifactId);

        if (artifact)
            openReference(artifactReferenceFor(artifact));
    });
    revisionPicker.connect('changed', () => {
        if (suppressRevisionSelection || !activeResolved)
            return;

        const revisionId = revisionPicker.get_active_id();

        if (revisionId)
            openReference(artifactReferenceFor(activeResolved.artifact, revisionId));
    });
    filePicker.connect('changed', () => {
        if (!suppressFileSelection)
            renderSource(filePicker.get_active_id());
    });
    saveSourceButton.connect('clicked', saveSource);

    root.openReference = openReference;
    root.setConversation = (conversationId) => {
        activeConversationId = String(conversationId ?? '').trim();
        populateArtifacts();
    };
    root.getActiveReference = () => activeReference ? { ...activeReference } : null;
    root.reloadArtifact = renderPreview;
    root.exportActiveArtifact = exportActiveArtifact;
    root.clearArtifact = () => {
        activeReference = null;
        activeResolved = null;
        titleLabel.set_label('');
        metadataLabel.set_label('');
        clearBox(previewContainer);
        clearBox(sourceContainer);
        populateArtifacts();
        populateRevisions();
    };
    return root;
}
