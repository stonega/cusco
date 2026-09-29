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

const settings = {
    computerUseEnabled: true,
    computerUseCaptureEnabled: true,
    computerUseInputEnabled: true,
    computerUseWorkspaceSwitchingEnabled: true,
    computerUseActionTimeoutSeconds: 30,
};
const manager = new ComputerUseManager({ settings });

try {
    const initial = await manager.listDesktop();
    if (initial.mode !== 'background' || !Array.isArray(initial.workspaces))
        throw new Error('Computer Use did not route to the background desktop.');

    const launch = await manager.launchApplication('Calculator');
    if (!launch.launched || launch.mode !== 'background')
        throw new Error('Calculator was not launched in background mode.');
    let calculator = null;

    for (let attempt = 0; attempt < 30; attempt++) {
        const desktop = await manager.listDesktop();
        calculator = desktop.windows?.find(window => (
            String(window.appName ?? window.title).includes('Calculator')
        )) ?? null;
        if (calculator)
            break;
        await delay(200);
    }

    if (!calculator)
        throw new Error('Calculator did not open on the background desktop.');

    const observation = await manager.observe(calculator.id);
    if (!observation.imagePath || !GLib.file_test(observation.imagePath, GLib.FileTest.EXISTS))
        throw new Error('The background window screenshot was not saved.');
    const preview = await manager.captureBackgroundDesktopPreview();
    if (preview.width < 1 || preview.height < 1
        || preview.bytes.length < 8
        || preview.bytes[0] !== 0x89 || preview.bytes[1] !== 0x50) {
        throw new Error('The background desktop preview did not return a PNG screenshot.');
    }
    if (!observation.accessibility?.available)
        throw new Error(`Calculator did not connect to AT-SPI: ${observation.accessibility?.reason}`);

    const step = await manager.step([{
        action: 'keypress',
        windowId: calculator.id,
        observationId: observation.observationId,
        keys: ['1'],
    }], { settleMs: 150 });
    if (step.failure || !step.observation?.observationId)
        throw new Error(`The background input step failed: ${step.failure?.message ?? 'no new observation'}`);

    if (GLib.getenv('CUSCO_TEST_BACKGROUND_FIREFOX') === '1') {
        await manager.launchApplication('org.mozilla.firefox.desktop');
        let firefox = null;
        for (let attempt = 0; attempt < 80; attempt++) {
            const desktop = await manager.listDesktop();
            firefox = desktop.windows?.find(window => (
                String(window.appName ?? window.title).includes('Firefox')
            )) ?? null;
            if (firefox)
                break;
            await delay(250);
        }
        if (!firefox)
            throw new Error('Firefox did not open in the background desktop.');
        print(`Background Firefox opened as window ${firefox.id}.`);
    }

    if (GLib.getenv('CUSCO_TEST_BACKGROUND_ATSPI') === '1') {
        await manager.launchApplication('org.gnome.TextEditor.desktop');
        let textEditor = null;
        for (let attempt = 0; attempt < 30; attempt++) {
            const desktop = await manager.listDesktop();
            textEditor = desktop.windows?.find(window => (
                String(window.appName ?? window.title).includes('Text Editor')
            )) ?? null;
            if (textEditor)
                break;
            await delay(200);
        }
        if (!textEditor)
            throw new Error('Text Editor did not open in the background desktop.');
        const semantic = await manager.observe(textEditor.id);
        if (!semantic.accessibility?.available || semantic.accessibility.elements.length === 0)
            throw new Error(`Text Editor did not expose semantic elements: ${semantic.accessibility?.reason ?? 'empty tree'}`);
        print(`Background Text Editor exposed ${semantic.accessibility.elements.length} AT-SPI elements.`);
    }

    print(`Background Computer Use observed and controlled Calculator (${observation.window.width}×${observation.window.height}; AT-SPI ${observation.accessibility?.available ? 'available' : `unavailable: ${observation.accessibility?.reason}`}; bridge ${Boolean(manager._background._runtime.accessibilityProxy)}).`);
} finally {
    const runtimeDirectory = manager._background._runtime._runtimeDirectory;
    manager.shutdown();
    await delay(500);
    if (runtimeDirectory && GLib.file_test(runtimeDirectory, GLib.FileTest.EXISTS))
        throw new Error('The background runtime directory was not removed.');
}
