import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

function createField(labelText, child, helperText = '') {
    const field = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
    });
    const label = new Gtk.Label({
        label: labelText,
        xalign: 0,
    });
    label.add_css_class('heading');
    field.append(label);
    field.append(child);

    if (helperText) {
        const helper = new Gtk.Label({
            label: helperText,
            xalign: 0,
            wrap: true,
        });
        helper.add_css_class('caption');
        helper.add_css_class('dim-label');
        field.append(helper);
    }

    return field;
}

function textBufferValue(buffer) {
    const [start, end] = buffer.get_bounds();
    return buffer.get_text(start, end, true).trim();
}

function showAutomationError(parent, error) {
    const dialog = new Adw.AlertDialog({
        heading: 'Could Not Save Automation',
        body: error?.userMessage ?? error?.message ?? 'The automation could not be saved.',
    });
    dialog.add_response('close', 'Close');
    dialog.set_close_response('close');
    dialog.present(parent);
}

export function presentAutomationDialog(parent, options = {}) {
    const job = options.job ?? null;
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 6,
        margin_end: 6,
        width_request: 480,
    });
    const titleEntry = new Gtk.Entry({
        text: job?.title ?? '',
        placeholder_text: 'Daily briefing',
        activates_default: true,
        hexpand: true,
    });
    const scheduleEntry = new Gtk.Entry({
        text: job?.schedule ?? '0 9 * * *',
        placeholder_text: '0 9 * * *',
        activates_default: true,
        hexpand: true,
    });
    const promptBuffer = new Gtk.TextBuffer();
    promptBuffer.set_text(job?.prompt ?? '', -1);
    const promptView = new Gtk.TextView({
        buffer: promptBuffer,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 8,
        bottom_margin: 8,
        left_margin: 8,
        right_margin: 8,
        vexpand: true,
    });
    const promptScroller = new Gtk.ScrolledWindow({
        child: promptView,
        min_content_height: 150,
        max_content_height: 240,
        propagate_natural_height: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    promptScroller.add_css_class('cusco-automation-prompt');
    const enabledRow = new Adw.SwitchRow({
        title: 'Active',
        subtitle: 'Run this automation on its schedule.',
        active: job?.enabled !== false,
    });
    const enabledGroup = new Adw.PreferencesGroup();
    enabledGroup.add(enabledRow);

    content.append(createField('Name', titleEntry));
    content.append(createField(
        'Schedule',
        scheduleEntry,
        'Five cron fields: minute, hour, day of month, month, and weekday.',
    ));
    content.append(createField(
        'AI prompt',
        promptScroller,
        'Cusco sends this prompt to the model selected for the automation.',
    ));
    content.append(enabledGroup);

    const dialog = new Adw.AlertDialog({
        heading: job ? 'Edit Automation' : 'New Automation',
        body: job
            ? 'Future runs use the updated schedule and prompt.'
            : 'Cusco will add each AI response to this automation’s message history.',
    });
    dialog.set_extra_child(content);
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('save', job ? 'Save' : 'Create');
    dialog.set_default_response('save');
    dialog.set_close_response('cancel');
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

    const syncSaveEnabled = () => {
        const scheduleFields = scheduleEntry.get_text().trim().split(/\s+/).filter(Boolean);
        dialog.set_response_enabled('save', Boolean(
            titleEntry.get_text().trim()
            && scheduleFields.length === 5
            && textBufferValue(promptBuffer)
        ));
    };

    titleEntry.connect('changed', syncSaveEnabled);
    scheduleEntry.connect('changed', syncSaveEnabled);
    promptBuffer.connect('changed', syncSaveEnabled);
    syncSaveEnabled();

    dialog.choose(parent, null, async (_dialog, result) => {
        if (dialog.choose_finish(result) !== 'save')
            return;

        try {
            await options.onSave?.({
                title: titleEntry.get_text().trim(),
                schedule: scheduleEntry.get_text().trim(),
                prompt: textBufferValue(promptBuffer),
                enabled: enabledRow.get_active(),
            });
        } catch (error) {
            logError(error, 'Failed to save automation');
            showAutomationError(parent, error);
        }
    });

}
