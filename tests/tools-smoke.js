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
const calcResult = await manager.runRequest(parseToolRequest('/calc 10 / 2 + 7'));

if (calcResult.output !== '12')
    throw new Error(`Tool manager calculator result was wrong: ${calcResult.output}`);

if (!formatToolResultForTranscript(calcResult).includes('Calculator result'))
    throw new Error('Tool result transcript formatting failed');

print('Cusco tools smoke passed');
