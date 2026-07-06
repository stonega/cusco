import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    appendToolOutputPreview,
    createToolCallFromResult,
    createToolCallFromRequest,
    latestOutputLines,
    normalizeToolCallDisplay,
} from '../src/tools/display.js';
import {
    calculateExpression,
    extractSearchResults,
    formatToolResultForTranscript,
    parseToolRequest,
    summarizeStructuredData,
    ToolManager,
} from '../src/tools/tools.js';

if (calculateExpression('2 + 3 * (4 - 1)') !== 11)
    throw new Error('Calculator expression did not evaluate correctly');

if (!summarizeStructuredData('[{"name":"A","count":1}]').includes('fields: name, count'))
    throw new Error('JSON structured data summary was not produced');

const searchResults = extractSearchResults({
    AbstractText: 'Cusco summary',
    AbstractURL: 'https://example.com/cusco',
    Heading: 'Cusco',
    RelatedTopics: [
        { Text: 'Extra - result', FirstURL: 'https://example.com/extra' },
    ],
});

if (searchResults.length !== 2 || searchResults[0].url !== 'https://example.com/cusco')
    throw new Error('Search results with citations were not extracted');

const request = parseToolRequest('/search native GNOME chat app');

if (!request?.requiresPermission || request.name !== 'search')
    throw new Error('Search tool request was not parsed with permission requirement');

const manager = new ToolManager();
const listedTools = manager.listTools();

if (!listedTools.find((tool) => tool.name === 'calc')?.description)
    throw new Error('Tool metadata did not include descriptions');

if (manager.createRequest('search', 'native GNOME chat app').permissionPolicy !== 'ask')
    throw new Error('Tool request did not preserve permission policy');

for (const toolName of ['file_list', 'file_read', 'bash']) {
    if (manager.createRequest(toolName, '/tmp').permissionPolicy !== 'ask')
        throw new Error(`${toolName} did not require approval`);
}

const calcResult = await manager.runRequest(parseToolRequest('/calc 10 / 2 + 7'));

if (calcResult.output !== '12')
    throw new Error(`Tool manager calculator result was wrong: ${calcResult.output}`);

if (!formatToolResultForTranscript(calcResult).includes('Calculator result'))
    throw new Error('Tool result transcript formatting failed');

const bashDisplay = normalizeToolCallDisplay(createToolCallFromRequest(
    manager.createRequest('bash', 'printf hello'),
));

if (bashDisplay.action !== 'Running command')
    throw new Error('Bash tool display metadata was not normalized');

manager.registerTool({
    name: 'image_gen',
    label: 'Image Generation',
    description: 'Generate a test image.',
    inputDescription: 'Image prompt.',
    requiresPermission: true,
    run: async (input) => ({
        prompt: input,
        providerName: 'Test Provider',
        modelId: 'test-image-model',
        imagePath: '/tmp/test-image.png',
        mimeType: 'image/png',
        detail: 'Test Provider · test-image-model',
        output: 'Generated image saved to /tmp/test-image.png',
    }),
});

const imageResult = await manager.runRequest(manager.createRequest('image_gen', 'A mountain at sunrise'));

if (imageResult.imagePath !== '/tmp/test-image.png' || imageResult.prompt !== 'A mountain at sunrise')
    throw new Error('Registered image generation tool result metadata was not preserved');

if (!formatToolResultForTranscript(imageResult).includes('Generated image'))
    throw new Error('Image generation transcript formatting failed');

const imageDisplay = normalizeToolCallDisplay(createToolCallFromResult(imageResult));

if (imageDisplay.action !== 'Generated image' || !imageDisplay.detail.includes('test-image-model'))
    throw new Error('Image generation display metadata was not normalized');

const latestPreview = latestOutputLines('one\ntwo\nthree\nfour');

if (latestPreview !== 'two\nthree\nfour')
    throw new Error(`Bash preview was not limited to three lines: ${latestPreview}`);

const tempRoot = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `cusco-tools-${GLib.uuid_string_random()}`,
]);
const tempFile = GLib.build_filenamev([tempRoot, 'note.txt']);

GLib.mkdir_with_parents(tempRoot, 0o700);
GLib.file_set_contents(tempFile, 'Cusco file read smoke');

const listResult = await manager.runRequest(manager.createRequest('file_list', tempRoot));

if (!listResult.output.includes('note.txt') || !formatToolResultForTranscript(listResult).includes(tempRoot))
    throw new Error('File list tool did not return the temporary file');

const readResult = await manager.runRequest(manager.createRequest('file_read', tempFile));

if (!readResult.content.includes('Cusco file read smoke') || !formatToolResultForTranscript(readResult).includes('```text'))
    throw new Error('File read tool did not return the temporary file contents');

const bashResult = await manager.runRequest(manager.createRequest('bash', 'printf cusco-bash-smoke'));

if (bashResult.exitStatus !== 0 || !bashResult.stdout.includes('cusco-bash-smoke'))
    throw new Error(`Bash tool failed: ${bashResult.output}`);

let streamedOutput = '';
const streamedBashResult = await manager.runRequest(
    manager.createRequest('bash', "printf 'one\\n'; sleep 0.1; printf 'two\\nthree\\nfour\\n'"),
    {
        onOutput: (chunk) => {
            streamedOutput = appendToolOutputPreview(streamedOutput, chunk.text);
        },
    },
);

if (streamedBashResult.exitStatus !== 0 || !streamedOutput.includes('four'))
    throw new Error(`Bash output was not streamed to the preview callback: ${streamedOutput}`);

if (latestOutputLines(streamedOutput).split('\n').length > 3)
    throw new Error('Streamed bash preview exceeded three visible lines');

const bashCancellable = new Gio.Cancellable();
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
    bashCancellable.cancel();
    return GLib.SOURCE_REMOVE;
});

const cancelledBashResult = await manager.runRequest(
    manager.createRequest('bash', 'printf before-cancel; sleep 2; printf after-cancel'),
    { cancellable: bashCancellable, timeoutSeconds: 5 },
);

if (!cancelledBashResult.cancelled || cancelledBashResult.exitStatus !== 130)
    throw new Error(`Bash cancellation was not reported: ${cancelledBashResult.output}`);

if (!formatToolResultForTranscript(cancelledBashResult).includes('(cancelled)'))
    throw new Error('Cancelled bash result was not formatted as cancelled');

print('Cusco tools smoke passed');
