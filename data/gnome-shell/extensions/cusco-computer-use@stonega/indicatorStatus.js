import GLib from 'gi://GLib';

export const MAX_INDICATOR_STATUS_CHARACTERS = 36;
const SHIMMER_EDGE_PADDING = 3;

function normalizedText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function ellipsizeIndicatorStatus(value, maximum = MAX_INDICATOR_STATUS_CHARACTERS) {
    const text = normalizedText(value);
    const characters = [...text];
    const limit = Math.max(1, Math.round(Number(maximum) || MAX_INDICATOR_STATUS_CHARACTERS));

    if (characters.length <= limit)
        return text;
    if (limit === 1)
        return '…';

    return `${characters.slice(0, limit - 1).join('').trimEnd()}…`;
}

export function buildIndicatorShimmerMarkup(value, phase = 0) {
    const characters = [...String(value ?? '')];

    if (characters.length === 0)
        return '';

    const cycleLength = characters.length + SHIMMER_EDGE_PADDING * 2;
    const normalizedPhase = ((Math.floor(Number(phase) || 0) % cycleLength) + cycleLength)
        % cycleLength;
    const highlightPosition = normalizedPhase - SHIMMER_EDGE_PADDING;

    return characters.map((character, index) => {
        const distance = Math.abs(index - highlightPosition);
        let alpha = 68;

        if (distance < 0.5)
            alpha = 100;
        else if (distance < 1.5)
            alpha = 90;
        else if (distance < 2.5)
            alpha = 78;

        return `<span alpha="${alpha}%">${GLib.markup_escape_text(character, -1)}</span>`;
    }).join('');
}

export function describeComputerUseOperation(operation, details = {}) {
    const target = normalizedText(details.windowTitle) || 'active app';
    const workspaceNumber = Number.isInteger(Number(details.workspaceIndex))
        ? Number(details.workspaceIndex) + 1
        : null;
    let description;

    switch (operation) {
    case 'list_desktop':
        description = 'Checking desktop';
        break;
    case 'capture':
        description = `Viewing ${target}`;
        break;
    case 'create_workspace':
        description = 'Creating workspace';
        break;
    case 'switch_workspace':
        description = workspaceNumber
            ? `Switching to workspace ${workspaceNumber}`
            : 'Switching workspace';
        break;
    case 'move_to_workspace':
        description = workspaceNumber
            ? `Moving ${target} to workspace ${workspaceNumber}`
            : `Moving ${target} to workspace`;
        break;
    case 'move_to_new_workspace':
        description = `Moving ${target} to a new workspace`;
        break;
    case 'focus':
        description = `Focusing ${target}`;
        break;
    case 'maximize':
        description = `Maximizing ${target}`;
        break;
    case 'move':
        description = `Moving pointer in ${target}`;
        break;
    case 'click':
        description = `Clicking in ${target}`;
        break;
    case 'double_click':
        description = `Double-clicking in ${target}`;
        break;
    case 'type':
        description = `Typing in ${target}`;
        break;
    case 'paste_text':
        description = `Pasting in ${target}`;
        break;
    case 'keypress':
        description = `Pressing keys in ${target}`;
        break;
    case 'scroll':
        description = `Scrolling ${target}`;
        break;
    case 'drag':
        description = `Dragging in ${target}`;
        break;
    default:
        description = 'Cusco is using the computer';
        break;
    }

    return ellipsizeIndicatorStatus(description);
}
