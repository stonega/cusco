const KEY_SUFFIX_ALIASES = {
    CTRL: 'Control_L',
    CONTROL: 'Control_L',
    ALT: 'Alt_L',
    SHIFT: 'Shift_L',
    SUPER: 'Super_L',
    META: 'Super_L',
    ENTER: 'Return',
    RETURN: 'Return',
    ESC: 'Escape',
    ESCAPE: 'Escape',
    TAB: 'Tab',
    BACKSPACE: 'BackSpace',
    BACK_SPACE: 'BackSpace',
    DELETE: 'Delete',
    DEL: 'Delete',
    INSERT: 'Insert',
    INS: 'Insert',
    HOME: 'Home',
    END: 'End',
    SPACE: 'space',
    PAGEUP: 'Page_Up',
    PAGE_UP: 'Page_Up',
    PAGEDOWN: 'Page_Down',
    PAGE_DOWN: 'Page_Down',
    UP: 'Up',
    DOWN: 'Down',
    LEFT: 'Left',
    RIGHT: 'Right',
};

export function clutterKeySuffix(name) {
    const normalized = String(name ?? '').trim().toUpperCase().replaceAll('-', '_');
    const alias = KEY_SUFFIX_ALIASES[normalized];

    if (alias)
        return alias;

    // Letter names describe the physical key in a chord; SHIFT is represented
    // separately. Clutter.KEY_A is an uppercase keysym and can therefore turn
    // CTRL+A into CTRL+SHIFT+A, while Clutter.KEY_a preserves the intended chord.
    if (/^[A-Z]$/.test(normalized))
        return normalized.toLowerCase();

    return normalized;
}
