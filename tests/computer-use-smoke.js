import Cairo from 'cairo';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { clutterKeySuffix } from '../data/gnome-shell/extensions/cusco-computer-use@stonega/keyNames.js';
import {
    describeComputerUseOperation,
    ellipsizeIndicatorStatus,
    MAX_INDICATOR_STATUS_CHARACTERS,
} from '../data/gnome-shell/extensions/cusco-computer-use@stonega/indicatorStatus.js';
import { activateWindowIfNeeded } from '../data/gnome-shell/extensions/cusco-computer-use@stonega/windowFocus.js';
import { ComputerUseService } from '../src/computerUse/service.js';
import { createComputerUseTools } from '../src/computerUse/tools.js';

const [, indicatorStylesheetBytes] = GLib.file_get_contents(
    'data/gnome-shell/extensions/cusco-computer-use@stonega/stylesheet.css',
);
const indicatorStylesheet = new TextDecoder().decode(indicatorStylesheetBytes);
const iconStyle = /\.cusco-computer-use-icon\s*\{([^}]*)\}/.exec(indicatorStylesheet)?.[1] ?? '';
if (!iconStyle.includes('-st-icon-style: symbolic')
    || !iconStyle.includes('color: #42e6f5')
    || !indicatorStylesheet.includes(
        '.cusco-computer-use-button:hover .cusco-computer-use-icon',
    )) {
    throw new Error('Computer-use indicator icon did not preserve its cyan symbolic color');
}

if (clutterKeySuffix('Return') !== 'Return'
    || clutterKeySuffix('ENTER') !== 'Return'
    || clutterKeySuffix('Escape') !== 'Escape'
    || clutterKeySuffix('TAB') !== 'Tab'
    || clutterKeySuffix('backspace') !== 'BackSpace'
    || clutterKeySuffix('page-down') !== 'Page_Down')
    throw new Error('Computer-use key aliases were not normalized');

const focusCalls = [];
const alreadyFocusedWindow = {
    minimized: false,
    unminimize() {
        focusCalls.push('unminimize');
    },
    activate(timestamp) {
        focusCalls.push(`activate:${timestamp}`);
    },
};
if (activateWindowIfNeeded(alreadyFocusedWindow, alreadyFocusedWindow, 10)
    || focusCalls.length !== 0) {
    throw new Error('An already-focused window was activated again');
}
if (!activateWindowIfNeeded(alreadyFocusedWindow, {}, 20)
    || focusCalls.join(',') !== 'activate:20') {
    throw new Error('An unfocused window was not activated');
}
focusCalls.length = 0;
alreadyFocusedWindow.minimized = true;
if (!activateWindowIfNeeded(alreadyFocusedWindow, alreadyFocusedWindow, 30)
    || focusCalls.join(',') !== 'unminimize,activate:30') {
    throw new Error('A minimized focused window was not restored and activated');
}

const longWindowStatus = describeComputerUseOperation('capture', {
    windowTitle: 'A very long application window title that should not take over the top panel',
});
if (longWindowStatus.length > MAX_INDICATOR_STATUS_CHARACTERS
    || !longWindowStatus.endsWith('…')
    || describeComputerUseOperation('type', { windowTitle: 'Terminal' }) !== 'Typing in Terminal'
    || describeComputerUseOperation('switch_workspace', { workspaceIndex: 1 }) !== 'Switching to workspace 2'
    || ellipsizeIndicatorStatus('  Checking   desktop  ') !== 'Checking desktop') {
    throw new Error('Computer-use indicator descriptions were not normalized or ellipsized');
}

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
            modelImagePath: '/tmp/test-window-grid.png',
        };
    },
    async observeRegion(windowId, observationId, region) {
        calls.push(['region', windowId, observationId, region]);
        return {
            window: { id: windowId, title: 'Test window' },
            width: 1200,
            height: 600,
            observationId: 'region-observation',
            parentObservationId: observationId,
            mimeType: 'image/png',
            imagePath: '/tmp/test-window-region.png',
            modelImagePath: '/tmp/test-window-region-grid.png',
            view: { type: 'region', normalized: region },
        };
    },
    async act(action, options) {
        calls.push(['act', action, options]);
        return { performed: action.action };
    },
    async step(actions, options) {
        calls.push(['step', actions, options]);
        return {
            performed: actions.map(action => action.action),
            results: actions.map(action => ({ performed: action.action })),
            verification: {
                screenChanged: true,
                focused: true,
                unchangedCount: 0,
                stalled: false,
                inputVerified: null,
                coordinateRetryBlocked: false,
            },
            observation: {
                window: { id: actions[0].windowId, title: 'Updated test window', focused: true },
                width: 800,
                height: 600,
                observationId: 'next-observation',
                mimeType: 'image/png',
                imagePath: '/tmp/updated-test-window.png',
            },
        };
    },
};

const tools = createComputerUseTools(service);
const byName = new Map(tools.map(tool => [tool.name, tool]));

if (tools.length !== 5
    || !byName.has('computer_list')
    || !byName.has('computer_observe')
    || !byName.has('computer_observe_region')
    || !byName.has('computer_step')
    || !byName.has('computer_act'))
    throw new Error('Computer-use tools were not created');

const desktopActionNames = byName.get('computer_act').inputSchema.properties.action.enum;
const stepActionNames = byName.get('computer_step')
    .inputSchema.properties.actions.items.properties.action.enum;
const stepActionProperties = byName.get('computer_step')
    .inputSchema.properties.actions.items.properties;
if (!['create_workspace', 'move_to_workspace', 'maximize'].every(actionName => (
    desktopActionNames.includes(actionName)
)) || !['move_to_workspace', 'maximize'].every(actionName => stepActionNames.includes(actionName))
    || stepActionNames.includes('create_workspace')
    || stepActionProperties.replace.type !== 'boolean') {
    throw new Error('Computer-use workspace and maximize actions were not exposed correctly');
}
if (!byName.get('computer_step').description.includes('replace:true')
    || !byName.get('computer_step').description.includes('normalized')
    || !byName.get('computer_step').description.includes('computer_observe_region')) {
    throw new Error('Computer step did not describe safe visual targeting');
}

const list = await byName.get('computer_list').run('{}', { marker: 'list' });
if (!list.output.includes('workspaces'))
    throw new Error('Computer desktop list was not formatted');

const observation = await byName.get('computer_observe').run(
    '{"windowId":"42"}',
    { marker: 'observe' },
);
if (observation.imagePath !== '/tmp/test-window.png'
    || observation.modelImagePath !== '/tmp/test-window-grid.png'
    || !observation.output.includes('synthetic normalized coordinate grid')) {
    throw new Error('Computer observation did not preserve its screenshot');
}

const regionObservation = await byName.get('computer_observe_region').run(JSON.stringify({
    windowId: '42',
    observationId: 'first-observation',
    region: { x: 250, y: 250, width: 500, height: 500 },
}));
if (regionObservation.observationId !== 'region-observation'
    || regionObservation.modelImagePath !== '/tmp/test-window-region-grid.png'
    || !regionObservation.output.includes('local to this region')) {
    throw new Error('Computer region observation was not formatted');
}

const action = await byName.get('computer_act').run(
    '{"action":"switch_workspace","workspaceIndex":1}',
    { marker: 'act' },
);
if (!action.output.includes('switch_workspace'))
    throw new Error('Computer action was not formatted');

for (const input of [
    { action: 'create_workspace' },
    { action: 'move_to_workspace', windowId: '42', workspaceIndex: 1 },
    { action: 'maximize', windowId: '42' },
]) {
    const result = await byName.get('computer_act').run(
        JSON.stringify(input),
        { marker: input.action },
    );
    if (!result.output.includes(input.action))
        throw new Error(`Computer action ${input.action} was not formatted`);
}

const step = await byName.get('computer_step').run(JSON.stringify({
    windowId: '42',
    observationId: 'first-observation',
    actions: [
        { action: 'click', x: 500, y: 250 },
    ],
    settleMs: 0,
}), { marker: 'step' });
if (step.imagePath !== '/tmp/updated-test-window.png'
    || !step.output.includes('post-action screenshot')
    || !step.output.includes('remains visually unverified')
    || step.verification.coordinateActionVerified !== false
    || step.performed.join(',') !== 'click') {
    throw new Error('Computer step did not return its post-action observation');
}
const stepCall = calls.find(call => call[0] === 'step');
if (stepCall[1][0].coordinateSpace !== 'normalized_1000'
    || stepCall[1][0].windowId !== '42') {
    throw new Error('Computer step did not normalize its action coordinates');
}

const atomicTypeStep = await byName.get('computer_step').run(JSON.stringify({
    windowId: '42',
    observationId: 'next-observation',
    actions: [
        { action: 'type', x: 455, y: 275, text: 'wallet-address' },
    ],
    settleMs: 0,
}));
const atomicTypeCall = calls.filter(call => call[0] === 'step').at(-1);
if (atomicTypeCall[1].length !== 1
    || atomicTypeCall[1][0].action !== 'type'
    || atomicTypeCall[1][0].x !== 455
    || atomicTypeCall[1][0].y !== 275
    || atomicTypeCall[1][0].text !== 'wallet-address'
    || atomicTypeStep.verification.coordinateActionVerified !== false
    || !atomicTypeStep.output.includes('visually unverified')) {
    throw new Error('Computer step did not preserve atomic coordinate-targeted typing');
}

const normalizedInsertStep = await byName.get('computer_step').run(JSON.stringify({
    windowId: '42',
    observationId: 'first-observation',
    actions: [
        { action: 'click', x: 500, y: 250 },
        { action: 'type', text: 'Hello' },
    ],
}));
const normalizedInsertCall = calls.filter(call => call[0] === 'step').at(-1);
if (normalizedInsertCall[1].length !== 1
    || normalizedInsertCall[1][0].action !== 'type'
    || normalizedInsertCall[1][0].x !== 500
    || normalizedInsertCall[1][0].y !== 250
    || normalizedInsertCall[1][0].replace !== undefined
    || normalizedInsertStep.actionNormalization?.mode !== 'insert') {
    throw new Error('Computer step did not normalize click and type into atomic input');
}

const replacementText = 'HJiJBLfTUZTXsU2Sv7Qpq2L6micuX1rjpLhBtrcQ5rRd';
const normalizedReplaceStep = await byName.get('computer_step').run(JSON.stringify({
    windowId: '42',
    observationId: 'region-observation',
    actions: [
        { action: 'click', x: 400, y: 400 },
        { action: 'keypress', keys: ['CTRL', 'A'] },
        { action: 'type', text: replacementText },
    ],
}));
const normalizedReplaceCall = calls.filter(call => call[0] === 'step').at(-1);
if (normalizedReplaceCall[1].length !== 1
    || normalizedReplaceCall[1][0].action !== 'type'
    || normalizedReplaceCall[1][0].x !== 400
    || normalizedReplaceCall[1][0].y !== 400
    || normalizedReplaceCall[1][0].replace !== true
    || normalizedReplaceCall[1][0].text !== replacementText
    || normalizedReplaceStep.actionNormalization?.mode !== 'replace'
    || normalizedReplaceStep.verification.coordinateActionVerified !== false
    || !normalizedReplaceStep.output.includes('"requestedActions"')) {
    throw new Error('Computer step did not normalize visual field replacement atomically');
}

let unsafeBatchRejected = false;
try {
    await byName.get('computer_step').run(JSON.stringify({
        windowId: '42',
        observationId: 'first-observation',
        actions: [
            { action: 'click', x: 500, y: 250 },
            { action: 'keypress', keys: ['Return'] },
        ],
    }));
} catch (error) {
    unsafeBatchRejected = error.userMessage?.includes('cannot safely batch');
}
if (!unsafeBatchRejected)
    throw new Error('Computer step allowed an arbitrary coordinate click and keyboard batch');

let incompleteAtomicTargetRejected = false;
try {
    await byName.get('computer_step').run(JSON.stringify({
        windowId: '42',
        observationId: 'first-observation',
        actions: [
            { action: 'type', x: 500, text: 'Hello' },
        ],
    }));
} catch (error) {
    incompleteAtomicTargetRejected = error.userMessage?.includes('both x and y');
}
if (!incompleteAtomicTargetRejected)
    throw new Error('Computer step allowed an incomplete atomic type target');

let invalidReplaceRejected = false;
try {
    await byName.get('computer_step').run(JSON.stringify({
        windowId: '42',
        observationId: 'first-observation',
        actions: [
            { action: 'type', text: 'Hello', replace: true },
        ],
    }));
} catch (error) {
    invalidReplaceRejected = error.userMessage?.includes('replace is only supported');
}
if (!invalidReplaceRejected)
    throw new Error('Computer step allowed replacement without a visual field target');

let rejectedInvalidInput = false;
try {
    await byName.get('computer_observe').run('not-json');
} catch (error) {
    rejectedInvalidInput = Boolean(error.userMessage);
}
if (!rejectedInvalidInput)
    throw new Error('Invalid computer-use input was not rejected');

if (calls.length !== 11)
    throw new Error(`Unexpected computer-use call count: ${calls.length}`);

const fixturePath = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-computer-use-fixture-${GLib.uuid_string_random()}.png`,
]);
const fixtureSurface = new Cairo.ImageSurface(Cairo.Format.RGB24, 200, 100);
const fixtureContext = new Cairo.Context(fixtureSurface);
fixtureContext.setSourceRGB(0.08, 0.09, 0.1);
fixtureContext.paint();
fixtureSurface.writeToPNG(fixturePath);
fixtureContext.$dispose();
fixtureSurface.finish();
const [, png] = GLib.file_get_contents(fixturePath);
GLib.unlink(fixturePath);
const proxyCalls = [];
let staleRegistration = true;
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
        if (result.method === 'CaptureWindow' && staleRegistration) {
            staleRegistration = false;
            throw new Error(
                'GDBus.Error:io.github.stonega.Cusco.ComputerUse.Error: Caller is not the registered Cusco process.',
            );
        }

        const performedRequest = result.method === 'PerformAction'
            ? JSON.parse(proxyCalls.filter(call => call.method === 'PerformAction').at(-1).parameters[0])
            : null;
        const performedCoordinates = performedRequest && Number.isFinite(performedRequest.x)
            ? {
                window: { x: performedRequest.x, y: performedRequest.y },
                desktop: { x: performedRequest.x + 10, y: performedRequest.y + 20 },
            }
            : null;
        const payloads = {
            Register: { protocolVersion: 4, registered: true },
            ListDesktop: { workspaces: [], windows: [] },
            CaptureWindow: {
                window: { id: '42', width: 100, height: 60 },
                width: 100,
                height: 50,
                mimeType: 'image/png',
                imageBase64: GLib.base64_encode(png),
            },
            PerformAction: {
                performed: performedRequest?.action ?? 'click',
                coordinates: performedCoordinates,
            },
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
const fakeAccessibility = {
    observe() {
        return {
            available: false,
            source: 'at-spi',
            reason: 'Fake accessibility service.',
            elements: [],
        };
    },
    activate(ref) {
        return {
            performed: 'click_element',
            dispatchStatus: 'focused',
            verified: false,
            focusVerified: true,
            activationKey: 'Return',
            element: { ref, role: 'list item', name: 'Podcasts' },
        };
    },
    shutdown() {},
};
const computerUseSettings = {
    computerUseEnabled: true,
    computerUseCaptureEnabled: true,
    computerUseInputEnabled: true,
    computerUseWorkspaceSwitchingEnabled: true,
    computerUseActionTimeoutSeconds: 30,
};
const computerUse = new ComputerUseService({
    proxy: fakeProxy,
    accessibility: fakeAccessibility,
    environmentStatus: () => ({ supported: true, reason: '' }),
    cacheDirectory: GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `cusco-computer-use-test-${GLib.uuid_string_random()}`,
    ]),
    settings: computerUseSettings,
    onActiveChanged: active => activeStates.push(active),
});
const captured = await computerUse.observe('42');
if (captured.width !== 200
    || captured.height !== 100
    || captured.agentProtocolVersion !== 4
    || !captured.observationId
    || captured.coordinateSpace?.normalized?.width !== 1000
    || !captured.grid?.enabled
    || captured.modelImagePath === captured.imagePath
    || !GLib.file_test(captured.imagePath, GLib.FileTest.EXISTS)
    || !GLib.file_test(captured.modelImagePath, GLib.FileTest.EXISTS)) {
    throw new Error('Computer-use service did not persist and measure the screenshot');
}
if (proxyCalls.filter(call => call.method === 'Register').length !== 2
    || proxyCalls.filter(call => call.method === 'CaptureWindow').length !== 2) {
    throw new Error('Computer-use service did not recover a stale extension registration');
}

const pixelAction = await computerUse.act({
    action: 'click',
    windowId: '42',
    observationId: captured.observationId,
    coordinateSpace: 'screenshot_pixels',
    x: 100,
    y: 50,
});
let performed = proxyCalls.filter(call => call.method === 'PerformAction').at(-1);
const performedInput = JSON.parse(performed.parameters[0]);
if (performedInput.x !== 50 || performedInput.y !== 30)
    throw new Error(`HiDPI coordinate mapping failed: ${performed.parameters[0]}`);
if (pixelAction.coordinates?.requested?.x !== 100
    || pixelAction.coordinates?.screenshot?.x !== 100
    || pixelAction.coordinates?.window?.x !== 50
    || pixelAction.coordinates?.window?.y !== 30
    || pixelAction.coordinates?.desktop?.x !== 60) {
    throw new Error(`Pixel coordinate trace failed: ${JSON.stringify(pixelAction)}`);
}

const normalizedAction = await computerUse.act({
    action: 'click',
    windowId: '42',
    observationId: captured.observationId,
    coordinateSpace: 'normalized_1000',
    x: 500,
    y: 500,
});
performed = proxyCalls.filter(call => call.method === 'PerformAction').at(-1);
const normalizedInput = JSON.parse(performed.parameters[0]);
if (normalizedInput.x !== 50 || normalizedInput.y !== 30)
    throw new Error(`Normalized coordinate mapping failed: ${performed.parameters[0]}`);
if (normalizedAction.coordinates?.requested?.x !== 500
    || normalizedAction.coordinates?.screenshot?.x !== 100
    || normalizedAction.coordinates?.window?.y !== 30
    || normalizedAction.coordinates?.desktop?.y !== 50) {
    throw new Error(`Normalized coordinate trace failed: ${JSON.stringify(normalizedAction)}`);
}

const regionView = await computerUse.observeRegion('42', captured.observationId, {
    x: 250,
    y: 200,
    width: 500,
    height: 600,
});
if (regionView.width !== 1200
    || regionView.height !== 720
    || regionView.view?.type !== 'region'
    || regionView.parentObservationId !== captured.observationId
    || !regionView.grid?.enabled) {
    throw new Error(`Computer-use region view was incorrect: ${JSON.stringify(regionView)}`);
}
const nestedRegionView = await computerUse.observeRegion('42', regionView.observationId, {
    x: 250,
    y: 250,
    width: 500,
    height: 500,
});
if (nestedRegionView.view?.normalized?.x !== 375
    || nestedRegionView.view?.normalized?.y !== 350
    || nestedRegionView.view?.normalized?.width !== 250
    || nestedRegionView.view?.normalized?.height !== 300) {
    throw new Error(`Nested region was not flattened to root coordinates: ${JSON.stringify(nestedRegionView.view)}`);
}
let ineffectiveRegionRejected = false;
try {
    await computerUse.observeRegion('42', regionView.observationId, {
        x: 0,
        y: 0,
        width: 950,
        height: 950,
    });
} catch (error) {
    ineffectiveRegionRejected = error.userMessage?.includes('too close to the full image');
}
if (!ineffectiveRegionRejected)
    throw new Error('A full-size region bypassed the coordinate retry strategy');

const regionAction = await computerUse.act({
    action: 'click',
    windowId: '42',
    observationId: regionView.observationId,
    coordinateSpace: 'normalized_1000',
    x: 500,
    y: 500,
});
performed = proxyCalls.filter(call => call.method === 'PerformAction').at(-1);
const regionInput = JSON.parse(performed.parameters[0]);
if (regionInput.x !== 50 || regionInput.y !== 30
    || regionAction.coordinates?.screenshot?.x !== 600
    || regionAction.coordinates?.screenshot?.y !== 360) {
    throw new Error(`Region coordinate mapping failed: ${JSON.stringify(regionAction)}`);
}

const semanticActivation = await computerUse.act({
    action: 'click_element',
    windowId: '42',
    ref: 'a11y:podcasts',
});
performed = proxyCalls.filter(call => call.method === 'PerformAction').at(-1);
const keyboardActivationInput = JSON.parse(performed.parameters[0]);
if (keyboardActivationInput.action !== 'keypress'
    || keyboardActivationInput.keys?.join(',') !== 'Return'
    || semanticActivation.verified
    || !semanticActivation.focusVerified
    || semanticActivation.dispatchStatus !== 'dispatched') {
    throw new Error('Focusable semantic element was not activated with Return');
}

const atomicInputStep = await computerUse.step([{
    action: 'type',
    windowId: '42',
    observationId: captured.observationId,
    coordinateSpace: 'normalized_1000',
    x: 500,
    y: 500,
    text: 'wallet-address',
}], { settleMs: 0 });
performed = proxyCalls.filter(call => call.method === 'PerformAction').at(-1);
const atomicInputRequest = JSON.parse(performed.parameters[0]);
if (atomicInputRequest.action !== 'type'
    || atomicInputRequest.x !== 50
    || atomicInputRequest.y !== 30
    || atomicInputRequest.text !== 'wallet-address'
    || atomicInputStep.results.length !== 1
    || atomicInputStep.verification.inputVerified !== null) {
    throw new Error(`Atomic coordinate input was not dispatched safely: ${JSON.stringify(atomicInputStep)}`);
}

const atomicReplaceStep = await computerUse.step([{
    action: 'type',
    windowId: '42',
    observationId: atomicInputStep.observation.observationId,
    coordinateSpace: 'normalized_1000',
    x: 500,
    y: 500,
    text: 'replacement-address',
    replace: true,
}], { settleMs: 0 });
performed = proxyCalls.filter(call => call.method === 'PerformAction').at(-1);
const atomicReplaceRequest = JSON.parse(performed.parameters[0]);
if (atomicReplaceRequest.action !== 'type'
    || atomicReplaceRequest.x !== 50
    || atomicReplaceRequest.y !== 30
    || atomicReplaceRequest.text !== 'replacement-address'
    || atomicReplaceRequest.replace !== true
    || atomicReplaceStep.results.length !== 1) {
    throw new Error(`Atomic coordinate replacement was not dispatched safely: ${JSON.stringify(atomicReplaceStep)}`);
}

let incompleteServiceTargetRejected = false;
try {
    await computerUse.act({
        action: 'type',
        windowId: '42',
        observationId: atomicReplaceStep.observation.observationId,
        coordinateSpace: 'normalized_1000',
        x: 500,
        text: 'unsafe',
    });
} catch (error) {
    incompleteServiceTargetRejected = error.userMessage?.includes('both x and y');
}
if (!incompleteServiceTargetRejected)
    throw new Error('Computer-use service allowed an incomplete atomic type target');

let invalidServiceReplaceRejected = false;
try {
    await computerUse.act({
        action: 'type',
        windowId: '42',
        observationId: atomicReplaceStep.observation.observationId,
        text: 'unsafe',
        replace: true,
    });
} catch (error) {
    invalidServiceReplaceRejected = error.userMessage?.includes('replace is only supported');
}
if (!invalidServiceReplaceRejected)
    throw new Error('Computer-use service allowed replacement without a coordinate target');

const recaptured = await computerUse.observe('42');
let staleRegionRejected = false;
try {
    await computerUse.act({
        action: 'click',
        windowId: '42',
        observationId: regionView.observationId,
        coordinateSpace: 'normalized_1000',
        x: 500,
        y: 500,
    });
} catch (error) {
    staleRegionRejected = error.userMessage?.includes('stale observation');
}
if (!staleRegionRejected || recaptured.observationId === captured.observationId)
    throw new Error('A region observation survived a new full-window capture');

let staleObservationRejected = false;
try {
    await computerUse.act({
        action: 'click',
        windowId: '42',
        observationId: 'stale-observation',
        coordinateSpace: 'normalized_1000',
        x: 500,
        y: 500,
    });
} catch (error) {
    staleObservationRejected = error.userMessage?.includes('stale observation');
}
if (!staleObservationRejected)
    throw new Error('Stale computer-use observation was not rejected');

let staleKeyboardActionRejected = false;
try {
    await computerUse.act({
        action: 'keypress',
        windowId: '42',
        observationId: 'stale-observation',
        keys: ['CTRL', 'ENTER'],
    });
} catch (error) {
    staleKeyboardActionRejected = error.userMessage?.includes('stale observation');
}
if (!staleKeyboardActionRejected)
    throw new Error('Stale keyboard submission was not rejected');

computerUseSettings.computerUseWorkspaceSwitchingEnabled = false;
for (const actionName of ['create_workspace', 'move_to_workspace', 'switch_workspace']) {
    let workspaceActionRejected = false;
    try {
        await computerUse.act({
            action: actionName,
            windowId: actionName === 'move_to_workspace' ? '42' : undefined,
            workspaceIndex: 1,
        });
    } catch (error) {
        workspaceActionRejected = error.userMessage?.includes('Workspace switching is disabled');
    }
    if (!workspaceActionRejected)
        throw new Error(`${actionName} bypassed the workspace permission gate`);
}
computerUseSettings.computerUseWorkspaceSwitchingEnabled = true;

let unsafeServiceBatchRejected = false;
try {
    await computerUse.step([
        {
            action: 'click',
            windowId: '42',
            observationId: recaptured.observationId,
            coordinateSpace: 'normalized_1000',
            x: 500,
            y: 500,
        },
        { action: 'type', windowId: '42', text: 'unsafe' },
    ]);
} catch (error) {
    unsafeServiceBatchRejected = error.userMessage?.includes('Do not batch');
}
if (!unsafeServiceBatchRejected)
    throw new Error('Computer-use service allowed an unverified click and input batch');

function assertBalancedStateTransitions(states, label) {
    if (states.length % 2 !== 0)
        throw new Error(`${label} left an active transition open: ${states.join(',')}`);

    for (let index = 0; index < states.length; index += 2) {
        if (states[index] !== true || states[index + 1] !== false)
            throw new Error(`${label} produced unbalanced transitions: ${states.join(',')}`);
    }
}

assertBalancedStateTransitions(activeStates, 'Computer-use active state');
const balancedActiveStateCount = activeStates.length;

const turnCancellable = new Gio.Cancellable();
await computerUse.act(
    { action: 'keypress', windowId: '42', keys: ['Return'] },
    { cancellable: turnCancellable },
);
await computerUse.act(
    { action: 'keypress', windowId: '42', keys: ['Return'] },
    { cancellable: turnCancellable },
);
const firstStep = await computerUse.step(
    [{
        action: 'click',
        windowId: '42',
        coordinateSpace: 'normalized_1000',
        x: 500,
        y: 500,
    }],
    { cancellable: turnCancellable, settleMs: 0 },
);
const stalledStep = await computerUse.step(
    [{
        action: 'click',
        windowId: '42',
        coordinateSpace: 'normalized_1000',
        x: 500,
        y: 500,
    }],
    { cancellable: turnCancellable, settleMs: 0 },
);
if (firstStep.verification.screenChanged !== false
    || firstStep.verification.unchangedCount !== 1
    || stalledStep.verification.stalled !== true
    || stalledStep.verification.coordinateMissCount !== 2
    || stalledStep.verification.coordinateRetryBlocked !== true
    || !stalledStep.observation.imagePath) {
    throw new Error('Computer-use step did not detect repeated unchanged observations');
}

let thirdCoordinateRejected = false;
try {
    await computerUse.step([{
        action: 'click',
        windowId: '42',
        observationId: stalledStep.observation.observationId,
        coordinateSpace: 'normalized_1000',
        x: 500,
        y: 500,
    }], { cancellable: turnCancellable, settleMs: 0 });
} catch (error) {
    thirdCoordinateRejected = error.userMessage?.includes('Coordinate targeting is blocked');
}
if (!thirdCoordinateRejected)
    throw new Error('Repeated full-window coordinate targeting was not blocked');

const recoveryView = await computerUse.observeRegion(
    '42',
    stalledStep.observation.observationId,
    { x: 250, y: 200, width: 500, height: 600 },
);
const recoveryStep = await computerUse.step([{
    action: 'click',
    windowId: '42',
    observationId: recoveryView.observationId,
    coordinateSpace: 'normalized_1000',
    x: 500,
    y: 500,
}], { cancellable: turnCancellable, settleMs: 0 });
if (recoveryStep.verification.coordinateMissCount !== 1
    || recoveryStep.verification.coordinateRetryBlocked) {
    throw new Error('A region observation did not unlock a safer coordinate retry');
}
if (!computerUse.active
    || activeStates.length !== balancedActiveStateCount + 1
    || activeStates.at(-1) !== true) {
    throw new Error(`Computer-use indicator did not stay active for the turn: ${activeStates.join(',')}`);
}
if (!computerUse.finishTurn(turnCancellable) || computerUse.active)
    throw new Error('Computer-use turn did not finish cleanly');
if (activeStates.length !== balancedActiveStateCount + 2 || activeStates.at(-1) !== false)
    throw new Error(`Computer-use turn state did not balance: ${activeStates.join(',')}`);
assertBalancedStateTransitions(activeStates, 'Computer-use turn state');
const remoteActiveStates = proxyCalls
    .filter(call => call.method === 'SetActive')
    .map(call => String(call.parameters[0]));
if (remoteActiveStates.join(',') !== activeStates.map(String).join(','))
    throw new Error(`GNOME indicator state flickered during the turn: ${remoteActiveStates.join(',')}`);

computerUse.shutdown();
if (GLib.file_test(captured.imagePath, GLib.FileTest.EXISTS)
    || GLib.file_test(captured.modelImagePath, GLib.FileTest.EXISTS)) {
    throw new Error('Computer-use screenshot cache was not removed on shutdown');
}

print('Cusco computer-use smoke passed');
