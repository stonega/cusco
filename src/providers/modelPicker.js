import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject?version=2.0';
import Pango from 'gi://Pango?version=1.0';

export const ModelPicker = GObject.registerClass({
    GTypeName: 'CuscoModelPicker',
    Signals: {
        changed: {},
    },
}, class ModelPicker extends Gtk.MenuButton {
    _init(params = {}) {
        super._init({
            direction: Gtk.ArrowType.DOWN,
            valign: Gtk.Align.CENTER,
            ...params,
        });

        this._activeId = null;
        this._rows = new Map();
        this._modelList = new Gtk.ListBox({
            activate_on_single_click: true,
            selection_mode: Gtk.SelectionMode.SINGLE,
        });
        this._modelList.add_css_class('navigation-sidebar');
        this._modelList.connect('row-activated', (_list, row) => {
            this.set_active_id(row._modelId);
            this._modelPopover.popdown();
        });

        const scroller = new Gtk.ScrolledWindow({
            child: this._modelList,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            max_content_height: 420,
            propagate_natural_height: true,
            propagate_natural_width: true,
        });
        this._modelPopover = new Gtk.Popover({
            autohide: true,
            has_arrow: false,
            position: Gtk.PositionType.BOTTOM,
        });
        this._modelPopover.set_child(scroller);
        this.set_popover(this._modelPopover);
        this.add_css_class('cusco-selector-picker');
        this.add_css_class('cusco-model-picker');
    }

    append(id, name) {
        const modelId = String(id ?? '').trim();

        if (!modelId || this._rows.has(modelId))
            return;

        const modelName = String(name ?? modelId);
        const row = new Gtk.ListBoxRow({
            activatable: true,
            selectable: true,
        });
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_top: 7,
            margin_bottom: 7,
            margin_start: 12,
            margin_end: 12,
        });
        const label = new Gtk.Label({
            label: modelName,
            ellipsize: Pango.EllipsizeMode.NONE,
            hexpand: true,
            single_line_mode: true,
            tooltip_text: modelName,
            xalign: 0,
        });
        const check = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            opacity: 0,
        });

        content.append(label);
        content.append(check);
        row.set_child(content);
        row._modelId = modelId;
        row._modelName = modelName;
        row._check = check;
        this._rows.set(modelId, row);
        this._modelList.append(row);
    }

    remove_all() {
        for (let child = this._modelList.get_first_child(); child;) {
            const next = child.get_next_sibling();
            this._modelList.remove(child);
            child = next;
        }

        this._rows.clear();
        this._activeId = null;
        this.set_label('');
        this.set_tooltip_text(null);
    }

    get_active_id() {
        return this._activeId;
    }

    set_active_id(id) {
        const modelId = id === null || id === undefined ? null : String(id);
        const row = modelId ? this._rows.get(modelId) : null;

        if (modelId && !row)
            return false;

        if (modelId === this._activeId)
            return true;

        this._activeId = modelId;
        this.set_label(row?._modelName ?? '');
        this.set_tooltip_text(row?._modelName ?? null);

        for (const [rowModelId, modelRow] of this._rows)
            modelRow._check.set_opacity(rowModelId === modelId ? 1 : 0);

        this._modelList.select_row(row ?? null);
        this.queue_resize();
        this.emit('changed');
        return true;
    }
});
