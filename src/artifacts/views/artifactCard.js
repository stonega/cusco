import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

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

function copyText(text) {
    const clipboard = Gdk.Display.get_default()?.get_clipboard();
    clipboard?.set(String(text ?? ''));
}

function missingArtifactCard(reference) {
    const card = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 10,
        margin_end: 10,
    });
    const title = new Gtk.Label({
        label: reference?.title ?? 'Missing artifact',
        xalign: 0,
    });
    const message = new Gtk.Label({
        label: 'This artifact revision is missing or no longer readable.',
        wrap: true,
        xalign: 0,
    });
    message.add_css_class('dim-label');
    card.add_css_class('cusco-artifact-card');
    card.append(title);
    card.append(message);
    return card;
}

export function createManagedArtifactCard(reference, options = {}) {
    const manager = options.artifactManager;
    const registry = options.artifactRegistry;
    const resolved = manager?.resolveReference(reference);

    if (!resolved || !registry)
        return missingArtifactCard(reference);

    const card = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        hexpand: true,
    });
    card.add_css_class('cusco-artifact-card');
    card.add_css_class(`cusco-artifact-${resolved.artifact.kind}`);

    const header = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 8,
        margin_end: 8,
    });
    header.add_css_class('cusco-artifact-header');
    const titleBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 1,
        hexpand: true,
    });
    const title = new Gtk.Label({
        label: resolved.artifact.title,
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
    });
    const revisionNumber = Math.max(
        1,
        resolved.artifact.revisionIds.indexOf(resolved.revision.id) + 1,
    );
    const capabilityLabel = resolved.artifact.capabilities.length > 0
        ? ` · ${resolved.artifact.capabilities.join(', ')}`
        : '';
    const metadata = new Gtk.Label({
        label: `${resolved.artifact.format.toUpperCase()} · Revision ${revisionNumber}${capabilityLabel}`,
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
    });
    metadata.add_css_class('caption');
    metadata.add_css_class('dim-label');
    titleBox.append(title);
    titleBox.append(metadata);
    header.append(titleBox);

    const entrypoint = resolved.revision.manifest.entrypoint;
    const entrypointDescriptor = resolved.revision.manifest.files.find((file) => file.path === entrypoint);
    const isText = entrypointDescriptor?.mimeType.startsWith('text/')
        || ['application/json', 'image/svg+xml'].includes(entrypointDescriptor?.mimeType);
    const copyButton = actionButton('edit-copy-symbolic', 'Copy artifact source', () => {
        try {
            copyText(isText
                ? manager.readText(resolved.artifact.id, resolved.revision.id, entrypoint)
                : manager.filePath(resolved.artifact.id, resolved.revision.id, entrypoint));
        } catch (error) {
            logError(error, 'Failed to copy artifact source');
        }
    });
    copyButton.set_sensitive(Boolean(entrypointDescriptor));
    header.append(copyButton);

    const exportButton = actionButton('document-save-symbolic', 'Export artifact', () => {
        options.onExportArtifact?.(reference);
    });
    exportButton.set_sensitive(Boolean(options.onExportArtifact));
    header.append(exportButton);

    const openButton = actionButton('sidebar-show-right-symbolic', 'Open artifact workspace', () => {
        options.onOpenArtifact?.(reference);
    });
    openButton.set_sensitive(Boolean(options.onOpenArtifact));
    header.append(openButton);
    card.append(header);

    const preview = registry.createInlineView(resolved, {
        autoActivate: options.autoActivateHtml !== false,
        onOpenArtifact: () => options.onOpenArtifact?.(reference),
        onExternalLink: options.onExternalLink,
        onTerminated: options.onArtifactTerminated,
    });

    if (preview)
        card.append(preview);

    card.artifactReference = reference;
    return card;
}
