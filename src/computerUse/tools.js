function userError(message) {
    const error = new Error(message);
    error.userMessage = message;
    return error;
}

function parseObject(input, label, { allowEmpty = false } = {}) {
    const source = String(input ?? '').trim();

    if (!source && allowEmpty)
        return {};

    try {
        const value = JSON.parse(source);

        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('expected an object');

        return value;
    } catch (error) {
        throw userError(`${label} expects a JSON object: ${error.message}.`);
    }
}

function formatted(value) {
    return JSON.stringify(value, null, 2);
}

const OBJECT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {},
};

export function createComputerUseTools(service) {
    return [
        {
            name: 'computer_list',
            label: 'List desktop windows',
            description: 'List GNOME workspaces and controllable application windows on this Wayland desktop.',
            inputDescription: 'An empty JSON object: {}.',
            inputSchema: OBJECT_SCHEMA,
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input, options) {
                parseObject(input, 'computer_list', { allowEmpty: true });
                const desktop = await service.listDesktop(options);
                return { desktop, output: formatted(desktop) };
            },
        },
        {
            name: 'computer_observe',
            label: 'Observe desktop window',
            description: 'Focus and capture one GNOME window. The screenshot is attached to the next model turn; returned coordinates are window-relative pixels.',
            inputDescription: 'JSON: {"windowId":"ID from computer_list"}.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['windowId'],
                properties: {
                    windowId: { type: 'string', description: 'Window ID returned by computer_list.' },
                },
            },
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input, options) {
                const args = parseObject(input, 'computer_observe');

                if (!String(args.windowId ?? '').trim())
                    throw userError('computer_observe requires windowId.');

                const observation = await service.observe(args.windowId, options);
                const transcript = {
                    ...observation,
                    imagePath: observation.imagePath,
                    instruction: 'The screenshot is attached. Use window-relative pixel coordinates with computer_act.',
                };
                return {
                    ...observation,
                    output: formatted(transcript),
                };
            },
        },
        {
            name: 'computer_act',
            label: 'Control GNOME desktop',
            description: 'Perform one bounded action on a GNOME Wayland window or switch workspace. Observe again after actions that change the screen.',
            inputDescription: 'JSON with action. Supported: focus {windowId}; click/double_click/move {windowId,x,y,button?}; type {windowId,text,x?,y?}; keypress {windowId,keys:["CTRL","L"]}; scroll {windowId,x,y,deltaX?,deltaY?}; drag {windowId,x,y,endX,endY}; switch_workspace {workspaceIndex}. Coordinates are relative to the latest window screenshot.',
            inputSchema: {
                type: 'object',
                additionalProperties: true,
                required: ['action'],
                properties: {
                    action: {
                        type: 'string',
                        enum: ['focus', 'click', 'double_click', 'move', 'type', 'keypress', 'scroll', 'drag', 'switch_workspace'],
                    },
                    windowId: { type: 'string' },
                    workspaceIndex: { type: 'integer', minimum: 0 },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    endX: { type: 'number' },
                    endY: { type: 'number' },
                    deltaX: { type: 'number' },
                    deltaY: { type: 'number' },
                    button: { type: 'string', enum: ['left', 'middle', 'right'] },
                    text: { type: 'string' },
                    keys: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
            },
            permissionPolicy: 'ask',
            concurrencySafe: false,
            async run(input, options) {
                const args = parseObject(input, 'computer_act');

                if (!String(args.action ?? '').trim())
                    throw userError('computer_act requires action.');

                const result = await service.act(args, options);
                return { result, output: formatted(result) };
            },
        },
    ];
}
