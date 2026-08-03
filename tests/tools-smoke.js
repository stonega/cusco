import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import {
    appendToolOutputPreview,
    attachToolMessagesToAssistant,
    createToolCallFromResult,
    createToolCallFromRequest,
    latestOutputLines,
    normalizeToolCallDisplay,
    toolCallBelongsToFollowingAssistant,
} from '../src/tools/display.js';
import {
    calculateExpression,
    commandUsesSudo,
    extractDuckDuckGoSearchResults,
    extractExaSearchResults,
    formatToolResultForTranscript,
    normalizeBashTimeoutSeconds,
    parseToolRequest,
    runBashCommand,
    searchWeb,
    summarizeStructuredData,
    ToolManager,
} from '../src/tools/tools.js';

if (calculateExpression('2 + 3 * (4 - 1)') !== 11)
    throw new Error('Calculator expression did not evaluate correctly');

if (!summarizeStructuredData('[{"name":"A","count":1}]').includes('fields: name, count'))
    throw new Error('JSON structured data summary was not produced');

const searchResults = extractExaSearchResults({
    results: [
        {
            title: 'Cusco',
            url: 'https://example.com/cusco',
            highlights: ['Cusco summary'],
            publishedDate: '2026-07-27T00:00:00.000Z',
        },
        {
            title: 'Extra',
            url: 'https://example.com/extra',
            summary: 'Extra result',
        },
    ],
});

if (searchResults.length !== 2
    || searchResults[0].url !== 'https://example.com/cusco'
    || searchResults[0].snippet !== 'Cusco summary'
    || searchResults[0].publishedAt !== '2026-07-27T00:00:00.000Z') {
    throw new Error('Exa search results with citations were not extracted');
}

const duckDuckGoFixture = `
<div class="result results_links results_links_deep web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcusco&amp;rut=test">Cusco &amp; GNOME</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fcusco">Native <b>GNOME</b> chat</a>
</div>
<div class="result results_links result--ad web-result">
  <a class="result__a" href="https://example.com/sponsor">Sponsor</a>
  <a class="result__snippet" href="https://example.com/sponsor">Sponsored result</a>
</div>`;
const duckDuckGoResults = extractDuckDuckGoSearchResults(duckDuckGoFixture);

if (duckDuckGoResults.length !== 2
    || duckDuckGoResults[0].title !== 'Cusco & GNOME'
    || duckDuckGoResults[0].url !== 'https://example.com/cusco'
    || duckDuckGoResults[0].snippet !== 'Native GNOME chat'
    || !duckDuckGoResults[1].sponsored
    || !duckDuckGoResults[1].title.startsWith('Sponsored:')) {
    throw new Error('DuckDuckGo HTML search results were not normalized');
}

let duckDuckGoSearchUrl = '';
let duckDuckGoSearchOptions = null;
const duckDuckGoSearchResult = await searchWeb('native GNOME chat app', {
    id: 'duckduckgo',
    fetcher: async (url, options) => {
        duckDuckGoSearchUrl = url;
        duckDuckGoSearchOptions = options;
        return duckDuckGoFixture;
    },
});

if (duckDuckGoSearchResult.providerId !== 'duckduckgo'
    || !duckDuckGoSearchUrl.startsWith('https://html.duckduckgo.com/html/?')
    || !duckDuckGoSearchUrl.includes('q=native%20GNOME%20chat%20app')
    || !duckDuckGoSearchUrl.includes('kp=-1')
    || !duckDuckGoSearchUrl.includes('k1=1')
    || duckDuckGoSearchOptions.headers.Accept !== 'text/html,application/xhtml+xml') {
    throw new Error('Built-in DuckDuckGo search request was not configured correctly');
}

if (!formatToolResultForTranscript({
    ...duckDuckGoSearchResult,
    name: 'search',
    input: 'native GNOME chat app',
}).includes('via DuckDuckGo')) {
    throw new Error('DuckDuckGo attribution was not included in the search transcript');
}

let exaSearchUrl = '';
let exaSearchOptions = null;
const exaSearchResult = await searchWeb('native GNOME chat app', {
    id: 'exa-search',
    apiKey: 'exa-test-key',
    fetcher: async (url, options) => {
        exaSearchUrl = url;
        exaSearchOptions = options;
        return {
            results: [{
                title: 'Cusco',
                url: 'https://example.com/cusco',
                highlights: ['Cusco summary'],
            }],
        };
    },
});

if (exaSearchResult.providerId !== 'exa-search'
    || exaSearchUrl !== 'https://api.exa.ai/search'
    || exaSearchOptions.method !== 'POST'
    || exaSearchOptions.headers['x-api-key'] !== 'exa-test-key'
    || exaSearchOptions.body.query !== 'native GNOME chat app'
    || exaSearchOptions.body.type !== 'auto'
    || exaSearchOptions.body.numResults !== 5
    || exaSearchOptions.body.contents.highlights.maxCharacters !== 500) {
    throw new Error('Exa Search fallback request was not configured correctly');
}

const configuredSearchManager = new ToolManager({
    searchConfig: () => ({
        id: 'duckduckgo',
        fetcher: async () => duckDuckGoFixture,
    }),
});
const configuredSearchResult = await configuredSearchManager.runRequest(
    configuredSearchManager.createRequest('search', 'configured local search'),
    { providerId: 'kimi' },
);

if (configuredSearchResult.providerId !== 'duckduckgo')
    throw new Error('The active chat provider overrode the configured search fallback');

const request = parseToolRequest('/search native GNOME chat app');

if (!request?.requiresPermission || request.name !== 'search')
    throw new Error('Search tool request was not parsed with permission requirement');

if (!commandUsesSudo('sudo systemctl status')
    || !commandUsesSudo('/usr/bin/sudo systemctl status')
    || commandUsesSudo('printf sudoers')) {
    throw new Error('Bash sudo command detection failed');
}

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

if (!toolCallBelongsToFollowingAssistant({ name: 'search' })
    || toolCallBelongsToFollowingAssistant({ name: 'search', agentMode: true })
    || toolCallBelongsToFollowingAssistant({})) {
    throw new Error('Explicit tool calls were not assigned to the following assistant response');
}

let removedStandaloneTool = false;
const attachedToolMessages = [];
const pendingToolEntries = [{
    message: {
        role: 'system',
        toolCall: { name: 'search' },
    },
    view: {
        remove: () => {
            removedStandaloneTool = true;
        },
    },
}];
const attachedToolCount = attachToolMessagesToAssistant(pendingToolEntries, {
    append_tool_result: (message) => {
        attachedToolMessages.push(message);
        return {};
    },
});

if (attachedToolCount !== 1
    || pendingToolEntries.length !== 0
    || attachedToolMessages.length !== 1
    || !removedStandaloneTool) {
    throw new Error('Explicit tool result was not moved into the following assistant response');
}

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

let sudoPasswordRequested = false;
const noSudoPromptResult = await runBashCommand('printf no-sudo-prompt', {
    requestSudoPassword: async () => {
        sudoPasswordRequested = true;
        return 'unused';
    },
});

if (sudoPasswordRequested || !noSudoPromptResult.stdout.includes('no-sudo-prompt'))
    throw new Error('Bash requested a sudo password for a non-sudo command');

const emptyBashResult = await manager.runRequest(manager.createRequest('bash', 'true'));
const emptyBashTranscript = formatToolResultForTranscript(emptyBashResult);

if (emptyBashResult.output.includes('stdout: <empty>')
    || emptyBashResult.output.includes('stderr: <empty>')
    || emptyBashTranscript.includes('stdout: <empty>')
    || emptyBashTranscript.includes('stderr: <empty>')) {
    throw new Error('Empty bash output streams should be hidden');
}

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

if (normalizeBashTimeoutSeconds() !== 300
    || normalizeBashTimeoutSeconds(60) !== 60
    || normalizeBashTimeoutSeconds(1000) !== 300) {
    throw new Error('Bash timeout normalization did not preserve the bounded heavy-task window');
}

let outputCallbackCount = 0;
let uiHeartbeatCount = 0;
const uiHeartbeatSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 10, () => {
    uiHeartbeatCount++;
    return GLib.SOURCE_CONTINUE;
});
const heavyOutputResult = await runBashCommand(
    "yes '0123456789abcdef0123456789abcdef' | head -c 16777216",
    {
        onOutput: () => {
            outputCallbackCount++;
        },
    },
);
GLib.source_remove(uiHeartbeatSourceId);

if (heavyOutputResult.exitStatus !== 0)
    throw new Error(`Heavy-output bash command failed: ${heavyOutputResult.output}`);

if (outputCallbackCount > 8)
    throw new Error(`Heavy bash output was not coalesced: ${outputCallbackCount} UI callbacks`);

if (uiHeartbeatCount < 2)
    throw new Error(`Heavy bash output starved the UI main context: ${uiHeartbeatCount} heartbeats`);

const timeoutStartedAt = GLib.get_monotonic_time();
const processTreeResult = await runBashCommand(
    "sleep 5 & child=$!; printf '%s\\n' \"$child\"; wait",
    { timeoutSeconds: 1 },
);
const timeoutElapsedMs = (GLib.get_monotonic_time() - timeoutStartedAt) / 1000;
const childPid = processTreeResult.stdout.trim().split('\n')[0];

await new Promise((resolve) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

if (!processTreeResult.timedOut || processTreeResult.exitStatus !== 124)
    throw new Error(`Timed-out bash process tree was not reported correctly: ${processTreeResult.output}`);

if (timeoutElapsedMs > 2500)
    throw new Error(`Timed-out bash process held its pipes for ${timeoutElapsedMs.toFixed(0)}ms`);

if (/^\d+$/.test(childPid) && GLib.file_test(`/proc/${childPid}`, GLib.FileTest.EXISTS))
    throw new Error(`Timed-out bash descendant ${childPid} was left running`);

print('Cusco tools smoke passed');
