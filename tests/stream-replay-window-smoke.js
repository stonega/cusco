import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    createStreamReplayWindow,
    DEFAULT_STREAM_REPLAY_MESSAGE,
} from '../src/debug/streamReplayWindow.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

assert(
    DEFAULT_STREAM_REPLAY_MESSAGE.includes('### 9. 球迷与文化')
        && DEFAULT_STREAM_REPLAY_MESSAGE.includes('| 荣誉 | 次数 |'),
    'Stream Replay did not retain the reported multilingual Markdown sample',
);

if (Gtk.init_check()) {
    const visualMode = ARGV.includes('--visual');
    const window = createStreamReplayWindow(null, {
        initialMessage: visualMode
            ? DEFAULT_STREAM_REPLAY_MESSAGE
            : '**Hello** 世界\n\n- One\n- Two',
        motionEnabled: true,
    });

    window.present();
    await delay(30);
    assert(window.get_mapped(), 'Stream Replay window was not mapped');

    if (visualMode) {
        window.setReplayConfig({
            animationStyle: 'blurIn',
            providerIntervalMs: 42,
            providerUnitsPerChunk: 10,
            revealIntervalMs: 24,
            simulateFinalRevision: true,
        });
        void window.replayStream();
        await delay(15000);
        await window.stopReplay();
        window.set_content(null);
        await delay(30);
        window.destroy();
        await delay(30);
        print('Cusco stream replay window visual run passed');
    } else {
        window.setReplayConfig({
            animationStyle: 'fadeIn',
            animationDurationMs: 1,
            providerIntervalMs: 1,
            providerUnitsPerChunk: 4,
            revealIntervalMs: 1,
            idleFlushMs: 2,
            simulateFinalRevision: true,
            autoScroll: false,
        });

        const result = await window.replayStream();
        const state = window.getReplayState();

        assert(result.status === 'complete', 'Stream Replay did not complete');
        assert(state.phase === 'complete', 'Stream Replay retained a running state after completion');
        assert(
            state.visibleCharacters === state.targetCharacters,
            'Stream Replay did not reveal the exact final message',
        );

        window.setReplayMessage('A deliberately slower stream that can be stopped before delivery ends.');
        window.setReplayConfig({
            providerIntervalMs: 50,
            providerUnitsPerChunk: 1,
            revealIntervalMs: 20,
            simulateFinalRevision: false,
        });
        const stoppedReplay = window.replayStream();

        await delay(10);
        await window.stopReplay();
        assert(
            (await stoppedReplay).status === 'stopped',
            'Stopping Stream Replay did not settle its active replay',
        );
        assert(
            window.getReplayState().phase === 'stopped',
            'Stream Replay did not expose stopped state',
        );
        window.set_content(null);
        await delay(30);
        window.destroy();
        await delay(30);
    }
}

print('Cusco stream replay window smoke passed');
