import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';

import { backgroundBrowserCommand } from '../packages/computerUse/backgroundSession.js';
import { ComputerUseManager } from '../packages/computerUse/manager.js';
import { createComputerUseTools } from '../src/computerUse/tools.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const profileRoot = GLib.dir_make_tmp('cusco-background-browser-test-XXXXXX');
try {
    const firefox = backgroundBrowserCommand('firefox.desktop', '/usr/bin/firefox', profileRoot);
    assert(firefox[1] === '--no-remote' && firefox[2] === '--profile',
        'Firefox must start as a separate instance with a named profile.');
    assert(firefox[3].startsWith(profileRoot), 'Firefox profile escaped the background directory.');

    const chrome = backgroundBrowserCommand('google-chrome.desktop', '/usr/bin/google-chrome-stable', profileRoot);
    assert(chrome.some(argument => argument.startsWith(`--user-data-dir=${profileRoot}/`)),
        'Chrome must use a separate user data directory.');
    assert(backgroundBrowserCommand('org.gnome.Calculator.desktop', 'gnome-calculator', profileRoot) === null,
        'Ordinary GTK apps should use their desktop launcher.');

    let rejected = false;
    try {
        backgroundBrowserCommand('firefox.desktop', 'flatpak', profileRoot);
    } catch (_error) {
        rejected = true;
    }
    assert(rejected, 'An unsupported Firefox launcher must fail instead of using the physical profile.');
} finally {
    for (const directory of ['firefox', 'chromium']) {
        const path = GLib.build_filenamev([profileRoot, directory]);
        if (GLib.file_test(path, GLib.FileTest.IS_DIR))
            GLib.rmdir(path);
    }
    GLib.rmdir(profileRoot);
}

class FakeDesktop {
    constructor(name) {
        this.name = name;
        this.calls = [];
        this.active = false;
        this.running = false;
        this.activeTurnCancellable = null;
        this.failList = false;
    }

    async status() { return { available: true, mode: this.name }; }
    async listDesktop(options = {}) {
        this.calls.push('list');
        if (this.failList)
            throw new Error('Background bridge failed.');
        this.activeTurnCancellable = options.cancellable ?? null;
        return { windows: [{ id: `${this.name}-window` }] };
    }
    async captureDesktopPreview() {
        this.calls.push('preview');
        return { width: 1, height: 1, bytes: new Uint8Array([1]) };
    }
    isTurnActive() { return false; }
    finishTurn(cancellable) {
        if (this.activeTurnCancellable !== cancellable)
            return false;
        this.calls.push('finish');
        this.activeTurnCancellable = null;
        return true;
    }
    stop() { this.calls.push('stop'); return false; }
    shutdown() {
        this.calls.push('shutdown');
        this.activeTurnCancellable = null;
    }
}

const current = new FakeDesktop('current-desktop');
const background = new FakeDesktop('background');
const manager = new ComputerUseManager({
    settings: { computerUseMode: 'current-desktop', computerUseCaptureEnabled: true },
    currentDesktop: current,
    background,
});

assert(manager.mode === 'background', 'A legacy Current desktop value must not override the per-turn Background default.');
background.failList = true;
let failed = false;
try {
    await manager.listDesktop();
} catch (error) {
    failed = error.message === 'Background bridge failed.';
}
assert(failed && current.calls.length === 0,
    'A failed background request must never fall back to the physical desktop.');
background.failList = false;

const preview = await manager.captureBackgroundDesktopPreview();
assert(preview.width === 1 && background.calls.includes('preview') && !current.calls.includes('preview'),
    'A desktop preview must capture only the background session.');

const listTool = createComputerUseTools(manager).find(tool => tool.name === 'computer_list');
assert(listTool.inputSchema.properties.mode.enum.includes('current-desktop'),
    'The agent must be able to request Current desktop through computer_list.');
const firstTurn = new Gio.Cancellable();
const foreground = await listTool.run('{"mode":"current-desktop"}', { cancellable: firstTurn });
assert(foreground.desktop.mode === 'current-desktop' && current.activeTurnCancellable === firstTurn,
    'An explicit foreground request must select the physical session for this turn.');
let invalidModeRejected = false;
try {
    await manager.listDesktop({ mode: 'unsupported', cancellable: firstTurn });
} catch (_error) {
    invalidModeRejected = true;
}
assert(invalidModeRejected && manager.mode === 'current-desktop',
    'An invalid mode must be rejected before changing the active desktop.');
let otherTurnRejected = false;
try {
    await listTool.run('{}', { cancellable: new Gio.Cancellable() });
} catch (_error) {
    otherTurnRejected = true;
}
assert(otherTurnRejected && manager.mode === 'current-desktop' && !firstTurn.is_cancelled(),
    'Another chat must not switch an active foreground turn to Background.');
current.activeTurnCancellable = null;
let untrackedTurnRejected = false;
try {
    await listTool.run('{}', { cancellable: new Gio.Cancellable() });
} catch (_error) {
    untrackedTurnRejected = true;
}
current.activeTurnCancellable = firstTurn;
assert(untrackedTurnRejected && manager.mode === 'current-desktop',
    'A desktop selection must remain owned by its turn between active window operations.');
let currentPreviewRejected = false;
try {
    await manager.captureBackgroundDesktopPreview();
} catch (_error) {
    currentPreviewRejected = true;
}
assert(currentPreviewRejected, 'Current desktop must not be exposed through the background preview.');
const continued = await listTool.run('{}', { cancellable: firstTurn });
assert(continued.desktop.mode === 'current-desktop',
    'A later list in the same turn must stay on the selected foreground desktop.');
const switched = await listTool.run('{"mode":"background"}', { cancellable: firstTurn });
assert(switched.desktop.mode === 'background' && !firstTurn.is_cancelled()
    && current.calls.includes('finish'),
    'Switching desktops within one turn must release the old service without cancelling the agent.');
await listTool.run('{"mode":"current-desktop"}', { cancellable: firstTurn });
manager.finishTurn(firstTurn);
assert((await manager.status()).mode === 'background',
    'Settings must report the default Background integration after a foreground turn ends.');
const nextTurn = new Gio.Cancellable();
const nextDesktop = await listTool.run('{}', { cancellable: nextTurn });
assert(nextDesktop.desktop.mode === 'background' && manager.mode === 'background',
    'A new user turn must return to Background even after a foreground task.');
manager.finishTurn(nextTurn);
background.running = true;
assert(manager.stop() && background.calls.includes('shutdown'),
    'The stop control must close a running background session.');
manager.shutdown();

print('Background computer-use routing and browser-profile checks passed.');
