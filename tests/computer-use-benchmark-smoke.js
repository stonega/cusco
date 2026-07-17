import { createComputerUseTools } from '../src/computerUse/tools.js';

class ComposerBenchmarkService {
    constructor() {
        this.calls = 0;
        this.observation = 0;
        this.text = '';
        this.posted = false;
    }

    async listDesktop() {
        this.calls += 1;
        return {
            workspaces: [{ index: 0, active: true, windowCount: 1 }],
            windows: [{ id: 'browser', title: 'Computer-use benchmark', focused: true }],
        };
    }

    _observation() {
        this.observation += 1;
        const observationId = `benchmark-${this.observation}`;
        return {
            window: { id: 'browser', title: 'Computer-use benchmark', focused: true },
            width: 1000,
            height: 700,
            observationId,
            mimeType: 'image/png',
            imagePath: `/tmp/${observationId}.png`,
            accessibility: {
                available: true,
                source: 'benchmark',
                elements: this.posted
                    ? [{
                        ref: `a11y:${observationId}:status`,
                        role: 'status',
                        name: 'Post sent',
                        states: { visible: true },
                        bounds: { x: 300, y: 100, width: 400, height: 80 },
                    }]
                    : [
                        {
                            ref: `a11y:${observationId}:composer`,
                            role: 'entry',
                            name: "What's happening?",
                            value: this.text,
                            states: { editable: true, enabled: true },
                            bounds: { x: 300, y: 200, width: 400, height: 180 },
                        },
                        {
                            ref: `a11y:${observationId}:post`,
                            role: 'push button',
                            name: 'Post',
                            states: { enabled: Boolean(this.text) },
                            bounds: { x: 600, y: 420, width: 100, height: 60 },
                        },
                    ],
            },
        };
    }

    async observe() {
        this.calls += 1;
        return this._observation();
    }

    async step(actions, options) {
        this.calls += 1;
        const results = [];

        for (const action of actions) {
            if (action.action === 'set_text_element') {
                this.text = action.text;
                results.push({ performed: action.action, verified: true, valueMatches: true });
            } else if (action.action === 'click_element') {
                if (!this.text)
                    throw new Error('Post is disabled.');
                this.posted = true;
                results.push({ performed: action.action, verified: true });
            }
        }

        const observation = this._observation();
        const expectationResults = (options.expectations ?? []).map(expectation => ({
            ...expectation,
            passed: this.posted
                ? expectation.name === 'Post sent'
                : expectation.name === 'Post' && Boolean(this.text),
        }));
        return {
            performed: results.map(result => result.performed),
            results,
            observation,
            verification: {
                screenChanged: true,
                focused: true,
                unchangedCount: 0,
                stalled: false,
                semanticActionsVerified: true,
                inputVerified: results.some(result => result.performed === 'set_text_element')
                    ? true
                    : null,
                expectationsMet: expectationResults.every(result => result.passed),
                expectations: expectationResults,
            },
            timing: { totalMs: 1, actionMs: 1, settleMs: 0, observationMs: 0 },
        };
    }
}

const service = new ComposerBenchmarkService();
const tools = new Map(createComputerUseTools(service).map(tool => [tool.name, tool]));
await tools.get('computer_list').run('{}');
const initial = await tools.get('computer_observe').run('{"windowId":"browser"}');
const composer = initial.accessibility.elements.find(element => element.role === 'entry');
const content = 'The tweet is sent with computer use by Cusco on Fedora.';
const edited = await tools.get('computer_step').run(JSON.stringify({
    windowId: 'browser',
    observationId: initial.observationId,
    actions: [{ action: 'set_text_element', ref: composer.ref, text: content }],
    expect: [{ name: 'Post', state: 'enabled' }],
    settleMs: 0,
}));

if (!edited.verification.inputVerified || !edited.verification.expectationsMet)
    throw new Error('Benchmark did not verify semantic text entry');

const post = edited.accessibility.elements.find(element => element.name === 'Post');
const submitted = await tools.get('computer_step').run(JSON.stringify({
    windowId: 'browser',
    observationId: edited.observationId,
    actions: [{ action: 'click_element', ref: post.ref }],
    expect: [{ name: 'Post sent', state: 'present' }],
    settleMs: 0,
}));

if (!service.posted
    || !submitted.verification.semanticActionsVerified
    || !submitted.verification.expectationsMet) {
    throw new Error('Benchmark did not verify the final semantic submission');
}

if (service.calls > 4)
    throw new Error(`Computer-use benchmark exceeded four service calls: ${service.calls}`);

print(JSON.stringify({
    benchmark: 'semantic-composer',
    serviceCalls: service.calls,
    posted: service.posted,
    verified: submitted.verification.expectationsMet,
}));
