import Cairo from 'cairo';

const CUSTOM_PROVIDER_COLORS = [
    { red: 0.208, green: 0.518, blue: 0.894 },
    { red: 0.569, green: 0.255, blue: 0.675 },
    { red: 0.129, green: 0.565, blue: 0.643 },
    { red: 0.227, green: 0.58, blue: 0.29 },
    { red: 0.776, green: 0.275, blue: 0 },
    { red: 0.753, green: 0.11, blue: 0.157 },
];

function stableColorIndex(value) {
    let hash = 2166136261;

    for (const character of String(value)) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0) % CUSTOM_PROVIDER_COLORS.length;
}

export function customProviderIconSpec(provider) {
    if (!provider?.customizable)
        return null;

    const name = String(provider.name ?? '').trim();
    const firstCharacter = [...name][0] ?? '?';
    const initial = [...firstCharacter.toLocaleUpperCase()][0] ?? '?';
    const colorKey = String(provider.id ?? '').trim() || name;

    return {
        initial,
        background: CUSTOM_PROVIDER_COLORS[stableColorIndex(colorKey)],
    };
}

function appendRoundedRectangle(cr, size) {
    const radius = size * 0.22;

    cr.newSubPath();
    cr.arc(size - radius, radius, radius, -Math.PI / 2, 0);
    cr.arc(size - radius, size - radius, radius, 0, Math.PI / 2);
    cr.arc(radius, size - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(radius, radius, radius, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

export function drawCustomProviderIcon(cr, icon, size) {
    appendRoundedRectangle(cr, size);
    cr.setSourceRGB(icon.background.red, icon.background.green, icon.background.blue);
    cr.fill();

    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
    cr.setFontSize(size * 0.52);
    cr.setSourceRGB(1, 1, 1);
    const extents = cr.textExtents(icon.initial);
    cr.moveTo(
        (size - extents.width) / 2 - extents.xBearing,
        (size - extents.height) / 2 - extents.yBearing,
    );
    cr.showText(icon.initial);
}
