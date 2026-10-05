import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { ComputerUseManager } from '../packages/computerUse/manager.js';

function delay(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

const manager = new ComputerUseManager({ settings: {
    computerUseEnabled: true,
    computerUseCaptureEnabled: true,
    computerUseInputEnabled: true,
} });

try {
    await manager.listDesktop();
    await manager.launchApplication('Calculator');
    let calculator;
    for (let attempt = 0; attempt < 30; attempt++) {
        calculator = (await manager.listDesktop()).windows.find(window => window.appName.includes('Calculator'));
        if (calculator?.width > 0 && calculator?.height > 0)
            break;
        await delay(200);
    }
    if (!calculator || calculator.width <= 0 || calculator.height <= 0)
        throw new Error('Calculator did not open on the background desktop.');

    const owner = new Gio.Cancellable();
    await manager.listDesktop({ cancellable: owner });
    await manager.takeOverBackgroundDesktop();
    if (!owner.is_cancelled() || !manager.backgroundRunning)
        throw new Error('Take over did not stop the agent while preserving its desktop.');
    // A fresh headless GNOME session can initially show Overview.
    await manager.sendBackgroundDesktopInput({ type: 'key', keyval: 0xff1b, pressed: true });
    await manager.sendBackgroundDesktopInput({ type: 'key', keyval: 0xff1b, pressed: false });
    await delay(300);
    const point = { x: calculator.x + 60, y: calculator.y + 15 };
    await manager.sendBackgroundDesktopInput({ type: 'motion', ...point });
    await manager.sendBackgroundDesktopInput({ type: 'button', ...point, button: 1, pressed: true });
    await manager.sendBackgroundDesktopInput({ type: 'button', ...point, button: 1, pressed: false });
    await delay(150);
    const before = await manager.captureBackgroundDesktopPreview();
    await manager.sendBackgroundDesktopInput({ type: 'key', keyval: 55, pressed: true });
    await manager.sendBackgroundDesktopInput({ type: 'key', keyval: 55, pressed: false });
    await delay(150);
    const after = await manager.captureBackgroundDesktopPreview();
    if (GLib.base64_encode(before.bytes) === GLib.base64_encode(after.bytes))
        throw new Error('Manual keyboard input did not change the Calculator desktop.');
    await manager.sendBackgroundDesktopInput({ type: 'scroll', ...point, deltaX: 0, deltaY: 15 });
    await manager.sendBackgroundDesktopInput({ type: 'key', keyval: 0xffe1, pressed: true });
    await manager.releaseBackgroundDesktopControl();
    await manager.listDesktop();
    print('Live background desktop takeover, pointer, keyboard, scroll, and release passed.');
} finally {
    manager.shutdown();
    await delay(500);
}
