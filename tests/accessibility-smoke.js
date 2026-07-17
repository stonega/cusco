import { AccessibilitySnapshotService } from '../src/computerUse/accessibility.js';
import { evaluateComputerUseExpectations } from '../src/computerUse/service.js';

const StateType = {
    ACTIVE: 'active',
    CHECKED: 'checked',
    EDITABLE: 'editable',
    ENABLED: 'enabled',
    FOCUSABLE: 'focusable',
    FOCUSED: 'focused',
    PRESSED: 'pressed',
    SELECTED: 'selected',
    SENSITIVE: 'sensitive',
    SHOWING: 'showing',
    VISIBLE: 'visible',
};

class FakeAccessible {
    constructor(options = {}) {
        this.name = options.name ?? '';
        this.description = options.description ?? '';
        this.role = options.role ?? 'panel';
        this.pid = options.pid ?? 0;
        this.bounds = options.bounds ?? null;
        this.states = new Set(options.states ?? []);
        this.children = options.children ?? [];
        this.actions = options.actions ?? [];
        this.value = options.value ?? '';
        this.focused = false;
    }

    get_name() {
        return this.name;
    }

    get_description() {
        return this.description;
    }

    get_role_name() {
        return this.role;
    }

    get_process_id() {
        return this.pid;
    }

    get_child_count() {
        return this.children.length;
    }

    get_child_at_index(index) {
        return this.children[index] ?? null;
    }

    get_state_set() {
        return {
            contains: state => this.states.has(state),
        };
    }

    get_component_iface() {
        if (!this.bounds)
            return null;

        return {
            get_extents: () => ({ ...this.bounds }),
            grab_focus: () => {
                this.focused = true;
                return true;
            },
        };
    }

    get_action_iface() {
        if (this.actions.length === 0)
            return null;

        return {
            get_n_actions: () => this.actions.length,
            get_action_name: index => this.actions[index],
            do_action: (index) => {
                this.lastAction = this.actions[index];
                return true;
            },
        };
    }

    get_editable_text_iface() {
        if (!this.states.has(StateType.EDITABLE))
            return null;

        return {
            set_text_contents: (value) => {
                this.value = value;
                return true;
            },
        };
    }

    get_text_iface() {
        if (!this.states.has(StateType.EDITABLE))
            return null;

        return {
            get_character_count: () => this.value.length,
            get_text: (start, end) => this.value.slice(start, end),
        };
    }
}

const postButton = new FakeAccessible({
    name: 'Post',
    role: 'push button',
    bounds: { x: 700, y: 500, width: 80, height: 40 },
    states: [StateType.ENABLED, StateType.FOCUSABLE, StateType.SHOWING, StateType.VISIBLE],
    actions: ['click'],
});
const composer = new FakeAccessible({
    name: "What's happening?",
    role: 'entry',
    bounds: { x: 300, y: 180, width: 450, height: 180 },
    states: [
        StateType.EDITABLE,
        StateType.ENABLED,
        StateType.FOCUSABLE,
        StateType.SHOWING,
        StateType.VISIBLE,
    ],
});
const application = new FakeAccessible({
    name: 'Test Browser',
    role: 'application',
    pid: 42,
    children: [composer, postButton],
});
const desktop = new FakeAccessible({
    name: 'main',
    role: 'desktop frame',
    children: [application],
});
const fakeAtspi = {
    StateType,
    CoordType: { SCREEN: 'screen' },
    init() {},
    get_desktop() {
        return desktop;
    },
};
const accessibility = new AccessibilitySnapshotService({ atspi: fakeAtspi });
const snapshot = accessibility.observe({
    pid: 42,
    appName: 'Test Browser',
    x: 100,
    y: 100,
    width: 800,
    height: 600,
}, 'observation-1');

if (!snapshot.available || snapshot.elements.length !== 2)
    throw new Error('AT-SPI snapshot did not expose interactive elements');

const composerElement = snapshot.elements.find(element => element.role === 'entry');
const postElement = snapshot.elements.find(element => element.name === 'Post');

if (!composerElement?.states.editable
    || composerElement.bounds.x !== 250
    || postElement.bounds.x !== 750) {
    throw new Error('AT-SPI snapshot did not normalize semantic element bounds');
}

const textResult = accessibility.setText(composerElement.ref, 'Hello from Cusco');
if (!textResult.verified || composer.value !== 'Hello from Cusco' || !composer.focused)
    throw new Error('AT-SPI text action was not verified');

const clickResult = accessibility.activate(postElement.ref);
if (!clickResult.verified || postButton.lastAction !== 'click')
    throw new Error('AT-SPI element activation was not verified');

const expectationResult = evaluateComputerUseExpectations({
    accessibility: {
        elements: [
            { ...composerElement, value: 'Hello from Cusco' },
            postElement,
        ],
    },
}, [
    { role: 'entry', name: "What's happening?", state: 'value_contains', value: 'Cusco' },
    { name: 'Post', state: 'enabled' },
]);
if (!expectationResult.met || expectationResult.results.some(result => !result.passed))
    throw new Error('Semantic computer-use expectations were not verified');

accessibility.observe({
    pid: 42,
    appName: 'Test Browser',
    x: 100,
    y: 100,
    width: 800,
    height: 600,
}, 'observation-2');

let staleRejected = false;
try {
    accessibility.activate(postElement.ref);
} catch (error) {
    staleRejected = error.message.includes('stale');
}

if (!staleRejected)
    throw new Error('Stale AT-SPI element reference was not rejected');

const podcastsResult = new FakeAccessible({
    name: 'Podcasts Listen to your favorite shows',
    role: 'list item',
    bounds: { x: 0, y: 0, width: 576, height: 93 },
    states: [StateType.FOCUSABLE, StateType.SHOWING, StateType.VISIBLE],
});
const musicpodResult = new FakeAccessible({
    name: 'musicpod Music, podcast and internet radio player',
    role: 'list item',
    bounds: { x: 0, y: 0, width: 576, height: 93 },
    states: [StateType.FOCUSABLE, StateType.SHOWING, StateType.VISIBLE],
});
const softwareApplication = new FakeAccessible({
    name: 'Software',
    role: 'application',
    pid: 77,
    children: [podcastsResult, musicpodResult],
});
const softwareDesktop = new FakeAccessible({
    name: 'main',
    role: 'desktop frame',
    children: [softwareApplication],
});
const softwareAccessibility = new AccessibilitySnapshotService({
    atspi: {
        ...fakeAtspi,
        get_desktop() {
            return softwareDesktop;
        },
    },
});
const softwareSnapshot = softwareAccessibility.observe({
    pid: 77,
    appName: 'Software',
    x: 0,
    y: 32,
    width: 2560,
    height: 1568,
}, 'software-observation');

if (softwareSnapshot.elements.length !== 2
    || softwareSnapshot.unreliableBoundsCount !== 2
    || !softwareSnapshot.geometryWarning
    || softwareSnapshot.elements.some(element => element.bounds !== null)
    || softwareSnapshot.elements.some(element => (
        !element.geometryIssues.includes('outside_window')
        || !element.geometryIssues.includes('duplicate_bounds')
    ))) {
    throw new Error('Duplicate or out-of-window AT-SPI geometry was exposed as targetable bounds');
}

const podcastsElement = softwareSnapshot.elements.find(element => (
    element.name.startsWith('Podcasts')
));
const focusActivation = softwareAccessibility.activate(podcastsElement.ref);
if (focusActivation.verified
    || !focusActivation.focusVerified
    || focusActivation.activationKey !== 'Return'
    || !podcastsResult.focused) {
    throw new Error('Focusable accessibility row did not request keyboard activation');
}

softwareAccessibility.shutdown();
accessibility.shutdown();
print('Cusco accessibility smoke passed');
