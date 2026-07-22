import Cairo from 'cairo';
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { createAnnotation } from '../src/imageEditor/document.js';
import { presentImageViewer } from '../src/imageEditor/window.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

    if (type === Gio.FileType.UNKNOWN)
        return;

    if (type === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        try {
            let info;
            while ((info = enumerator.next_file(null)) !== null)
                removeTree(file.get_child(info.get_name()).get_path());
        } finally {
            enumerator.close(null);
        }
    }
    file.delete(null);
}

function runUntil(predicate, timeoutSeconds = 8) {
    const loop = new GLib.MainLoop(null, false);
    let timedOut = false;
    const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
        if (!predicate())
            return GLib.SOURCE_CONTINUE;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
        timedOut = true;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();

    if (!timedOut)
        GLib.source_remove(timeoutId);
    else
        GLib.source_remove(pollId);

    return !timedOut;
}

if (Gtk.init_check()) {
    Adw.init();
    const root = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `cusco-image-editor-window-${GLib.uuid_string_random()}`,
    ]);
    const sourcePath = GLib.build_filenamev([root, 'source.png']);
    const managedDirectory = GLib.build_filenamev([root, 'edited']);
    GLib.mkdir_with_parents(root, 0o700);

    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 96, 64);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(0.15, 0.2, 0.3);
    cr.paint();
    cr.setSourceRGB(0.9, 0.5, 0.15);
    cr.rectangle(20, 12, 56, 40);
    cr.fill();
    surface.writeToPNG(sourcePath);
    cr.$dispose();
    surface.finish();

    const parent = new Adw.Window({ default_width: 640, default_height: 480 });
    let attachedPath = '';
    const viewer = presentImageViewer({
        parent,
        image: {
            path: sourcePath,
            title: 'Editor smoke.png',
            mimeType: 'image/png',
            sourceKind: 'test',
        },
        editedImageDirectory: managedDirectory,
        getAttachCapability: () => ({ allowed: true, reason: '' }),
        onAttach: (path) => {
            attachedPath = path;
            return true;
        },
    });

    assert(runUntil(() => Boolean(viewer._source || viewer._renderError)),
        'Image viewer did not finish loading');
    assert(viewer._source && viewer._document, 'Image viewer failed to construct its document');
    assert(viewer._drawButton.get_next_sibling() === viewer._cropButton,
        'Draw is not immediately before Crop in the viewer header');
    assert(viewer._drawButton.get_icon_name() === 'document-edit-symbolic'
        && !viewer._drawButton.get_label(),
    'Draw is not an icon-only header button');
    assert(viewer._cropButton.get_child()?.get_icon_name() === 'crop-symbolic'
        && !viewer._cropButton.get_label(),
    'Crop is not an icon-only header button');
    assert(viewer.get_transient_for() === parent,
        'Image viewer did not start transient for its parent window');
    viewer._fullscreenButton.emit('clicked');
    assert(viewer.get_transient_for() === null,
        'Fullscreen image viewer remained tied to its parent workspace');
    if (runUntil(() => viewer.is_fullscreen(), 3)) {
        assert(viewer._fullscreenButton.get_icon_name() === 'view-restore-symbolic',
            'Fullscreen button did not switch to its restore state');
        viewer._toggleFullscreen();
        assert(runUntil(() => !viewer.is_fullscreen(), 3),
            'Image viewer did not leave fullscreen');
    } else {
        viewer._leaveFullscreen();
    }
    assert(runUntil(() => viewer.get_transient_for() === parent, 3),
        'Image viewer did not restore its parent after fullscreen');
    assert(viewer._handleKey(Gdk.KEY_F11, 0) === true,
        'F11 did not activate the image viewer fullscreen action');
    assert(viewer.get_transient_for() === null,
        'F11 fullscreen did not detach the viewer from its parent workspace');
    viewer._leaveFullscreen();
    assert(runUntil(() => viewer.get_transient_for() === parent, 3),
        'Cancelling fullscreen did not restore the image viewer parent');

    viewer._infoButton.set_active(true);
    viewer._setNarrowLayout(true);
    assert(viewer._bottomSheet?.get_open(), 'The narrow image-information sheet did not open');
    viewer._setNarrowLayout(false);
    assert(viewer._infoButton.get_active() && viewer._splitView.get_show_sidebar(),
        'Returning to a wide layout desynchronized the information toggle and sidebar');
    viewer._infoButton.set_active(false);

    await viewer._requestEditMode('draw');
    assert(viewer._mode === 'draw' && viewer._splitView.get_show_sidebar(),
        'Draw mode did not open its editor sidebar');
    const expectedToolIcons = new Map([
        ['select', 'tool-select-symbolic'],
        ['pencil', 'document-edit-symbolic'],
        ['line', 'tool-line-symbolic'],
        ['arrow', 'tool-arrow-symbolic'],
        ['rectangle', 'tool-rectangle-symbolic'],
        ['ellipse', 'tool-ellipse-symbolic'],
        ['text', 'tool-text-symbolic'],
    ]);
    for (const [tool, expectedIcon] of expectedToolIcons) {
        const toolButton = viewer._toolButtons.get(tool);
        const iconName = toolButton.get_icon_name() ?? toolButton.get_child()?.get_icon_name();
        assert(iconName === expectedIcon && !toolButton.get_label(),
            `${tool} is not an icon-only annotation tool button`);
    }
    assert(viewer._colorButtons.length === 12
        && viewer._sizeButtons.length === 4,
    'Draw controls did not expose the compact preset palette and sizes');
    assert(viewer._saveMenuButton.get_label() === 'Save'
        && !viewer._saveMenuButton.get_icon_name()
        && !viewer._saveMenuButton.has_css_class('pill'),
    'The editor Save action is not a compact text-only button');
    viewer._document.select(null);
    viewer._syncSelectionControls();
    assert(!viewer._objectActions.get_visible(),
        'Duplicate and Delete were visible without a selected annotation');
    assert(viewer._objectActions.get_homogeneous()
        && viewer._objectActions.get_hexpand()
        && viewer._duplicateButton.get_hexpand()
        && viewer._deleteButton.get_hexpand(),
    'Selection actions do not fill an equal-width row');
    assert(viewer._duplicateButton.get_label() === 'Duplicate'
        && viewer._deleteButton.get_label() === 'Delete'
        && !viewer._duplicateButton.get_icon_name()
        && !viewer._deleteButton.get_icon_name()
        && viewer._duplicateButton.has_css_class('suggested-action')
        && viewer._deleteButton.has_css_class('destructive-action')
        && !viewer._duplicateButton.has_css_class('flat')
        && !viewer._deleteButton.has_css_class('flat'),
    'Selection actions are not colored text buttons');

    const geometry = viewer._viewGeometry();
    const canvasX = geometry.x + geometry.width * geometry.scale * 0.25;
    const canvasY = geometry.y + geometry.height * geometry.scale * 0.25;

    viewer._activateTool('text');
    viewer._dragBegin(canvasX, canvasY, false, viewer._primaryDragGesture);
    assert(viewer._inlineTextState && viewer._document.inTransaction,
        'Adding text did not open the in-canvas text editor');
    const inlineEntry = viewer._inlineTextState.entry;
    inlineEntry.grab_focus();
    assert(viewer._handleKey(Gdk.KEY_minus, 0) === false,
        'The capture-phase shortcut handler stole in-canvas text punctuation');
    inlineEntry.set_text('Edited on image');
    inlineEntry.emit('activate');
    const textAnnotation = viewer._document.selectedAnnotation;
    assert(!viewer._inlineTextState
        && textAnnotation?.type === 'text'
        && textAnnotation.text === 'Edited on image'
        && viewer._tool === 'select'
        && viewer._toolButtons.get('select').get_active(),
    'Finishing new in-canvas text did not commit it and return to Select');
    viewer._beginInlineTextEdit(textAnnotation);
    assert(!viewer._undoButton.get_sensitive(),
        'Undo remained enabled while an in-canvas text transaction was open');
    viewer._inlineTextState.entry.set_text('Edited again');
    viewer._finishInlineTextEdit();
    assert(viewer._document.selectedAnnotation?.text === 'Edited again',
        'Existing text could not be edited directly on the image');
    viewer._document.deleteAnnotation(textAnnotation.id);
    viewer._afterDocumentChange();

    const annotationCountBeforeClickAway = viewer._document.annotations.length;
    viewer._activateTool('text');
    viewer._dragBegin(canvasX, canvasY, false, viewer._primaryDragGesture);
    const clickAwayTextId = viewer._inlineTextState.annotationId;
    viewer._inlineTextState.entry.set_text('Committed by click away');
    viewer._dragBegin(
        geometry.x + geometry.width * geometry.scale * 0.8,
        geometry.y + geometry.height * geometry.scale * 0.8,
        false,
        viewer._primaryDragGesture,
    );
    assert(!viewer._inlineTextState
        && !viewer._document.inTransaction
        && viewer._document.annotations.length === annotationCountBeforeClickAway + 1
        && viewer._tool === 'select',
    'Clicking away from in-canvas text left an open transaction or added another element');
    viewer._document.deleteAnnotation(clickAwayTextId);
    viewer._afterDocumentChange();

    viewer._activateTool('line');
    viewer._dragBegin(canvasX, canvasY, false, viewer._primaryDragGesture);
    viewer._dragEnd(36, 24, viewer._primaryDragGesture);
    const drawnLine = viewer._document.selectedAnnotation;
    assert(drawnLine?.type === 'line'
        && viewer._tool === 'select'
        && viewer._toolButtons.get('select').get_active(),
        'Completing a new annotation did not return to Select');
    assert(viewer._objectActions.get_visible(),
        'Selection actions were not shown for the new annotation');
    viewer._document.deleteAnnotation(drawnLine.id);
    viewer._afterDocumentChange();

    const selectionSurface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 96, 64);
    const selectionContext = new Cairo.Context(selectionSurface);
    viewer._drawSelection(selectionContext, viewer._viewGeometry(96, 64));
    selectionContext.$dispose();
    selectionSurface.finish();
    viewer._document.addAnnotation(createAnnotation('arrow', {
        start: { x: 0.1, y: 0.2 },
        end: { x: 0.8, y: 0.7 },
        strokeColor: '#ffffff',
    }));
    viewer._afterDocumentChange();
    assert(viewer._document.dirty, 'UI annotation did not mark the document dirty');

    assert(typeof viewer.get_clipboard().set === 'function',
        'The display clipboard does not expose the generic GDK setter');
    const styledRectangle = viewer._document.addAnnotation(createAnnotation('rectangle', {
        rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.25 },
        strokeColor: '#ff0000',
        strokeWidth: 0.012,
        fillColor: '#00ff00',
        opacity: 1,
    }));
    viewer._afterDocumentChange();
    assert(viewer._strokeColor === '#ff0000' && viewer._strokeWidth === 0.012,
        'Selecting an annotation did not hydrate its style controls');
    viewer._strokeColor = '#0000ff';
    viewer._strokeWidth = 0.0025;
    viewer._updateSelectedStyle({ opacity: 0.5 });
    const restyledRectangle = viewer._document.annotations.find(item => item.id === styledRectangle.id);
    assert(restyledRectangle.strokeColor === '#ff0000' && restyledRectangle.strokeWidth === 0.012,
        'Changing opacity overwrote unrelated selected-annotation styles');

    const annotationCountBeforeCancel = viewer._document.annotations.length;
    viewer._document.beginTransaction('Cancelled pointer gesture');
    viewer._document.addAnnotation(createAnnotation('line', {
        start: { x: 0.1, y: 0.1 },
        end: { x: 0.4, y: 0.4 },
    }));
    viewer._dragState = { type: 'draw' };
    viewer._dragOwner = viewer._primaryDragGesture;
    viewer._cancelDrag(viewer._panDragGesture);
    assert(viewer._document.inTransaction,
        'A non-owning gesture cancelled the active drawing transaction');
    viewer._cancelDrag(viewer._primaryDragGesture);
    assert(!viewer._document.inTransaction
        && viewer._document.annotations.length === annotationCountBeforeCancel,
    'Cancelling a drawing gesture left stale state or committed partial work');

    viewer._cropRatio = 1;
    viewer._cropPortrait = true;
    viewer._switchEditMode('crop');
    assert(viewer._mode === 'crop', 'Editor could not switch from Draw to Crop');
    assert(viewer._cropRatioButtons.get('Square').get_active()
        && viewer._cropPortraitButton.get_active(),
    'Crop controls did not reflect their persisted ratio and orientation');
    viewer._updateCropDrag({
        type: 'crop-new',
        handle: null,
        start: { x: 0.1, y: 0.1 },
        originalRect: { x: 0.1, y: 0.1, width: 0.01, height: 0.01 },
    }, { x: 0.3, y: 0.2 });
    assert(Math.abs(
        viewer._cropRect.width * viewer._document.width
        - viewer._cropRect.height * viewer._document.height,
    ) < 0.001, 'A new square crop gesture did not remain square');
    const cropBeforeMove = { ...viewer._cropRect };
    viewer._updateCropDrag({
        type: 'crop-move',
        handle: null,
        start: { x: 0.2, y: 0.2 },
        originalRect: cropBeforeMove,
    }, { x: 0.05, y: 0.04 });
    assert(viewer._cropRect.width === cropBeforeMove.width
        && viewer._cropRect.height === cropBeforeMove.height,
    'Moving a crop selection recalculated its size and caused snapping');
    viewer._setNarrowLayout(true);
    assert(viewer._bottomSheet?.get_sheet() === viewer._sidebarScroller
        && viewer._bottomSheet.get_open(),
    'Narrow editing did not move the controls into an open bottom sheet');
    viewer._setNarrowLayout(false);

    viewer._document.select(null);
    viewer._strokeWidth = 0.022;
    viewer._switchEditMode('draw');
    assert(viewer._sizeButtons[3].get_active(),
        'Draw mode did not preserve the selected thickness');
    assert(viewer._document.annotations.length === 2, 'Switching editor modes discarded annotations');

    await viewer._saveAndAttach();
    assert(attachedPath && GLib.file_test(attachedPath, GLib.FileTest.EXISTS),
        'Save & Add did not provide a durable PNG to the attachment callback');
    assert(GLib.path_get_dirname(attachedPath) === managedDirectory,
        'Save & Add ignored the managed output directory');

    parent.destroy();
    removeTree(root);
    print('Cusco image editor window smoke passed');
} else {
    print('Cusco image editor window smoke skipped: no display');
}
