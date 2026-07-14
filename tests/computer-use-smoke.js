import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { clutterKeySuffix } from '../data/gnome-shell/extensions/cusco-computer-use@stonega/keyNames.js';
import { ComputerUseService } from '../src/computerUse/service.js';
import { createComputerUseTools } from '../src/computerUse/tools.js';

if (clutterKeySuffix('Return') !== 'Return'
    || clutterKeySuffix('ENTER') !== 'Return'
    || clutterKeySuffix('page-down') !== 'Page_Down')
    throw new Error('Computer-use key aliases were not normalized');

const calls = [];
const service = {
    async listDesktop(options) {
        calls.push(['list', options]);
        return { workspaces: [{ index: 0, active: true }], windows: [] };
    },
    async observe(windowId, options) {
        calls.push(['observe', windowId, options]);
        return {
            window: { id: windowId, title: 'Test window' },
            width: 800,
            height: 600,
            mimeType: 'image/png',
            imagePath: '/tmp/test-window.png',
        };
    },
    async act(action, options) {
        calls.push(['act', action, options]);
        return { performed: action.action };
    },
};

const tools = createComputerUseTools(service);
const byName = new Map(tools.map(tool => [tool.name, tool]));

if (tools.length !== 3
    || !byName.has('computer_list')
    || !byName.has('computer_observe')
    || !byName.has('computer_act'))
    throw new Error('Computer-use tools were not created');

const list = await byName.get('computer_list').run('{}', { marker: 'list' });
if (!list.output.includes('workspaces'))
    throw new Error('Computer desktop list was not formatted');

const observation = await byName.get('computer_observe').run(
    '{"windowId":"42"}',
    { marker: 'observe' },
);
if (observation.imagePath !== '/tmp/test-window.png' || !observation.output.includes('window-relative'))
    throw new Error('Computer observation did not preserve its screenshot');

const action = await byName.get('computer_act').run(
    '{"action":"switch_workspace","workspaceIndex":1}',
    { marker: 'act' },
);
if (!action.output.includes('switch_workspace'))
    throw new Error('Computer action was not formatted');

let rejectedInvalidInput = false;
try {
    await byName.get('computer_observe').run('not-json');
} catch (error) {
    rejectedInvalidInput = Boolean(error.userMessage);
}
if (!rejectedInvalidInput)
    throw new Error('Invalid computer-use input was not rejected');

if (calls.length !== 3)
    throw new Error(`Unexpected computer-use call count: ${calls.length}`);

const png = new Uint8Array(24);
png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
png.set([0, 0, 0, 200], 16);
png.set([0, 0, 0, 100], 20);
const proxyCalls = [];
const fakeProxy = {
    get_name_owner() {
        return ':fake-shell';
    },
    connect() {
        return 1;
    },
    disconnect() {},
    call(method, parameters, _flags, _timeout, _cancellable, callback) {
        proxyCalls.push({ method, parameters: parameters?.deepUnpack?.() ?? [] });
        callback(this, { method });
    },
    call_finish(result) {
        const payloads = {
            Register: { protocolVersion: 1, registered: true },
            ListDesktop: { workspaces: [], windows: [] },
            CaptureWindow: {
                window: { id: '42', width: 100, height: 50 },
                width: 100,
                height: 50,
                mimeType: 'image/png',
                imageBase64: GLib.base64_encode(png),
            },
            PerformAction: { performed: 'click' },
        };
        return Object.hasOwn(payloads, result.method)
            ? new GLib.Variant('(s)', [JSON.stringify(payloads[result.method])])
            : new GLib.Variant('()', []);
    },
    call_sync() {
        return new GLib.Variant('()', []);
    },
};
const activeStates = [];
const computerUse = new ComputerUseService({
    proxy: fakeProxy,
    cacheDirectory: GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `cusco-computer-use-test-${GLib.uuid_string_random()}`,
    ]),
    settings: {
        computerUseEnabled: true,
        computerUseCaptureEnabled: true,
        computerUseInputEnabled: true,
        computerUseWorkspaceSwitchingEnabled: true,
        computerUseActionTimeoutSeconds: 30,
    },
    onActiveChanged: active => activeStates.push(active),
});
const captured = await computerUse.observe('42');
if (captured.width !== 200 || captured.height !== 100 || !GLib.file_test(captured.imagePath, GLib.FileTest.EXISTS))
    throw new Error('Computer-use service did not persist and measure the screenshot');

await computerUse.act({ action: 'click', windowId: '42', x: 100, y: 50 });
const performed = proxyCalls.find(call => call.method === 'PerformAction');
const performedInput = JSON.parse(performed.parameters[0]);
if (performedInput.x !== 50 || performedInput.y !== 25)
    throw new Error(`HiDPI coordinate mapping failed: ${performed.parameters[0]}`);

if (activeStates.join(',') !== 'true,false,true,false')
    throw new Error(`Computer-use active state did not balance: ${activeStates.join(',')}`);

const turnCancellable = new Gio.Cancellable();
await computerUse.act(
    { action: 'keypress', windowId: '42', keys: ['Return'] },
    { cancellable: turnCancellable },
);
await computerUse.act(
    { action: 'keypress', windowId: '42', keys: ['Return'] },
    { cancellable: turnCancellable },
);
if (!computerUse.active || activeStates.join(',') !== 'true,false,true,false,true')
    throw new Error(`Computer-use indicator did not stay active for the turn: ${activeStates.join(',')}`);
if (!computerUse.finishTurn(turnCancellable) || computerUse.active)
    throw new Error('Computer-use turn did not finish cleanly');
if (activeStates.join(',') !== 'true,false,true,false,true,false')
    throw new Error(`Computer-use turn state did not balance: ${activeStates.join(',')}`);
const remoteActiveStates = proxyCalls
    .filter(call => call.method === 'SetActive')
    .map(call => String(call.parameters[0]));
if (remoteActiveStates.join(',') !== 'true,false,true,false,true,false')
    throw new Error(`GNOME indicator state flickered during the turn: ${remoteActiveStates.join(',')}`);

computerUse.shutdown();
if (GLib.file_test(captured.imagePath, GLib.FileTest.EXISTS))
    throw new Error('Computer-use screenshot cache was not removed on shutdown');

print('Cusco computer-use smoke passed');
