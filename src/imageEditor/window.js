import Cairo from 'cairo';
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { createBundledIcon } from '../bundledIcons.js';
import * as DocumentModel from './document.js';
import * as ImageRenderer from './renderer.js';

const { ImageDocument } = DocumentModel;

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 12;
const CANVAS_PADDING = 24;
const HANDLE_SIZE = 9;
const CROP_MIN_SIZE = 0.01;
const NARROW_WIDTH = 760;
const MAX_PREVIEW_DIMENSION = 1600;
const FULLSCREEN_REQUEST_TIMEOUT_MS = 2000;
const CROP_ICON_FILE = 'crop-symbolic.svg';

const TOOL_LABELS = [
    ['select', 'Select'],
    ['pencil', 'Pencil'],
    ['line', 'Line'],
    ['arrow', 'Arrow'],
    ['rectangle', 'Rectangle'],
    ['ellipse', 'Ellipse'],
    ['text', 'Text'],
];

const TOOL_ICONS = {
    select: { file: 'tool-select-symbolic.svg', fallback: 'edit-select-symbolic' },
    pencil: { name: 'document-edit-symbolic' },
    line: { file: 'tool-line-symbolic.svg', fallback: 'list-remove-symbolic' },
    arrow: { file: 'tool-arrow-symbolic.svg', fallback: 'go-next-symbolic' },
    rectangle: { file: 'tool-rectangle-symbolic.svg', fallback: 'view-grid-symbolic' },
    ellipse: { file: 'tool-ellipse-symbolic.svg', fallback: 'media-record-symbolic' },
    text: { file: 'tool-text-symbolic.svg', fallback: 'insert-text-symbolic' },
};

const THICKNESSES = [
    ['Thin', 0.0025],
    ['Medium', 0.006],
    ['Thick', 0.012],
    ['Extra Thick', 0.022],
];

const TEXT_SIZES = [
    ['S', 0.03],
    ['M', 0.045],
    ['L', 0.06],
    ['XL', 0.09],
];

const PRESET_COLORS = [
    ['Black', '#1c1c1c'],
    ['Gray', '#9aa6b2'],
    ['Lavender', '#d56ef2'],
    ['Purple', '#b635c8'],
    ['Blue', '#3b5bdb'],
    ['Sky Blue', '#4a9ee8'],
    ['Amber', '#f4ab49'],
    ['Orange', '#e45a17'],
    ['Teal', '#07996f'],
    ['Green', '#49b568'],
    ['Coral', '#f47476'],
    ['Red', '#e52f36'],
];

const CROP_RATIOS = [
    ['Free', null],
    ['Original', 'original'],
    ['Square', 1],
    ['5:4', 5 / 4],
    ['4:3', 4 / 3],
    ['3:2', 3 / 2],
    ['16:9', 16 / 9],
];

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function closestValueIndex(items, value) {
    const requested = Number(value);
    let bestIndex = 0;

    for (let index = 1; index < items.length; index++) {
        if (Math.abs(items[index][1] - requested)
            < Math.abs(items[bestIndex][1] - requested)) {
            bestIndex = index;
        }
    }

    return bestIndex;
}

function normalizedRect(start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);

    return {
        x,
        y,
        width: Math.max(0.001, Math.abs(end.x - start.x)),
        height: Math.max(0.001, Math.abs(end.y - start.y)),
    };
}

function rgbaFromString(value, fallback = '#e01b24') {
    const rgba = new Gdk.RGBA();

    if (!rgba.parse(String(value ?? '')))
        rgba.parse(fallback);

    return rgba;
}

function colorComponents(value, fallback = [0.88, 0.11, 0.14, 1]) {
    const rgba = rgbaFromString(value);

    if (!rgba)
        return fallback;

    return [rgba.red, rgba.green, rgba.blue, rgba.alpha];
}

function closestPresetColorIndex(value) {
    const [red, green, blue] = colorComponents(value);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    PRESET_COLORS.forEach(([, candidate], index) => {
        const [candidateRed, candidateGreen, candidateBlue] = colorComponents(candidate);
        const distance = (red - candidateRed) ** 2
            + (green - candidateGreen) ** 2
            + (blue - candidateBlue) ** 2;

        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });

    return bestIndex;
}

function createColorSwatch(color) {
    const swatch = new Gtk.DrawingArea({
        content_width: 22,
        content_height: 22,
        accessible_role: Gtk.AccessibleRole.PRESENTATION,
    });
    const [red, green, blue, alpha] = colorComponents(color);

    swatch.set_draw_func((_area, cr, width, height) => {
        const radius = Math.max(1, Math.min(width, height) / 2 - 2);

        cr.setSourceRGBA(red, green, blue, alpha);
        cr.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
        cr.fill();
    });
    return swatch;
}

function basenameWithoutExtension(path) {
    const basename = GLib.path_get_basename(String(path ?? 'image'));
    const dot = basename.lastIndexOf('.');

    return dot > 0 ? basename.slice(0, dot) : basename;
}

function ensurePngExtension(path) {
    const normalized = String(path ?? '').trim();

    return normalized.toLowerCase().endsWith('.png') ? normalized : `${normalized}.png`;
}

function isEditableFocus(widget) {
    for (let current = widget; current; current = current.get_parent?.()) {
        if (current instanceof Gtk.Entry
            || current instanceof Gtk.Text
            || current instanceof Gtk.SpinButton
            || current instanceof Gtk.TextView) {
            return true;
        }
    }

    return false;
}

function isCancellation(error) {
    return Boolean(
        error?.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED)
        || error?.matches?.(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED)
        || error?.matches?.(Gtk.dialog_error_quark(), Gtk.DialogError.CANCELLED),
    );
}

function currentTimeValue() {
    const value = new GLib.TimeVal();
    GLib.get_current_time(value);
    return value;
}

function button(options = {}) {
    const widget = new Gtk.Button(options);

    widget.add_css_class('flat');
    return widget;
}

function sectionLabel(text) {
    const label = new Gtk.Label({
        label: text,
        xalign: 0,
        margin_top: 8,
    });
    label.add_css_class('heading');
    return label;
}

function propertyRow(title, value, selectable = false) {
    const row = new Adw.ActionRow({ title, subtitle: String(value ?? '') });

    if (selectable) {
        const label = new Gtk.Label({
            label: String(value ?? ''),
            selectable: true,
            wrap: true,
            xalign: 1,
            max_width_chars: 32,
        });
        label.add_css_class('caption');
        row.set_subtitle('');
        row.add_suffix(label);
    }

    return row;
}

function annotationBounds(annotation) {
    if (!annotation || !DocumentModel.ANNOTATION_TYPES?.includes(annotation.type))
        return null;

    if (DocumentModel.getAnnotationBounds)
        return DocumentModel.getAnnotationBounds(annotation, { includeStroke: true });

    if (annotation?.rect)
        return { ...annotation.rect };

    if (annotation?.start && annotation?.end)
        return normalizedRect(annotation.start, annotation.end);

    const points = annotation?.points ?? [];

    if (points.length > 0) {
        const xs = points.map(point => point.x);
        const ys = points.map(point => point.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);

        return {
            x,
            y,
            width: Math.max(0.001, Math.max(...xs) - x),
            height: Math.max(0.001, Math.max(...ys) - y),
        };
    }

    return null;
}

function resizeHandles(bounds) {
    if (DocumentModel.getResizeHandles)
        return DocumentModel.getResizeHandles(bounds);

    const { x, y, width, height } = bounds;

    return [
        { handle: 'nw', point: { x, y } },
        { handle: 'n', point: { x: x + width / 2, y } },
        { handle: 'ne', point: { x: x + width, y } },
        { handle: 'e', point: { x: x + width, y: y + height / 2 } },
        { handle: 'se', point: { x: x + width, y: y + height } },
        { handle: 's', point: { x: x + width / 2, y: y + height } },
        { handle: 'sw', point: { x, y: y + height } },
        { handle: 'w', point: { x, y: y + height / 2 } },
    ];
}

function hitAnnotations(annotations, point, tolerance) {
    if (DocumentModel.hitTestAnnotations)
        return DocumentModel.hitTestAnnotations(annotations, point, { tolerance });

    for (let index = annotations.length - 1; index >= 0; index--) {
        const annotation = annotations[index];
        const bounds = annotationBounds(annotation);

        if (bounds
            && point.x >= bounds.x - tolerance
            && point.x <= bounds.x + bounds.width + tolerance
            && point.y >= bounds.y - tolerance
            && point.y <= bounds.y + bounds.height + tolerance) {
            return annotation;
        }
    }

    return null;
}

function fileSizeLabel(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            Gio.FILE_ATTRIBUTE_STANDARD_SIZE,
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
        const bytes = Number(info.get_size());

        if (bytes >= 1024 * 1024)
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        if (bytes >= 1024)
            return `${(bytes / 1024).toFixed(1)} KB`;
        return `${bytes} bytes`;
    } catch (_error) {
        return 'Unknown';
    }
}

export const ImageViewerWindow = GObject.registerClass({
    GTypeName: 'CuscoImageViewerWindow',
}, class ImageViewerWindow extends Adw.Window {
    _init(options = {}) {
        const parent = options.parent ?? null;
        const image = options.image ?? {};

        super._init({
            transient_for: parent,
            destroy_with_parent: true,
            modal: false,
            title: String(image.title ?? GLib.path_get_basename(image.path ?? '') ?? 'Image'),
            default_width: 1040,
            default_height: 720,
        });

        this._parentWindow = parent;
        this._image = {
            path: String(image.path ?? ''),
            title: String(image.title ?? GLib.path_get_basename(image.path ?? '') ?? 'Image'),
            mimeType: String(image.mimeType ?? ''),
            sourceKind: String(image.sourceKind ?? 'image'),
        };
        this._getAttachCapability = options.getAttachCapability ?? (() => ({ allowed: true, reason: '' }));
        this._onAttach = options.onAttach ?? (() => true);
        this._editedImageDirectory = options.editedImageDirectory ?? null;
        this._source = null;
        this._previewPixbuf = null;
        this._document = null;
        this._renderSurface = null;
        this._surfaceDirty = true;
        this._renderError = null;
        this._mode = 'view';
        this._tool = 'select';
        this._strokeColor = '#e52f36';
        this._fillColor = '#e52f36';
        this._fillEnabled = false;
        this._strokeWidth = THICKNESSES[1][1];
        this._opacity = 1;
        this._text = 'Text';
        this._fontSize = 0.06;
        this._zoomFactor = 1;
        this._fit = true;
        this._panX = 0;
        this._panY = 0;
        this._dragState = null;
        this._dragOwner = null;
        this._inlineTextState = null;
        this._inlineTextFocusSourceId = 0;
        this._cropRect = { x: 0, y: 0, width: 1, height: 1 };
        this._cropRatio = null;
        this._cropPortrait = false;
        this._conversionAccepted = false;
        this._editBaseline = null;
        this._busy = false;
        this._allowClose = false;
        this._narrowLayout = false;
        this._syncingStyleControls = false;
        this._loadCancellable = new Gio.Cancellable();
        this._animationIter = null;
        this._animationSourceId = 0;
        this._fullscreenTransientParent = null;
        this._fullscreenRequestSourceId = 0;

        this._buildUi();
        this._installControllers();
        this.connect('notify::width', () => {
            this._syncAdaptiveLayout();
            this._positionInlineTextEditor();
        });
        this.connect('notify::height', () => this._positionInlineTextEditor());
        this.connect('notify::fullscreened', () => this._syncFullscreenState());
        this.connect('close-request', () => this._onCloseRequest());
        this.connect('destroy', () => this._disposeResources());
        this._syncAdaptiveLayout();
        this._load();
    }

    _buildUi() {
        this._drawingArea = new Gtk.DrawingArea({
            hexpand: true,
            vexpand: true,
            focusable: true,
            accessible_role: Gtk.AccessibleRole.IMG,
        });
        this._drawingArea.set_tooltip_text(`Image viewer: ${this._image.title}`);
        this._drawingArea.add_css_class('cusco-image-editor-canvas');
        this._drawingArea.set_content_width(640);
        this._drawingArea.set_content_height(420);
        this._drawingArea.set_draw_func((area, cr, width, height) => this._drawCanvas(area, cr, width, height));
        this._drawingArea.connect('notify::width', () => this._positionInlineTextEditor());
        this._drawingArea.connect('notify::height', () => this._positionInlineTextEditor());

        this._canvasOverlay = new Gtk.Overlay({ child: this._drawingArea });
        this._canvasOverlay.add_css_class('cusco-image-editor-surface');

        this._statusBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });
        this._spinner = new Adw.Spinner({ width_request: 32, height_request: 32 });
        this._statusLabel = new Gtk.Label({
            label: 'Loading image…',
            wrap: true,
            max_width_chars: 52,
            justify: Gtk.Justification.CENTER,
        });
        this._statusBox.append(this._spinner);
        this._statusBox.append(this._statusLabel);
        this._canvasOverlay.add_overlay(this._statusBox);

        this._zoomControls = this._createZoomControls();
        this._canvasOverlay.add_overlay(this._zoomControls);

        this._sidebarScroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_width: 280,
            max_content_width: 360,
            max_content_height: 560,
            propagate_natural_height: true,
        });
        this._sidebarScroller.add_css_class('background');
        this._sidebarScroller.add_css_class('cusco-image-editor-sidebar');

        this._splitView = new Adw.OverlaySplitView({
            content: this._canvasOverlay,
            sidebar: this._sidebarScroller,
            sidebar_position: Gtk.PackType.END,
            show_sidebar: false,
            pin_sidebar: true,
            enable_show_gesture: true,
            enable_hide_gesture: true,
        });
        this._splitView.set_min_sidebar_width(280);
        this._splitView.set_max_sidebar_width(380);
        this._splitView.set_sidebar_width_fraction(0.32);

        this._bottomSheet = Adw.BottomSheet ? new Adw.BottomSheet({
            content: this._splitView,
            can_open: true,
            can_close: true,
            full_width: true,
            modal: true,
            show_drag_handle: true,
        }) : null;
        this._bottomSheet?.connect('notify::open', () => {
            if (!this._narrowLayout || this._mode !== 'view' || !this._infoButton)
                return;
            const open = this._bottomSheet.get_open();
            if (this._infoButton.get_active() !== open)
                this._infoButton.set_active(open);
        });

        this._toolbarView = new Adw.ToolbarView();
        this._toolbarView.set_content(this._bottomSheet ?? this._splitView);
        this._viewHeader = this._createViewHeader();
        this._toolbarView.add_top_bar(this._viewHeader);
        this._currentHeader = this._viewHeader;

        this._toastOverlay = new Adw.ToastOverlay({ child: this._toolbarView });
        this.set_content(this._toastOverlay);
    }

    _createViewHeader() {
        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        });
        header.add_css_class('cusco-image-viewer-header');

        this._fullscreenButton = button({
            icon_name: 'view-fullscreen-symbolic',
            tooltip_text: 'Enter Fullscreen (F11)',
        });
        this._fullscreenButton.connect('clicked', () => this._toggleFullscreen());
        header.pack_start(this._fullscreenButton);
        header.set_title_widget(new Adw.WindowTitle({ title: this._image.title }));

        this._drawButton = button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: 'Draw and Annotate',
        });
        this._drawButton.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Draw and Annotate'],
        );
        this._drawButton.connect('clicked', () => this._requestEditMode('draw'));

        this._cropButton = button({ tooltip_text: 'Crop, Rotate, or Flip' });
        this._cropButton.set_child(createBundledIcon(CROP_ICON_FILE, 'edit-select-symbolic'));
        this._cropButton.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Crop, Rotate, or Flip'],
        );
        this._cropButton.connect('clicked', () => this._requestEditMode('crop'));

        this._infoButton = new Gtk.ToggleButton({
            icon_name: 'dialog-information-symbolic',
            tooltip_text: 'Image Information',
        });
        this._infoButton.add_css_class('flat');
        this._infoButton.connect('toggled', () => {
            if (this._mode !== 'view')
                return;
            this._sidebarScroller.set_child(this._createInfoSidebar());
            this._setSidebarVisible(this._infoButton.get_active());
        });

        this._overflowButton = this._createOverflowMenu();

        const closeButton = button({
            icon_name: 'window-close-symbolic',
            tooltip_text: 'Close',
        });
        closeButton.connect('clicked', () => this.close());
        const endControls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
        });
        endControls.append(this._drawButton);
        endControls.append(this._cropButton);
        endControls.append(this._infoButton);
        endControls.append(this._overflowButton);
        endControls.append(closeButton);
        header.pack_end(endControls);
        return header;
    }

    _createEditHeader() {
        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        });
        header.add_css_class('cusco-image-editor-header');
        const cancel = button({ label: 'Cancel', tooltip_text: 'Discard this editing session' });
        cancel.connect('clicked', () => this._leaveEditMode({ discard: true }));
        header.pack_start(cancel);
        header.set_title_widget(new Adw.WindowTitle({
            title: this._image.title,
            subtitle: this._mode === 'crop' ? 'Crop and transform' : 'Draw and annotate',
        }));

        this._undoButton = button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Undo (Ctrl+Z)',
        });
        this._undoButton.connect('clicked', () => this._undo());
        header.pack_end(this._undoButton);

        this._redoButton = button({
            icon_name: 'edit-redo-symbolic',
            tooltip_text: 'Redo (Ctrl+Shift+Z)',
        });
        this._redoButton.connect('clicked', () => this._redo());
        header.pack_end(this._redoButton);

        this._saveMenuButton = this._createSaveMenu();
        header.pack_end(this._saveMenuButton);
        this._syncUndoRedo();
        return header;
    }

    _createOverflowMenu() {
        const menuButton = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            tooltip_text: 'Image Actions',
        });
        menuButton.add_css_class('flat');
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const actions = [
            ['Copy Path', () => this._copyPath()],
            ['Copy Image', () => this._copyImage()],
            ['Show in Files', () => this._showInFiles()],
            ['Open with Default App', () => this._openExternally()],
        ];

        for (const [label, callback] of actions) {
            const action = new Gtk.Button({ label, halign: Gtk.Align.FILL });
            action.add_css_class('flat');
            action.connect('clicked', () => {
                menuButton.popdown();
                callback();
            });
            box.append(action);
        }

        menuButton.set_popover(new Gtk.Popover({ child: box }));
        return menuButton;
    }

    _createSaveMenu() {
        const menuButton = new Gtk.MenuButton({
            label: 'Save',
            tooltip_text: 'Save Image',
        });
        menuButton.add_css_class('suggested-action');
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });
        const saveCopy = new Gtk.Button({ label: 'Save a Copy…' });
        saveCopy.connect('clicked', () => {
            menuButton.popdown();
            this._saveCopy();
        });
        box.append(saveCopy);
        this._saveAttachButton = new Gtk.Button({ label: 'Save & Add to Chat' });
        this._saveAttachButton.add_css_class('suggested-action');
        this._saveAttachButton.connect('clicked', () => {
            menuButton.popdown();
            this._saveAndAttach();
        });
        box.append(this._saveAttachButton);
        this._attachReasonLabel = new Gtk.Label({
            wrap: true,
            max_width_chars: 34,
            xalign: 0,
            visible: false,
        });
        this._attachReasonLabel.add_css_class('caption');
        this._attachReasonLabel.add_css_class('dim-label');
        box.append(this._attachReasonLabel);
        const popover = new Gtk.Popover({ child: box });
        popover.connect('show', () => this._syncAttachCapability());
        menuButton.set_popover(popover);
        this._syncAttachCapability();
        return menuButton;
    }

    _createZoomControls() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 2,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.END,
            margin_bottom: 16,
        });
        box.add_css_class('toolbar');
        box.add_css_class('osd');
        box.add_css_class('linked');
        const zoomOut = button({ icon_name: 'zoom-out-symbolic', tooltip_text: 'Zoom Out' });
        zoomOut.connect('clicked', () => this._zoomBy(1 / 1.25));
        box.append(zoomOut);
        this._zoomLabel = new Gtk.Button({ label: 'Fit', tooltip_text: 'Actual Size (100%)' });
        this._zoomLabel.add_css_class('flat');
        this._zoomLabel.connect('clicked', () => this._setActualSize());
        box.append(this._zoomLabel);
        const zoomIn = button({ icon_name: 'zoom-in-symbolic', tooltip_text: 'Zoom In' });
        zoomIn.connect('clicked', () => this._zoomBy(1.25));
        box.append(zoomIn);
        const fit = button({ icon_name: 'zoom-fit-best-symbolic', tooltip_text: 'Fit to Window' });
        fit.connect('clicked', () => this._fitImage());
        box.append(fit);
        return box;
    }

    _createInfoSidebar() {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        content.append(sectionLabel('Image Information'));
        const source = this._source;
        content.append(propertyRow('Dimensions', source ? `${source.width} × ${source.height}` : 'Loading…'));
        content.append(propertyRow('Format', source?.formatName ?? this._image.mimeType ?? 'Unknown'));
        content.append(propertyRow('File Size', fileSizeLabel(this._image.path)));
        content.append(propertyRow('Source', this._image.sourceKind));
        content.append(propertyRow('Path', this._image.path, true));

        if (source?.isAnimated)
            content.append(propertyRow('Animation', 'Displayed frame; editing exports a static PNG'));
        if (source?.isVector)
            content.append(propertyRow('Vector Image', 'Editing exports a raster PNG'));

        return content;
    }

    _createDrawSidebar() {
        const content = this._sidebarContainer();
        content.add_css_class('cusco-image-draw-controls');
        const toolGrid = new Gtk.Grid({
            column_spacing: 6,
            row_spacing: 6,
            column_homogeneous: true,
        });
        this._toolButtons = new Map();
        let group = null;

        TOOL_LABELS.forEach(([tool, label], index) => {
            const icon = TOOL_ICONS[tool];
            const toggle = new Gtk.ToggleButton({
                ...(icon?.name ? { icon_name: icon.name } : {}),
                tooltip_text: label,
                active: this._tool === tool,
            });
            if (icon?.file)
                toggle.set_child(createBundledIcon(icon.file, icon.fallback));
            toggle.update_property(
                [Gtk.AccessibleProperty.LABEL],
                [label],
            );
            toggle.add_css_class('flat');
            if (group)
                toggle.set_group(group);
            else
                group = toggle;
            toggle.connect('toggled', () => {
                if (!toggle.get_active())
                    return;
                this._activateTool(tool);
            });
            this._toolButtons.set(tool, toggle);
            toggle.add_css_class('cusco-image-tool-button');
            toolGrid.attach(toggle, index % 4, Math.floor(index / 4), 1, 1);
        });
        toolGrid.add_css_class('cusco-image-tool-grid');
        content.append(toolGrid);

        const colorGrid = new Gtk.Grid({
            column_spacing: 4,
            row_spacing: 4,
            column_homogeneous: true,
            margin_top: 8,
        });
        colorGrid.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Annotation color'],
        );
        this._colorButtons = [];
        let colorGroup = null;

        PRESET_COLORS.forEach(([name, color], index) => {
            const colorButton = new Gtk.ToggleButton({
                child: createColorSwatch(color),
                tooltip_text: name,
                active: index === closestPresetColorIndex(this._strokeColor),
            });
            colorButton.add_css_class('flat');
            colorButton.add_css_class('cusco-image-color-swatch-button');
            colorButton.update_property(
                [Gtk.AccessibleProperty.LABEL],
                [name],
            );
            if (colorGroup)
                colorButton.set_group(colorGroup);
            else
                colorGroup = colorButton;
            colorButton.connect('toggled', () => {
                if (!colorButton.get_active() || this._syncingStyleControls)
                    return;
                this._strokeColor = color;
                this._fillColor = color;
                this._updateSelectedStyle({
                    strokeColor: color,
                    ...(this._fillEnabled ? { fillColor: color } : {}),
                });
            });
            this._colorButtons.push(colorButton);
            colorGrid.attach(colorButton, index % 4, Math.floor(index / 4), 1, 1);
        });
        content.append(colorGrid);

        const sizeRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            margin_top: 8,
        });
        sizeRow.add_css_class('linked');
        sizeRow.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Annotation size'],
        );
        this._sizeButtons = [];
        let sizeGroup = null;

        TEXT_SIZES.forEach(([label], index) => {
            const sizeButton = new Gtk.ToggleButton({ label });
            if (sizeGroup)
                sizeButton.set_group(sizeGroup);
            else
                sizeGroup = sizeButton;
            sizeButton.connect('toggled', () => {
                if (!sizeButton.get_active() || this._syncingStyleControls)
                    return;

                if (this._activeDrawType() === 'text') {
                    this._fontSize = TEXT_SIZES[index][1];
                    this._updateSelectedStyle({ fontSize: this._fontSize });
                } else {
                    this._strokeWidth = THICKNESSES[index][1];
                    this._updateSelectedStyle({ strokeWidth: this._strokeWidth });
                }
            });
            this._sizeButtons.push(sizeButton);
            sizeRow.append(sizeButton);
        });
        content.append(sizeRow);

        this._fillControls = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        this._fillSwitch = new Gtk.Switch({ active: this._fillEnabled, valign: Gtk.Align.CENTER });
        const fillLabel = new Gtk.Label({ label: 'Fill', xalign: 0, hexpand: true });
        this._fillControls.append(fillLabel);
        this._fillControls.append(this._fillSwitch);
        this._fillSwitch.connect('notify::active', () => {
            if (this._syncingStyleControls)
                return;
            this._fillEnabled = this._fillSwitch.get_active();
            this._fillColor = this._strokeColor;
            this._updateSelectedStyle({
                fillColor: this._fillEnabled ? this._fillColor : null,
            });
        });
        content.append(this._fillControls);

        this._objectActions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            homogeneous: true,
            hexpand: true,
            margin_top: 8,
        });
        this._duplicateButton = button({
            label: 'Duplicate',
            hexpand: true,
            tooltip_text: 'Duplicate Selection',
        });
        this._duplicateButton.remove_css_class('flat');
        this._duplicateButton.add_css_class('suggested-action');
        this._duplicateButton.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Duplicate Selection'],
        );
        this._duplicateButton.connect('clicked', () => {
            this._finishInlineTextEdit({ restoreFocus: false });
            this._document?.duplicateAnnotation();
            this._activateTool('select');
            this._afterDocumentChange();
        });
        this._objectActions.append(this._duplicateButton);
        this._deleteButton = button({
            label: 'Delete',
            hexpand: true,
            tooltip_text: 'Delete Selection',
        });
        this._deleteButton.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Delete Selection'],
        );
        this._deleteButton.remove_css_class('flat');
        this._deleteButton.add_css_class('destructive-action');
        this._deleteButton.connect('clicked', () => this._deleteSelection());
        this._objectActions.append(this._deleteButton);
        content.append(this._objectActions);
        this._syncDrawControlVisibility();
        this._syncSelectionControls();
        return content;
    }

    _createCropSidebar() {
        const content = this._sidebarContainer();
        content.append(sectionLabel('Aspect Ratio'));
        const grid = new Gtk.Grid({
            column_spacing: 6,
            row_spacing: 6,
            column_homogeneous: true,
        });
        this._cropRatioButtons = new Map();
        let group = null;

        CROP_RATIOS.forEach(([label, ratio], index) => {
            const toggle = new Gtk.ToggleButton({
                label,
                active: ratio === this._cropRatio,
            });
            if (group)
                toggle.set_group(group);
            else
                group = toggle;
            toggle.connect('toggled', () => {
                if (!toggle.get_active())
                    return;
                this._cropRatio = ratio;
                this._resetCropForRatio();
            });
            this._cropRatioButtons.set(label, toggle);
            grid.attach(toggle, index % 2, Math.floor(index / 2), 1, 1);
        });
        content.append(grid);

        const orientationBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            homogeneous: true,
            margin_top: 6,
        });
        const landscape = new Gtk.ToggleButton({
            label: 'Landscape',
            active: !this._cropPortrait,
        });
        const portrait = new Gtk.ToggleButton({
            label: 'Portrait',
            active: this._cropPortrait,
            group: landscape,
        });
        this._cropLandscapeButton = landscape;
        this._cropPortraitButton = portrait;
        landscape.connect('toggled', () => {
            if (landscape.get_active()) {
                this._cropPortrait = false;
                this._resetCropForRatio();
            }
        });
        portrait.connect('toggled', () => {
            if (portrait.get_active()) {
                this._cropPortrait = true;
                this._resetCropForRatio();
            }
        });
        orientationBox.append(landscape);
        orientationBox.append(portrait);
        content.append(orientationBox);

        content.append(sectionLabel('Rotate'));
        const rotate = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, homogeneous: true });
        const rotateLeft = new Gtk.Button({ icon_name: 'object-rotate-left-symbolic', tooltip_text: 'Rotate Left' });
        rotateLeft.connect('clicked', () => this._transformDocument(() => this._document.rotate(-1)));
        rotate.append(rotateLeft);
        const rotateRight = new Gtk.Button({ icon_name: 'object-rotate-right-symbolic', tooltip_text: 'Rotate Right' });
        rotateRight.connect('clicked', () => this._transformDocument(() => this._document.rotate(1)));
        rotate.append(rotateRight);
        content.append(rotate);

        content.append(sectionLabel('Flip'));
        const flip = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, homogeneous: true });
        const flipHorizontal = new Gtk.Button({ label: 'Horizontal' });
        flipHorizontal.connect('clicked', () => this._transformDocument(() => this._document.flip('horizontal')));
        flip.append(flipHorizontal);
        const flipVertical = new Gtk.Button({ label: 'Vertical' });
        flipVertical.connect('clicked', () => this._transformDocument(() => this._document.flip('vertical')));
        flip.append(flipVertical);
        content.append(flip);

        const apply = new Gtk.Button({
            label: 'Apply Crop',
            margin_top: 16,
        });
        apply.add_css_class('suggested-action');
        apply.add_css_class('pill');
        apply.connect('clicked', () => this._applyCrop());
        content.append(apply);
        return content;
    }

    _sidebarContainer() {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });

        if (this._mode === 'draw' || this._mode === 'crop') {
            const modeSwitch = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                homogeneous: true,
            });
            modeSwitch.add_css_class('linked');
            const draw = new Gtk.ToggleButton({
                label: 'Draw',
                active: this._mode === 'draw',
            });
            const crop = new Gtk.ToggleButton({
                label: 'Crop',
                active: this._mode === 'crop',
                group: draw,
            });
            draw.connect('toggled', () => {
                if (draw.get_active() && this._mode !== 'draw')
                    this._switchEditMode('draw');
            });
            crop.connect('toggled', () => {
                if (crop.get_active() && this._mode !== 'crop')
                    this._switchEditMode('crop');
            });
            modeSwitch.append(draw);
            modeSwitch.append(crop);
            content.append(modeSwitch);
        }
        return content;
    }

    _installControllers() {
        const drag = new Gtk.GestureDrag({ button: Gdk.BUTTON_PRIMARY });
        drag.connect('drag-begin', (_gesture, x, y) => this._dragBegin(x, y, false, drag));
        drag.connect('drag-update', (_gesture, dx, dy) => this._dragUpdate(dx, dy, drag));
        drag.connect('drag-end', (_gesture, dx, dy) => this._dragEnd(dx, dy, drag));
        drag.connect('cancel', () => this._cancelDrag(drag));
        this._drawingArea.add_controller(drag);
        this._primaryDragGesture = drag;

        const panDrag = new Gtk.GestureDrag({ button: Gdk.BUTTON_MIDDLE });
        panDrag.connect('drag-begin', (_gesture, x, y) => this._dragBegin(x, y, true, panDrag));
        panDrag.connect('drag-update', (_gesture, dx, dy) => this._dragUpdate(dx, dy, panDrag));
        panDrag.connect('drag-end', (_gesture, dx, dy) => this._dragEnd(dx, dy, panDrag));
        panDrag.connect('cancel', () => this._cancelDrag(panDrag));
        this._drawingArea.add_controller(panDrag);
        this._panDragGesture = panDrag;

        const textEditClick = new Gtk.GestureClick({ button: Gdk.BUTTON_PRIMARY });
        textEditClick.connect('released', (_gesture, pressCount, x, y) => {
            if (pressCount !== 2 || this._mode !== 'draw' || this._tool !== 'select')
                return;

            const point = this._canvasPoint(x, y);
            if (!point)
                return;
            const geometry = this._viewGeometry();
            const tolerance = 8 / Math.max(
                geometry.width * geometry.scale,
                geometry.height * geometry.scale,
                1,
            );
            const annotation = hitAnnotations(this._document?.annotations, point, tolerance);

            if (annotation?.type !== 'text')
                return;
            this._document.select(annotation.id);
            this._afterSelectionChange();
            this._beginInlineTextEdit(annotation);
        });
        this._drawingArea.add_controller(textEditClick);
        this._textEditClickGesture = textEditClick;

        const scroll = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.VERTICAL,
        });
        scroll.connect('scroll', (_controller, _dx, dy) => {
            this._zoomBy(dy < 0 ? 1.15 : 1 / 1.15);
            return true;
        });
        this._drawingArea.add_controller(scroll);

        if (Gtk.GestureZoom) {
            const zoom = new Gtk.GestureZoom();
            zoom.connect('begin', () => {
                this._pinchStartZoom = this._fit ? 1 : this._zoomFactor;
                this._fit = false;
            });
            zoom.connect('scale-changed', (_gesture, scale) => {
                this._zoomFactor = clamp(this._pinchStartZoom * scale, MIN_ZOOM, MAX_ZOOM);
                this._syncZoomLabel();
                this._drawingArea.queue_draw();
            });
            this._drawingArea.add_controller(zoom);
        }

        const keys = new Gtk.EventControllerKey();
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => this._handleKey(keyval, state));
        this.add_controller(keys);
    }

    async _load() {
        this._setStatus('Loading image…', true);

        try {
            const load = ImageRenderer.loadImageSourceAsync ?? (async path => ImageRenderer.loadImageSource(path));
            this._source = await load(this._image.path, this._loadCancellable);
            this._document = new ImageDocument({
                width: this._source.width,
                height: this._source.height,
                historyLimit: 100,
            });
            this._document.markSaved();
            this._updatePreviewPixbuf();
            this._startAnimation();
            this._setStatus('', false);
            this._surfaceDirty = true;
            this._drawingArea.queue_draw();
            this._syncActionSensitivity();
        } catch (error) {
            if (isCancellation(error))
                return;
            logError(error, `Failed to load image: ${this._image.path}`);
            this._setStatus(error.message || 'The image could not be loaded.', false, true);
            this._syncActionSensitivity(false);
        }
    }

    _setStatus(message, spinning = false, isError = false) {
        this._statusBox.set_visible(Boolean(message));
        this._spinner.set_visible(spinning);
        this._statusLabel.set_label(String(message ?? ''));
        if (isError)
            this._statusLabel.add_css_class('error');
        else
            this._statusLabel.remove_css_class('error');
    }

    _syncActionSensitivity(enabled = Boolean(this._source && this._document) && !this._busy) {
        this._drawButton?.set_sensitive(enabled);
        this._cropButton?.set_sensitive(enabled);
        this._saveMenuButton?.set_sensitive(enabled);
        this._overflowButton?.set_sensitive(Boolean(this._source));
    }

    _drawCanvas(_area, cr, width, height) {
        cr.setSourceRGB(0.055, 0.055, 0.06);
        cr.paint();

        if (!this._source || !this._document)
            return;

        const surface = this._getRenderSurface();

        if (!surface)
            return;

        const geometry = this._viewGeometry(width, height);
        this._drawCheckerboard(cr, geometry);
        cr.save();
        cr.translate(geometry.x, geometry.y);
        cr.scale(geometry.scale, geometry.scale);
        cr.setSourceSurface(surface, 0, 0);
        cr.paint();
        cr.restore();

        if (this._mode === 'draw')
            this._drawSelection(cr, geometry);
        else if (this._mode === 'crop')
            this._drawCropOverlay(cr, geometry);
    }

    _getRenderSurface() {
        if (!this._surfaceDirty)
            return this._renderSurface;

        this._disposeSurface();
        this._surfaceDirty = false;

        try {
            this._renderSurface = ImageRenderer.renderDocumentToSurface(
                this._previewPixbuf ?? this._source.pixbuf,
                this._document,
            );
            this._renderError = null;
        } catch (error) {
            this._renderError = error;
            logError(error, 'Failed to render edited image');
            this._setStatus(error.message || 'The image preview could not be rendered.', false, true);
        }

        return this._renderSurface;
    }

    _disposeSurface() {
        if (!this._renderSurface)
            return;

        try {
            this._renderSurface.finish();
        } catch (_error) {
            // The Cairo surface may already have been finalized by GJS.
        }
        this._renderSurface = null;
    }

    _disposeResources() {
        this._cancelFullscreenRequestTimeout();
        this._fullscreenTransientParent = null;
        this._finishInlineTextEdit({ cancel: true, restoreFocus: false });
        this._loadCancellable?.cancel();
        this._stopAnimation();
        this._disposeSurface();
        this._checkerboardPattern = null;
        this._checkerboardSurface?.finish();
        this._checkerboardSurface = null;
        this._previewPixbuf = null;
        this._source = null;
        this._document = null;
        this._dragState = null;
        this._dragOwner = null;
    }

    _updatePreviewPixbuf() {
        const pixbuf = this._source?.pixbuf;

        if (!pixbuf) {
            this._previewPixbuf = null;
            return;
        }

        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const largest = Math.max(width, height);

        if (largest <= MAX_PREVIEW_DIMENSION) {
            this._previewPixbuf = pixbuf;
            return;
        }

        const scale = MAX_PREVIEW_DIMENSION / largest;
        this._previewPixbuf = pixbuf.scale_simple(
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)),
            GdkPixbuf.InterpType.BILINEAR,
        );
    }

    _startAnimation() {
        this._stopAnimation();

        if (!this._source?.isAnimated || this._mode !== 'view')
            return;

        try {
            this._animationIter = this._source.animation.get_iter(currentTimeValue());
            const frame = this._animationIter.get_pixbuf();

            if (frame) {
                this._source.pixbuf = frame.apply_embedded_orientation?.() ?? frame;
                this._updatePreviewPixbuf();
            }
            this._scheduleAnimationFrame();
        } catch (error) {
            this._animationIter = null;
            logError(error, 'Failed to animate image preview');
        }
    }

    _scheduleAnimationFrame() {
        if (!this._animationIter || this._mode !== 'view')
            return;

        const delay = this._animationIter.get_delay_time();

        if (delay < 0)
            return;

        this._animationSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(20, delay),
            () => {
                this._animationSourceId = 0;

                if (!this._animationIter || this._mode !== 'view')
                    return GLib.SOURCE_REMOVE;

                try {
                    if (this._animationIter.advance(currentTimeValue())) {
                        const frame = this._animationIter.get_pixbuf();
                        this._source.pixbuf = frame.apply_embedded_orientation?.() ?? frame;
                        this._updatePreviewPixbuf();
                        this._surfaceDirty = true;
                        this._drawingArea.queue_draw();
                    }
                    this._scheduleAnimationFrame();
                } catch (error) {
                    this._animationIter = null;
                    logError(error, 'Failed to advance animated image');
                }
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _stopAnimation() {
        if (this._animationSourceId) {
            GLib.source_remove(this._animationSourceId);
            this._animationSourceId = 0;
        }
        this._animationIter = null;
    }

    _surfaceDimensions() {
        const surface = this._renderSurface;
        const width = surface?.getWidth?.() ?? surface?.get_width?.() ?? this._document?.width ?? this._source?.width ?? 1;
        const height = surface?.getHeight?.() ?? surface?.get_height?.() ?? this._document?.height ?? this._source?.height ?? 1;

        return { width: Math.max(1, width), height: Math.max(1, height) };
    }

    _viewGeometry(canvasWidth = this._drawingArea.get_width(), canvasHeight = this._drawingArea.get_height()) {
        const { width, height } = this._surfaceDimensions();
        const availableWidth = Math.max(1, canvasWidth - CANVAS_PADDING * 2);
        const availableHeight = Math.max(1, canvasHeight - CANVAS_PADDING * 2);
        const fitScale = Math.min(availableWidth / width, availableHeight / height);
        const scale = this._fit ? fitScale : fitScale * this._zoomFactor;

        return {
            x: (canvasWidth - width * scale) / 2 + this._panX,
            y: (canvasHeight - height * scale) / 2 + this._panY,
            width,
            height,
            scale,
            fitScale,
        };
    }

    _drawCheckerboard(cr, geometry) {
        if (!this._checkerboardPattern) {
            const tileSize = 24;
            const squareSize = tileSize / 2;
            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, tileSize, tileSize);
            const tile = new Cairo.Context(surface);

            tile.setSourceRGB(0.43, 0.43, 0.45);
            tile.paint();
            tile.setSourceRGB(0.32, 0.32, 0.34);
            tile.rectangle(squareSize, 0, squareSize, squareSize);
            tile.rectangle(0, squareSize, squareSize, squareSize);
            tile.fill();
            tile.$dispose();
            surface.flush();

            this._checkerboardSurface = surface;
            this._checkerboardPattern = new Cairo.SurfacePattern(surface);
            this._checkerboardPattern.setExtend(Cairo.Extend.REPEAT);
        }

        cr.save();
        cr.translate(geometry.x, geometry.y);
        cr.rectangle(0, 0, geometry.width * geometry.scale, geometry.height * geometry.scale);
        cr.clip();
        cr.setSource(this._checkerboardPattern);
        cr.paint();
        cr.restore();
    }

    _drawSelection(cr, geometry) {
        const selected = this._document.selectedAnnotation;
        const bounds = annotationBounds(selected);

        if (!bounds)
            return;

        cr.save();
        cr.translate(geometry.x, geometry.y);
        cr.scale(geometry.scale, geometry.scale);
        const x = bounds.x * geometry.width;
        const y = bounds.y * geometry.height;
        const width = bounds.width * geometry.width;
        const height = bounds.height * geometry.height;
        cr.setSourceRGBA(0.22, 0.60, 1, 1);
        cr.setLineWidth(2 / geometry.scale);
        cr.setDash([5 / geometry.scale, 4 / geometry.scale], 0);
        cr.rectangle(x, y, width, height);
        cr.stroke();
        cr.setDash([], 0);

        for (const { point } of resizeHandles(bounds)) {
            const px = point.x * geometry.width;
            const py = point.y * geometry.height;
            const size = HANDLE_SIZE / geometry.scale;
            cr.setSourceRGB(1, 1, 1);
            cr.rectangle(px - size / 2, py - size / 2, size, size);
            cr.fillPreserve();
            cr.setSourceRGBA(0.1, 0.42, 0.85, 1);
            cr.setLineWidth(1.5 / geometry.scale);
            cr.stroke();
        }
        cr.restore();
    }

    _drawCropOverlay(cr, geometry) {
        const rect = this._cropRect;
        const x = geometry.x + rect.x * geometry.width * geometry.scale;
        const y = geometry.y + rect.y * geometry.height * geometry.scale;
        const width = rect.width * geometry.width * geometry.scale;
        const height = rect.height * geometry.height * geometry.scale;
        const imageRight = geometry.x + geometry.width * geometry.scale;
        const imageBottom = geometry.y + geometry.height * geometry.scale;

        cr.save();
        cr.setSourceRGBA(0, 0, 0, 0.58);
        cr.rectangle(geometry.x, geometry.y, geometry.width * geometry.scale, Math.max(0, y - geometry.y));
        cr.rectangle(geometry.x, y + height, geometry.width * geometry.scale, Math.max(0, imageBottom - y - height));
        cr.rectangle(geometry.x, y, Math.max(0, x - geometry.x), height);
        cr.rectangle(x + width, y, Math.max(0, imageRight - x - width), height);
        cr.fill();
        cr.setSourceRGB(1, 1, 1);
        cr.setLineWidth(2);
        cr.rectangle(x, y, width, height);
        cr.stroke();
        cr.setSourceRGBA(1, 1, 1, 0.65);
        cr.setLineWidth(1);
        cr.moveTo(x + width / 3, y);
        cr.lineTo(x + width / 3, y + height);
        cr.moveTo(x + width * 2 / 3, y);
        cr.lineTo(x + width * 2 / 3, y + height);
        cr.moveTo(x, y + height / 3);
        cr.lineTo(x + width, y + height / 3);
        cr.moveTo(x, y + height * 2 / 3);
        cr.lineTo(x + width, y + height * 2 / 3);
        cr.stroke();
        for (const { point } of resizeHandles(rect)) {
            const px = geometry.x + point.x * geometry.width * geometry.scale;
            const py = geometry.y + point.y * geometry.height * geometry.scale;
            cr.setSourceRGB(1, 1, 1);
            cr.rectangle(px - HANDLE_SIZE / 2, py - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
            cr.fill();
        }
        cr.restore();
    }

    _canvasPoint(x, y, allowOutside = false) {
        const geometry = this._viewGeometry();
        const point = {
            x: (x - geometry.x) / (geometry.width * geometry.scale),
            y: (y - geometry.y) / (geometry.height * geometry.scale),
        };

        if (!allowOutside && (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1))
            return null;

        return {
            x: clamp(point.x, 0, 1),
            y: clamp(point.y, 0, 1),
        };
    }

    _handleAt(point, bounds) {
        if (!point || !bounds)
            return null;

        const geometry = this._viewGeometry();
        const tolerance = Math.max(
            HANDLE_SIZE / Math.max(1, geometry.width * geometry.scale),
            HANDLE_SIZE / Math.max(1, geometry.height * geometry.scale),
        );

        return resizeHandles(bounds).find(({ point: handlePoint }) => (
            Math.hypot(point.x - handlePoint.x, point.y - handlePoint.y) <= tolerance
        ))?.handle ?? null;
    }

    _dragBegin(x, y, forcePan, owner = null) {
        if (this._inlineTextState)
            this._finishInlineTextEdit({ restoreFocus: false });

        this._drawingArea.grab_focus();

        if (this._dragState)
            this._cancelDrag(this._dragOwner);
        this._dragOwner = owner;

        if (!this._document) {
            this._dragOwner = null;
            return;
        }

        if (forcePan || this._mode === 'view') {
            this._dragState = { type: 'pan', panX: this._panX, panY: this._panY };
            return;
        }

        const point = this._canvasPoint(x, y, this._mode === 'crop');

        if (!point) {
            this._dragOwner = null;
            return;
        }

        if (this._mode === 'crop') {
            const handle = this._handleAt(point, this._cropRect);
            const inside = point.x >= this._cropRect.x
                && point.x <= this._cropRect.x + this._cropRect.width
                && point.y >= this._cropRect.y
                && point.y <= this._cropRect.y + this._cropRect.height;
            this._dragState = {
                type: handle ? 'crop-resize' : inside ? 'crop-move' : 'crop-new',
                handle,
                start: point,
                originalRect: { ...this._cropRect },
            };
            if (!handle && !inside)
                this._cropRect = { x: point.x, y: point.y, width: CROP_MIN_SIZE, height: CROP_MIN_SIZE };
            return;
        }

        if (this._tool === 'select') {
            const selected = this._document.selectedAnnotation;
            const handle = selected ? this._handleAt(point, annotationBounds(selected)) : null;
            let target = selected;

            if (!handle) {
                const geometry = this._viewGeometry();
                const tolerance = 8 / Math.max(geometry.width * geometry.scale, geometry.height * geometry.scale, 1);
                target = hitAnnotations(this._document.annotations, point, tolerance);
                this._document.select(target?.id ?? null);
            }

            if (!target) {
                this._dragState = null;
                this._dragOwner = null;
                this._afterSelectionChange();
                return;
            }

            this._document.beginTransaction(handle ? 'Resize annotation' : 'Move annotation');
            this._dragState = {
                type: handle ? 'resize' : 'move',
                id: target.id,
                handle,
                start: point,
                last: point,
            };
            this._afterSelectionChange();
            return;
        }

        this._document.beginTransaction(`Add ${this._tool}`);
        const spec = this._annotationSpec(this._tool, point, point);
        const added = this._document.addAnnotation(spec);
        const id = typeof added === 'string' ? added : added?.id ?? this._document.selectionId;
        this._document.select(id ?? null);
        this._dragState = { type: 'draw', tool: this._tool, id, start: point, last: point };

        if (this._tool === 'text') {
            this._dragState = null;
            this._dragOwner = null;
            this._beginInlineTextEdit(this._document.selectedAnnotation, {
                isNew: true,
                transactionOpen: true,
            });
        }

        this._afterDocumentChange();
    }

    _dragUpdate(dx, dy, owner = null) {
        const state = this._dragState;

        if (!state || (owner && this._dragOwner !== owner))
            return;

        if (state.type === 'pan') {
            this._panX = state.panX + dx;
            this._panY = state.panY + dy;
            this._positionInlineTextEditor();
            this._drawingArea.queue_draw();
            return;
        }

        const geometry = this._viewGeometry();
        const delta = {
            x: dx / Math.max(1, geometry.width * geometry.scale),
            y: dy / Math.max(1, geometry.height * geometry.scale),
        };

        if (state.type.startsWith('crop')) {
            this._updateCropDrag(state, delta);
            this._drawingArea.queue_draw();
            return;
        }

        const current = {
            x: clamp(state.start.x + delta.x, 0, 1),
            y: clamp(state.start.y + delta.y, 0, 1),
        };
        const incremental = {
            x: current.x - state.last.x,
            y: current.y - state.last.y,
        };

        if (state.type === 'move') {
            this._document.moveAnnotation(state.id, incremental.x, incremental.y, { clamp: true });
        } else if (state.type === 'resize') {
            this._document.resizeAnnotation(state.id, state.handle, incremental.x, incremental.y, {
                minSize: 0.005,
                clamp: true,
                scaleStyle: false,
            });
        } else if (state.type === 'draw') {
            if (state.tool === 'pencil') {
                const annotation = this._document.annotations.find(item => item.id === state.id);
                this._document.updateAnnotation(state.id, {
                    points: [...(annotation?.points ?? []), current],
                });
            } else {
                this._document.updateAnnotation(state.id, this._annotationGeometry(state.tool, state.start, current));
            }
        }

        state.last = current;
        this._afterDocumentChange();
    }

    _dragEnd(dx, dy, owner = null) {
        if (!this._dragState || (owner && this._dragOwner !== owner))
            return;

        this._dragUpdate(dx, dy, owner);
        const type = this._dragState.type;
        this._dragState = null;
        this._dragOwner = null;

        if (['draw', 'move', 'resize'].includes(type))
            this._document.commitTransaction();

        if (type === 'draw')
            this._activateTool('select');

        this._afterDocumentChange();
    }

    _cancelDrag(owner = null) {
        const state = this._dragState;

        if (!state || (owner && this._dragOwner !== owner))
            return;

        if (state.type === 'pan') {
            this._panX = state.panX;
            this._panY = state.panY;
        } else if (state.type.startsWith('crop')) {
            this._cropRect = { ...state.originalRect };
        } else if (['draw', 'move', 'resize'].includes(state.type)
            && this._document?.inTransaction) {
            this._document.cancelTransaction();
        }

        this._dragState = null;
        this._dragOwner = null;
        this._afterDocumentChange();
    }

    _beginInlineTextEdit(annotation, options = {}) {
        if (!this._document || annotation?.type !== 'text')
            return false;

        if (this._inlineTextState?.annotationId === annotation.id) {
            this._inlineTextState.entry.grab_focus();
            return true;
        }

        if (this._inlineTextState)
            this._finishInlineTextEdit();

        if (!options.transactionOpen) {
            if (this._document.inTransaction)
                this._document.commitTransaction();
            if (!this._document.beginTransaction('Edit text annotation'))
                return false;
        } else if (!this._document.inTransaction
            && !this._document.beginTransaction('Add text annotation')) {
            return false;
        }
        this._syncUndoRedo();

        const entry = new Gtk.Entry({
            text: String(annotation.text ?? ''),
            placeholder_text: 'Type text',
            halign: Gtk.Align.START,
            valign: Gtk.Align.START,
        });
        entry.add_css_class('cusco-image-inline-text-entry');
        entry.update_property(
            [Gtk.AccessibleProperty.LABEL],
            ['Edit text on image'],
        );

        const state = {
            annotationId: annotation.id,
            entry,
            isNew: Boolean(options.isNew),
            acceptFocusOut: false,
        };
        this._inlineTextState = state;
        this._canvasOverlay.add_overlay(entry);

        entry.connect('changed', () => {
            if (this._inlineTextState !== state)
                return;
            this._text = entry.get_text();
            this._document?.updateAnnotation(state.annotationId, { text: this._text });
            this._afterDocumentChange();
        });
        entry.connect('activate', () => this._finishInlineTextEdit());
        entry.connect('notify::has-focus', () => {
            if (this._inlineTextState !== state
                || !state.acceptFocusOut
                || entry.has_focus()
                || this._inlineTextFocusSourceId) {
                return;
            }

            this._inlineTextFocusSourceId = GLib.idle_add(
                GLib.PRIORITY_DEFAULT_IDLE,
                () => {
                    this._inlineTextFocusSourceId = 0;
                    if (this._inlineTextState === state && !entry.has_focus())
                        this._finishInlineTextEdit();
                    return GLib.SOURCE_REMOVE;
                },
            );
        });

        this._positionInlineTextEditor();
        this._inlineTextFocusSourceId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._inlineTextFocusSourceId = 0;
                if (this._inlineTextState !== state)
                    return GLib.SOURCE_REMOVE;
                state.acceptFocusOut = true;
                entry.grab_focus();
                entry.select_region(0, -1);
                this._positionInlineTextEditor();
                return GLib.SOURCE_REMOVE;
            },
        );
        this._drawingArea.queue_draw();
        return true;
    }

    _finishInlineTextEdit({ cancel = false, restoreFocus = true } = {}) {
        const state = this._inlineTextState;

        if (!state)
            return false;

        this._inlineTextState = null;
        if (this._inlineTextFocusSourceId) {
            GLib.source_remove(this._inlineTextFocusSourceId);
            this._inlineTextFocusSourceId = 0;
        }

        const text = state.entry.get_text();
        this._canvasOverlay.remove_overlay(state.entry);

        if (cancel) {
            this._document?.cancelTransaction();
        } else if (this._document) {
            if (text.trim()) {
                this._document.updateAnnotation(state.annotationId, { text });
                this._document.commitTransaction();
                this._text = text;
            } else if (state.isNew) {
                this._document.cancelTransaction();
            } else {
                this._document.deleteAnnotation(state.annotationId);
                this._document.commitTransaction();
            }
        }

        if (state.isNew)
            this._activateTool('select');

        this._afterDocumentChange();
        if (restoreFocus)
            this._drawingArea.grab_focus();
        return true;
    }

    _positionInlineTextEditor() {
        const state = this._inlineTextState;
        const annotation = this._document?.annotations.find(
            item => item.id === state?.annotationId,
        );

        if (!state || annotation?.type !== 'text')
            return;

        const geometry = this._viewGeometry();
        const canvasWidth = Math.max(1, this._drawingArea.get_width());
        const canvasHeight = Math.max(1, this._drawingArea.get_height());
        const desiredWidth = Math.max(
            120,
            annotation.rect.width * geometry.width * geometry.scale,
        );
        const x = clamp(
            geometry.x + annotation.rect.x * geometry.width * geometry.scale,
            0,
            Math.max(0, canvasWidth - 80),
        );
        const y = clamp(
            geometry.y + annotation.rect.y * geometry.height * geometry.scale,
            0,
            Math.max(0, canvasHeight - 36),
        );
        const width = Math.max(80, Math.min(desiredWidth, canvasWidth - x));

        state.entry.set_margin_start(Math.round(x));
        state.entry.set_margin_top(Math.round(y));
        state.entry.set_size_request(Math.round(width), -1);
    }

    _annotationSpec(type, start, end) {
        const common = {
            type,
            opacity: this._opacity,
        };

        if (type === 'pencil') {
            return {
                ...common,
                points: [start],
                strokeColor: this._strokeColor,
                strokeWidth: this._strokeWidth,
            };
        }

        if (type === 'line' || type === 'arrow') {
            return {
                ...common,
                start,
                end,
                strokeColor: this._strokeColor,
                strokeWidth: this._strokeWidth,
            };
        }

        if (type === 'rectangle' || type === 'ellipse') {
            return {
                ...common,
                rect: normalizedRect(start, end),
                strokeColor: this._strokeColor,
                strokeWidth: this._strokeWidth,
                fillColor: this._fillEnabled ? this._fillColor : null,
            };
        }

        return {
            ...common,
            type: 'text',
            rect: {
                x: start.x,
                y: start.y,
                width: Math.min(0.36, 1 - start.x),
                height: Math.min(Math.max(0.08, this._fontSize * 1.5), 1 - start.y),
            },
            text: this._text || 'Text',
            color: this._strokeColor,
            fontSize: this._fontSize,
            fontFamily: 'Sans',
            fontWeight: 500,
            rotation: 0,
            flipX: false,
            flipY: false,
        };
    }

    _annotationGeometry(type, start, end) {
        if (type === 'line' || type === 'arrow')
            return { start, end };
        return { rect: normalizedRect(start, end) };
    }

    _updateCropDrag(state, delta) {
        let rect = { ...state.originalRect };

        if (state.type === 'crop-new') {
            rect = normalizedRect(state.start, {
                x: clamp(state.start.x + delta.x, 0, 1),
                y: clamp(state.start.y + delta.y, 0, 1),
            });
        } else if (state.type === 'crop-move') {
            rect.x = clamp(rect.x + delta.x, 0, 1 - rect.width);
            rect.y = clamp(rect.y + delta.y, 0, 1 - rect.height);
            this._cropRect = rect;
            return;
        } else if (DocumentModel.resizeBounds) {
            rect = DocumentModel.resizeBounds(rect, state.handle, delta.x, delta.y, {
                minSize: CROP_MIN_SIZE,
                clamp: true,
                keepAspect: Boolean(this._effectiveCropRatio()),
            });
        } else {
            rect = this._fallbackResizeRect(rect, state.handle, delta.x, delta.y);
        }

        this._cropRect = this._constrainCropRatio(rect, state.handle);
    }

    _fallbackResizeRect(rect, handle, dx, dy) {
        const activeHandle = typeof handle === 'string' && handle ? handle : 'se';

        if (activeHandle.includes('w')) {
            rect.x = clamp(rect.x + dx, 0, rect.x + rect.width - CROP_MIN_SIZE);
            rect.width -= rect.x - this._cropRect.x;
        }
        if (activeHandle.includes('e'))
            rect.width = clamp(rect.width + dx, CROP_MIN_SIZE, 1 - rect.x);
        if (activeHandle.includes('n')) {
            rect.y = clamp(rect.y + dy, 0, rect.y + rect.height - CROP_MIN_SIZE);
            rect.height -= rect.y - this._cropRect.y;
        }
        if (activeHandle.includes('s'))
            rect.height = clamp(rect.height + dy, CROP_MIN_SIZE, 1 - rect.y);
        return rect;
    }

    _effectiveCropRatio() {
        let ratio = this._cropRatio;

        if (ratio === 'original')
            ratio = (this._document?.width ?? 1) / (this._document?.height ?? 1);
        if (!Number.isFinite(ratio) || ratio <= 0)
            return null;
        return this._cropPortrait ? 1 / ratio : ratio;
    }

    _constrainCropRatio(rect, handle = 'se') {
        const ratio = this._effectiveCropRatio();
        const activeHandle = typeof handle === 'string' && handle ? handle : 'se';

        if (!ratio)
            return {
                x: clamp(rect.x, 0, 1 - CROP_MIN_SIZE),
                y: clamp(rect.y, 0, 1 - CROP_MIN_SIZE),
                width: clamp(rect.width, CROP_MIN_SIZE, 1 - rect.x),
                height: clamp(rect.height, CROP_MIN_SIZE, 1 - rect.y),
            };

        const outputWidth = this._document?.width ?? 1;
        const outputHeight = this._document?.height ?? 1;
        const normalizedRatio = ratio * outputHeight / outputWidth;
        let width = rect.width;
        let height = width / normalizedRatio;

        if (height > rect.height && !['e', 'w'].includes(activeHandle)) {
            height = rect.height;
            width = height * normalizedRatio;
        }
        width = clamp(width, CROP_MIN_SIZE, 1);
        height = clamp(height, CROP_MIN_SIZE, 1);
        let x = rect.x;
        let y = rect.y;

        if (activeHandle.includes('w'))
            x = rect.x + rect.width - width;
        if (activeHandle.includes('n'))
            y = rect.y + rect.height - height;
        x = clamp(x, 0, 1 - width);
        y = clamp(y, 0, 1 - height);
        return { x, y, width, height };
    }

    _resetCropForRatio() {
        const ratio = this._effectiveCropRatio();

        if (!ratio) {
            this._cropRect = { x: 0, y: 0, width: 1, height: 1 };
        } else {
            const outputWidth = this._document?.width ?? 1;
            const outputHeight = this._document?.height ?? 1;
            const normalizedRatio = ratio * outputHeight / outputWidth;
            let width = 0.88;
            let height = width / normalizedRatio;

            if (height > 0.88) {
                height = 0.88;
                width = height * normalizedRatio;
            }
            this._cropRect = {
                x: (1 - width) / 2,
                y: (1 - height) / 2,
                width,
                height,
            };
        }
        this._drawingArea.queue_draw();
    }

    _applyCrop() {
        if (!this._document)
            return;

        const rect = this._cropRect;

        if (rect.x > 0.0001 || rect.y > 0.0001 || rect.width < 0.9998 || rect.height < 0.9998)
            this._document.crop(rect);

        this._cropRect = { x: 0, y: 0, width: 1, height: 1 };
        this._afterDocumentChange();
        this._resetCropForRatio();
    }

    _transformDocument(callback) {
        if (!this._document)
            return;
        callback();
        this._cropRect = { x: 0, y: 0, width: 1, height: 1 };
        this._afterDocumentChange();
    }

    async _requestEditMode(mode) {
        if (!this._source || !this._document || this._busy)
            return;

        if (!this._conversionAccepted && (this._source.isAnimated || this._source.isVector)) {
            const kind = this._source.isAnimated ? 'animated image' : 'vector image';
            const accepted = await this._choose(
                `Edit ${kind}?`,
                `Editing will use the currently displayed rendering and save a static PNG. The original file will not be changed.`,
                'Edit',
            );

            if (!accepted)
                return;
            this._conversionAccepted = true;
        }

        this._stopAnimation();
        this._editBaseline = this._document.toJSON();
        this._enterEditMode(mode);
    }

    _enterEditMode(mode) {
        this._mode = mode;
        this._infoButton?.set_active(false);
        this._replaceHeader(this._createEditHeader());
        this._sidebarScroller.set_child(mode === 'crop' ? this._createCropSidebar() : this._createDrawSidebar());
        this._setSidebarVisible(true);
        this._zoomControls.set_visible(false);
        this._drawingArea.set_cursor_from_name(mode === 'draw' && this._tool !== 'select' ? 'crosshair' : 'default');
        if (mode === 'crop')
            this._resetCropForRatio();
        this._drawingArea.queue_draw();
    }

    _switchEditMode(mode) {
        if (mode !== 'draw' && mode !== 'crop')
            return;

        this._finishInlineTextEdit({ restoreFocus: false });

        if (this._document?.inTransaction)
            this._document.commitTransaction();

        this._dragState = null;
        this._dragOwner = null;
        this._mode = mode;
        this._replaceHeader(this._createEditHeader());
        this._sidebarScroller.set_child(mode === 'crop'
            ? this._createCropSidebar()
            : this._createDrawSidebar());
        this._drawingArea.set_cursor_from_name(mode === 'draw' && this._tool !== 'select'
            ? 'crosshair'
            : 'default');

        if (mode === 'crop')
            this._resetCropForRatio();
        else
            this._drawingArea.queue_draw();
    }

    _leaveEditMode({ discard = false } = {}) {
        this._finishInlineTextEdit({ cancel: discard, restoreFocus: false });

        if (this._document?.inTransaction)
            this._document.cancelTransaction();

        if (discard && this._editBaseline) {
            this._document = ImageDocument.fromJSON(this._editBaseline);
            this._document.markSaved();
            this._surfaceDirty = true;
        }

        this._editBaseline = null;
        this._dragState = null;
        this._dragOwner = null;
        this._mode = 'view';
        this._document?.select(null);
        this._replaceHeader(this._viewHeader);
        this._setSidebarVisible(false);
        this._zoomControls.set_visible(true);
        this._drawingArea.set_cursor_from_name('default');
        this._drawingArea.queue_draw();

        if (!this._document?.dirty)
            this._startAnimation();
    }

    _replaceHeader(header) {
        if (this._currentHeader)
            this._toolbarView.remove(this._currentHeader);
        this._toolbarView.add_top_bar(header);
        this._currentHeader = header;
    }

    _afterDocumentChange() {
        this._surfaceDirty = true;
        this._renderError = null;
        this._setStatus('', false);
        this._syncUndoRedo();
        this._syncSelectionControls();
        this._positionInlineTextEditor();
        this._drawingArea.queue_draw();
    }

    _afterSelectionChange() {
        this._syncSelectionControls();
        this._drawingArea.queue_draw();
    }

    _syncUndoRedo() {
        this._undoButton?.set_sensitive(Boolean(this._document?.canUndo) && !this._busy);
        this._redoButton?.set_sensitive(Boolean(this._document?.canRedo) && !this._busy);
    }

    _undo() {
        if (this._document?.undo())
            this._afterDocumentChange();
    }

    _redo() {
        if (this._document?.redo())
            this._afterDocumentChange();
    }

    _deleteSelection() {
        this._finishInlineTextEdit({ restoreFocus: false });
        if (!this._document?.selectionId)
            return;
        this._document.deleteAnnotation();
        this._afterDocumentChange();
    }

    _activeDrawType() {
        if (this._tool !== 'select')
            return this._tool;

        return this._document?.selectedAnnotation?.type ?? 'select';
    }

    _activateTool(tool) {
        if (!TOOL_LABELS.some(([candidate]) => candidate === tool))
            return false;

        if (this._inlineTextState && tool !== this._tool)
            this._finishInlineTextEdit({ restoreFocus: false });

        this._tool = tool;
        const toolButton = this._toolButtons?.get(tool);

        if (toolButton && !toolButton.get_active())
            toolButton.set_active(true);

        this._drawingArea?.set_cursor_from_name(tool === 'select' ? 'default' : 'crosshair');
        this._syncDrawControlVisibility();
        this._syncCompactStyleControls();
        return true;
    }

    _syncCompactStyleControls() {
        if (this._mode !== 'draw')
            return;

        const wasSyncing = this._syncingStyleControls;
        this._syncingStyleControls = true;
        try {
            const colorIndex = closestPresetColorIndex(this._strokeColor);
            const colorButton = this._colorButtons?.[colorIndex];

            if (colorButton && !colorButton.get_active())
                colorButton.set_active(true);

            const isText = this._activeDrawType() === 'text';
            const sizeItems = isText ? TEXT_SIZES : THICKNESSES;
            const sizeValue = isText ? this._fontSize : this._strokeWidth;
            const sizeButton = this._sizeButtons?.[closestValueIndex(sizeItems, sizeValue)];

            if (sizeButton && !sizeButton.get_active())
                sizeButton.set_active(true);

            if (this._fillSwitch?.get_active() !== this._fillEnabled)
                this._fillSwitch?.set_active(this._fillEnabled);
        } finally {
            this._syncingStyleControls = wasSyncing;
        }
    }

    _syncSelectionControls() {
        const selected = this._document?.selectedAnnotation;
        this._objectActions?.set_visible(Boolean(selected));
        this._duplicateButton?.set_sensitive(Boolean(selected));
        this._deleteButton?.set_sensitive(Boolean(selected));

        if (!selected) {
            this._syncDrawControlVisibility();
            this._syncCompactStyleControls();
            return;
        }

        this._syncingStyleControls = true;
        try {
            this._opacity = selected.opacity ?? 1;

            if (selected.type === 'text') {
                this._strokeColor = selected.color ?? this._strokeColor;
                this._fontSize = selected.fontSize ?? this._fontSize;
                this._text = selected.text ?? '';
            } else {
                this._strokeColor = selected.strokeColor ?? this._strokeColor;
                this._strokeWidth = selected.strokeWidth ?? this._strokeWidth;

                if (selected.type === 'rectangle' || selected.type === 'ellipse') {
                    this._fillEnabled = Boolean(selected.fillColor);
                    if (selected.fillColor)
                        this._fillColor = selected.fillColor;
                }
            }
        } finally {
            this._syncingStyleControls = false;
        }
        this._syncDrawControlVisibility();
        this._syncCompactStyleControls();
    }

    _syncDrawControlVisibility() {
        const activeType = this._activeDrawType();
        const shape = activeType === 'rectangle' || activeType === 'ellipse';
        this._fillControls?.set_visible(shape);
    }

    _updateSelectedStyle(changes = {}) {
        const selected = this._document?.selectedAnnotation;

        if (!selected)
            return;

        const patch = {};
        if (selected.type === 'text') {
            if (Object.hasOwn(changes, 'strokeColor'))
                patch.color = changes.strokeColor;
            if (Object.hasOwn(changes, 'fontSize'))
                patch.fontSize = changes.fontSize;
            if (Object.hasOwn(changes, 'opacity'))
                patch.opacity = changes.opacity;
        } else {
            if (Object.hasOwn(changes, 'strokeColor'))
                patch.strokeColor = changes.strokeColor;
            if (Object.hasOwn(changes, 'strokeWidth'))
                patch.strokeWidth = changes.strokeWidth;
            if (Object.hasOwn(changes, 'opacity'))
                patch.opacity = changes.opacity;
            if ((selected.type === 'rectangle' || selected.type === 'ellipse')
                && Object.hasOwn(changes, 'fillColor')) {
                patch.fillColor = changes.fillColor;
            }
        }

        if (Object.keys(patch).length === 0)
            return;
        this._document.updateAnnotation(selected.id, patch);
        this._afterDocumentChange();
    }

    _zoomBy(factor) {
        if (!this._source)
            return;
        this._fit = false;
        this._zoomFactor = clamp(this._zoomFactor * factor, MIN_ZOOM, MAX_ZOOM);
        this._syncZoomLabel();
        this._positionInlineTextEditor();
        this._drawingArea.queue_draw();
    }

    _fitImage() {
        this._fit = true;
        this._zoomFactor = 1;
        this._panX = 0;
        this._panY = 0;
        this._syncZoomLabel();
        this._positionInlineTextEditor();
        this._drawingArea.queue_draw();
    }

    _setActualSize() {
        const geometry = this._viewGeometry();
        this._fit = false;
        this._zoomFactor = clamp(1 / Math.max(geometry.fitScale, 0.0001), MIN_ZOOM, MAX_ZOOM);
        this._panX = 0;
        this._panY = 0;
        this._syncZoomLabel();
        this._positionInlineTextEditor();
        this._drawingArea.queue_draw();
    }

    _syncZoomLabel() {
        if (!this._zoomLabel)
            return;
        if (this._fit) {
            this._zoomLabel.set_label('Fit');
            return;
        }
        const geometry = this._viewGeometry();
        this._zoomLabel.set_label(`${Math.round(geometry.scale * 100)}%`);
    }

    _toggleFullscreen() {
        if (this.is_fullscreen() || this._fullscreenRequestSourceId)
            this._leaveFullscreen();
        else
            this._enterFullscreen();
    }

    _enterFullscreen() {
        const transientParent = this.get_transient_for();

        if (transientParent) {
            this._fullscreenTransientParent = transientParent;
            this.set_transient_for(null);
        }

        this._fullscreenRequestSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            FULLSCREEN_REQUEST_TIMEOUT_MS,
            () => {
                this._fullscreenRequestSourceId = 0;

                if (!this.is_fullscreen())
                    this._restoreFullscreenTransientParent();
                this._syncFullscreenButton();
                return GLib.SOURCE_REMOVE;
            },
        );
        this._syncFullscreenButton();
        this.fullscreen();
    }

    _leaveFullscreen() {
        this._cancelFullscreenRequestTimeout();
        this.unfullscreen();

        if (!this.is_fullscreen())
            this._restoreFullscreenTransientParent();
        this._syncFullscreenButton();
    }

    _cancelFullscreenRequestTimeout() {
        if (!this._fullscreenRequestSourceId)
            return;

        GLib.source_remove(this._fullscreenRequestSourceId);
        this._fullscreenRequestSourceId = 0;
    }

    _restoreFullscreenTransientParent() {
        const transientParent = this._fullscreenTransientParent;

        if (!transientParent)
            return;

        this._fullscreenTransientParent = null;
        try {
            this.set_transient_for(transientParent);
        } catch (_error) {
            // The main window may have been destroyed while the editor was fullscreen.
        }
    }

    _syncFullscreenState() {
        if (this.is_fullscreen())
            this._cancelFullscreenRequestTimeout();
        else if (!this._fullscreenRequestSourceId)
            this._restoreFullscreenTransientParent();
        this._syncFullscreenButton();
    }

    _syncFullscreenButton() {
        if (!this._fullscreenButton)
            return;
        const fullscreened = this.is_fullscreen() || Boolean(this._fullscreenRequestSourceId);
        this._fullscreenButton.set_icon_name(fullscreened ? 'view-restore-symbolic' : 'view-fullscreen-symbolic');
        this._fullscreenButton.set_tooltip_text(fullscreened ? 'Leave Fullscreen (F11)' : 'Enter Fullscreen (F11)');
    }

    _syncAdaptiveLayout() {
        const narrow = this.get_width() > 0 && this.get_width() < NARROW_WIDTH;

        this._setNarrowLayout(narrow);
    }

    _sidebarVisible() {
        if (this._narrowLayout && this._bottomSheet)
            return this._bottomSheet.get_open();
        return this._splitView.get_show_sidebar();
    }

    _setSidebarVisible(visible) {
        const show = Boolean(visible);

        if (this._narrowLayout && this._bottomSheet) {
            this._bottomSheet.set_can_close(this._mode === 'view');
            this._bottomSheet.set_open(show);
        } else {
            this._splitView.set_show_sidebar(show);
        }
    }

    _setNarrowLayout(narrow) {
        const useBottomSheet = Boolean(narrow && this._bottomSheet);

        if (this._narrowLayout === useBottomSheet)
            return;

        const sidebarVisible = this._sidebarVisible();

        if (useBottomSheet) {
            this._splitView.set_show_sidebar(false);
            this._splitView.set_sidebar(null);
            this._bottomSheet.set_sheet(this._sidebarScroller);
            this._narrowLayout = true;
            this._bottomSheet.set_can_close(this._mode === 'view');
            this._bottomSheet.set_open(sidebarVisible);
        } else {
            this._narrowLayout = false;
            this._bottomSheet?.set_open(false);
            this._bottomSheet?.set_sheet(null);
            this._splitView.set_sidebar(this._sidebarScroller);
            this._splitView.set_pin_sidebar(true);
            this._splitView.set_sidebar_width_fraction(0.32);
            this._splitView.set_show_sidebar(sidebarVisible);
        }
    }

    _syncAttachCapability() {
        let capability = { allowed: true, reason: '' };

        try {
            capability = this._getAttachCapability?.() ?? capability;
        } catch (error) {
            capability = { allowed: false, reason: error.message };
        }

        const allowed = capability.allowed !== false;
        this._saveAttachButton?.set_sensitive(allowed && !this._busy);
        this._attachReasonLabel?.set_visible(!allowed);
        this._attachReasonLabel?.set_label(String(capability.reason || 'The selected provider does not support image attachments.'));
        return { allowed, reason: capability.reason ?? '' };
    }

    _saveCopy() {
        if (!this._document || !this._source || this._busy)
            return;
        this._finishInlineTextEdit({ restoreFocus: false });
        const pngFilter = new Gtk.FileFilter();
        pngFilter.set_name('PNG Images');
        pngFilter.add_mime_type('image/png');
        pngFilter.add_pattern('*.png');
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(pngFilter);
        const dialog = new Gtk.FileDialog({
            title: 'Save Edited Image',
            initial_name: `${basenameWithoutExtension(this._image.path)}-edited.png`,
        });
        dialog.set_filters(filters);
        dialog.set_default_filter(pngFilter);
        dialog.save(this, null, (_dialog, result) => {
            try {
                const file = dialog.save_finish(result);
                const selectedPath = file.get_path();

                if (!selectedPath)
                    throw new Error('Only local save paths are supported.');
                const path = ensurePngExtension(selectedPath);
                if (path !== selectedPath && GLib.file_test(path, GLib.FileTest.EXISTS)) {
                    throw new Error(
                        `A file named ${GLib.path_get_basename(path)} already exists. `
                        + 'Choose that .png filename directly to confirm replacing it.',
                    );
                }
                if (Gio.File.new_for_path(path).equal(Gio.File.new_for_path(this._image.path)))
                    throw new Error('Choose a new filename. Cusco never overwrites the original image.');

                this._setBusy(true);
                const saved = ImageRenderer.exportDocumentPng(
                    this._source.pixbuf,
                    this._document,
                    path,
                    { sourcePath: this._image.path },
                );
                const outputPath = saved?.path ?? path;
                this._adoptSavedCopy(outputPath);
                this._setBusy(false);
                this._toast(`Saved ${this._image.title}`);
            } catch (error) {
                if (isCancellation(error))
                    return;
                this._setBusy(false);
                logError(error, 'Failed to save edited image');
                this._showError('Could Not Save Image', error.message);
            }
        });
    }

    _adoptSavedCopy(path) {
        this._stopAnimation();
        this._disposeSurface();

        const source = ImageRenderer.loadImageSource(path);
        const document = new ImageDocument({
            width: source.width,
            height: source.height,
            historyLimit: 100,
        });
        document.markSaved();
        this._source = source;
        this._document = document;
        this._image = {
            path,
            title: GLib.path_get_basename(path),
            mimeType: 'image/png',
            sourceKind: 'edited-image',
        };
        this._editBaseline = null;
        this._conversionAccepted = true;
        this._mode = 'view';
        this._surfaceDirty = true;
        this._renderError = null;
        this._updatePreviewPixbuf();
        this._viewHeader = this._createViewHeader();
        this._replaceHeader(this._viewHeader);
        this._setSidebarVisible(false);
        this._zoomControls.set_visible(true);
        this.set_title(this._image.title);
        this._fitImage();
        this._syncActionSensitivity();
    }

    async _saveAndAttach() {
        if (!this._document || !this._source || this._busy)
            return;
        this._finishInlineTextEdit({ restoreFocus: false });
        const capability = this._syncAttachCapability();

        if (!capability.allowed) {
            this._toast(capability.reason || 'The selected provider does not support image attachments.');
            return;
        }

        this._setBusy(true);
        try {
            const saved = ImageRenderer.saveDocumentForChat(
                this._source.pixbuf,
                this._document,
                this._image.path,
                { directory: this._editedImageDirectory ?? undefined },
            );
            const outputPath = saved?.path ?? saved;

            if (!outputPath)
                throw new Error('The edited image was not created.');
            const accepted = await Promise.resolve(this._onAttach(outputPath));

            if (accepted === false)
                throw new Error('The edited image could not be added to the composer.');
            this._document.markSaved();
            this._setBusy(false);
            this._allowClose = true;
            this.close();
        } catch (error) {
            this._setBusy(false);
            logError(error, 'Failed to save edited image for chat');
            this._showError('Could Not Add Image', error.message);
        }
    }

    _setBusy(busy) {
        this._busy = Boolean(busy);
        this._syncActionSensitivity();
        this._syncUndoRedo();
        this._syncAttachCapability();
        if (busy)
            this._setStatus('Saving image…', true);
        else if (!this._renderError)
            this._setStatus('', false);
    }

    _copyPath() {
        this.get_clipboard().set(this._image.path);
        this._toast('Image path copied.');
    }

    _copyImage() {
        if (!this._source?.pixbuf)
            return;
        try {
            this.get_clipboard().set(Gdk.Texture.new_for_pixbuf(this._source.pixbuf));
            this._toast('Image copied.');
        } catch (error) {
            this._showError('Could Not Copy Image', error.message);
        }
    }

    _showInFiles() {
        try {
            const folder = Gio.File.new_for_path(GLib.path_get_dirname(this._image.path));
            Gio.AppInfo.launch_default_for_uri(folder.get_uri(), null);
        } catch (error) {
            this._showError('Could Not Open Files', error.message);
        }
    }

    _openExternally() {
        try {
            Gtk.show_uri(this, Gio.File.new_for_path(this._image.path).get_uri(), 0);
        } catch (error) {
            this._showError('Could Not Open Image', error.message);
        }
    }

    _toast(message) {
        this._toastOverlay.add_toast(new Adw.Toast({ title: String(message ?? '') }));
    }

    _showError(heading, body) {
        const dialog = new Adw.AlertDialog({ heading, body: String(body || 'An unexpected error occurred.') });
        dialog.add_response('close', 'Close');
        dialog.set_default_response('close');
        dialog.set_close_response('close');
        dialog.present(this);
    }

    _choose(heading, body, acceptLabel) {
        return new Promise(resolve => {
            const dialog = new Adw.AlertDialog({ heading, body });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('accept', acceptLabel);
            dialog.set_close_response('cancel');
            dialog.set_default_response('accept');
            dialog.set_response_appearance('accept', Adw.ResponseAppearance.SUGGESTED);
            dialog.choose(this, null, (_dialog, result) => {
                try {
                    resolve(dialog.choose_finish(result) === 'accept');
                } catch (_error) {
                    resolve(false);
                }
            });
        });
    }

    _onCloseRequest() {
        if (this._allowClose || !this._document?.dirty)
            return false;

        this._confirmDiscard();
        return true;
    }

    async _confirmDiscard() {
        if (this._discardDialogOpen)
            return;
        this._discardDialogOpen = true;
        const discard = await this._choose(
            'Discard Unsaved Changes?',
            'Your edits have not been saved. The original image is unchanged.',
            'Discard',
        );
        this._discardDialogOpen = false;

        if (discard) {
            this._allowClose = true;
            this.close();
        }
    }

    _handleKey(keyval, state) {
        const control = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const editableFocus = isEditableFocus(this.get_focus());

        if (keyval === Gdk.KEY_Escape && this._inlineTextState) {
            this._finishInlineTextEdit({ cancel: true });
            return true;
        }

        if (keyval === Gdk.KEY_F11) {
            this._toggleFullscreen();
            return true;
        }
        if (keyval === Gdk.KEY_Escape) {
            if (this._mode !== 'view')
                this._leaveEditMode({ discard: true });
            else if (this.is_fullscreen() || this._fullscreenRequestSourceId)
                this._leaveFullscreen();
            else
                this.close();
            return true;
        }
        if (!editableFocus
            && (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter)
            && this._mode === 'draw'
            && this._document?.selectedAnnotation?.type === 'text') {
            this._beginInlineTextEdit(this._document.selectedAnnotation);
            return true;
        }
        if (control && keyval === Gdk.KEY_z && !editableFocus) {
            shift ? this._redo() : this._undo();
            return true;
        }
        if (control && keyval === Gdk.KEY_y && !editableFocus) {
            this._redo();
            return true;
        }
        if (control && keyval === Gdk.KEY_s) {
            this._saveCopy();
            return true;
        }
        if ((keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_BackSpace)
            && this._mode === 'draw'
            && this._document?.selectionId
            && !editableFocus) {
            this._deleteSelection();
            return true;
        }
        if (!editableFocus
            && (keyval === Gdk.KEY_plus || keyval === Gdk.KEY_equal || keyval === Gdk.KEY_KP_Add)) {
            this._zoomBy(1.25);
            return true;
        }
        if (!editableFocus && (keyval === Gdk.KEY_minus || keyval === Gdk.KEY_KP_Subtract)) {
            this._zoomBy(1 / 1.25);
            return true;
        }
        if (!editableFocus && keyval === Gdk.KEY_0) {
            this._fitImage();
            return true;
        }
        if (!editableFocus && keyval === Gdk.KEY_1) {
            this._setActualSize();
            return true;
        }
        return false;
    }
});

export function presentImageViewer(options = {}) {
    const viewer = new ImageViewerWindow(options);

    viewer.present();
    return viewer;
}
