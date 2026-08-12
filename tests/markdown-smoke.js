import {
    inlineMarkdownToPangoMarkup,
    markdownToPangoRenderModel,
    markdownToPangoMarkup,
    parseMarkdownBlocks,
    stabilizeStreamingMarkdown,
} from '../src/chat/markdown.js';

const blocks = parseMarkdownBlocks([
    '# Title',
    '',
    'Use **bold** and `code`.',
    '',
    '```js',
    'const value = 1;',
    '```',
].join('\n'));

if (blocks.length !== 2)
    throw new Error(`Unexpected markdown block count: ${blocks.length}`);

if (blocks[1].type !== 'code' || blocks[1].language !== 'js')
    throw new Error('Fenced code block was not parsed');

const tableBlocks = parseMarkdownBlocks([
    'System details:',
    '',
    '| Spec | Details |',
    '|---|---|',
    '| OS | Fedora Linux 44 (Workstation Edition) |',
    '| Kernel | 7.0.13-200.fc44.x86_64 |',
    '',
    'Done.',
].join('\n'));
const tableBlock = tableBlocks.find((block) => block.type === 'table');

if (!tableBlock)
    throw new Error('Markdown table was not parsed as a table block');

if (tableBlock.headers[0] !== 'Spec' || tableBlock.headers[1] !== 'Details')
    throw new Error(`Unexpected table headers: ${tableBlock.headers.join(', ')}`);

if (tableBlock.rows.length !== 2 || tableBlock.rows[0][0] !== 'OS')
    throw new Error('Markdown table rows were not parsed');

const dividerBlocks = parseMarkdownBlocks([
    'Before',
    '',
    '---',
    '',
    'After',
].join('\n'));

if (dividerBlocks.length !== 3
    || dividerBlocks[0].type !== 'markdown'
    || dividerBlocks[1].type !== 'divider'
    || dividerBlocks[2].type !== 'markdown') {
    throw new Error(`Markdown divider was not parsed as its own block: ${JSON.stringify(dividerBlocks)}`);
}

if (!markdownToPangoMarkup('# Title').includes('weight="bold"'))
    throw new Error('Heading markdown was not converted to Pango markup');

if (!markdownToPangoMarkup('# Title').includes('line_height="1.05"'))
    throw new Error('H1 markdown did not receive compact line height');

if (!markdownToPangoMarkup('## Title').includes('line_height="1.08"'))
    throw new Error('H2 markdown did not receive compact line height');

if (!markdownToPangoMarkup('### Title').includes('line_height="1.12"'))
    throw new Error('H3 markdown did not receive compact line height');

if (markdownToPangoMarkup('#### Title').includes('line_height='))
    throw new Error('H4 markdown heading unexpectedly received compact line height');

const taskListMarkup = markdownToPangoMarkup([
    '- [ ] Pending task',
    '- [x] Completed task',
    '* [X] Completed uppercase task',
].join('\n'));

if (!taskListMarkup.includes('☐ Pending task')
    || !taskListMarkup.includes('☑ Completed task')
    || !taskListMarkup.includes('☑ Completed uppercase task')) {
    throw new Error(`Markdown task list markers were not rendered: ${taskListMarkup}`);
}

const closedHeadingMarkup = markdownToPangoMarkup('# 👋 #');

if (!closedHeadingMarkup.includes('👋') || closedHeadingMarkup.includes('#'))
    throw new Error(`Closed heading marker was not stripped: ${closedHeadingMarkup}`);

if (!inlineMarkdownToPangoMarkup('Use **bold** and `code`.').includes('<b>bold</b>'))
    throw new Error('Inline bold markdown was not converted');

if (!inlineMarkdownToPangoMarkup('<unsafe>').includes('&lt;unsafe&gt;'))
    throw new Error('Markup was not escaped');

const localFileLinkMarkup = inlineMarkdownToPangoMarkup(
    '[Generated image](/home/stone/Generated image.jpg)',
);

if (!localFileLinkMarkup.includes('href="file:///home/stone/Generated%20image.jpg"'))
    throw new Error(`Absolute file link was not converted to a file URI: ${localFileLinkMarkup}`);

const webLinkMarkup = inlineMarkdownToPangoMarkup('[Cusco](https://example.com/cusco)');

if (!webLinkMarkup.includes('href="https://example.com/cusco"'))
    throw new Error(`Web link URI changed unexpectedly: ${webLinkMarkup}`);

const emojiMarkup = inlineMarkdownToPangoMarkup('Hihi! \u{1F44B} How are you?');

if (!emojiMarkup.includes('\u{1F44B}') || emojiMarkup.includes('\uFFFD'))
    throw new Error(`Emoji was not preserved in markdown markup: ${emojiMarkup}`);

const renderModelSource = '# Hello **bold** and `inline code` with [a link](https://example.com).';
const renderModel = markdownToPangoRenderModel(renderModelSource);

if (renderModel.markup !== markdownToPangoMarkup(renderModelSource))
    throw new Error('Markdown render model markup diverged from the existing renderer');

if (renderModel.plainText !== 'Hello bold and inline code with a link.')
    throw new Error(`Markdown render model plain text is incorrect: ${renderModel.plainText}`);

const inlineCodeStart = new TextEncoder().encode('Hello bold and ').length;
const inlineCodeEnd = inlineCodeStart + new TextEncoder().encode('inline code').length;

if (!renderModel.excludedAnimationRanges.some((range) => (
    range.start === inlineCodeStart && range.end === inlineCodeEnd
))) {
    throw new Error(`Inline code was not excluded from animation: ${JSON.stringify(renderModel)}`);
}

for (const source of [
    'Plain <unsafe> text',
    '## Heading ##',
    '- Bullet with *emphasis*',
    '3. Ordered **item**',
    '- [x] Finished task',
    '> Quoted `code`',
    '[Local file](/tmp/My File.txt)',
    'Emoji 🙂 and 中文',
]) {
    const candidate = markdownToPangoRenderModel(source);

    if (candidate.markup !== markdownToPangoMarkup(source))
        throw new Error(`Render model changed existing Markdown output for: ${source}`);
}

if (stabilizeStreamingMarkdown('Writing **bold') !== 'Writing **bold**')
    throw new Error('Streaming markdown did not stabilize an unfinished bold span');

if (stabilizeStreamingMarkdown('*') !== '')
    throw new Error('Streaming markdown exposed an unfinished emphasis delimiter');

if (stabilizeStreamingMarkdown('**bold*') !== '**bold**')
    throw new Error('Streaming markdown exposed half of a closing bold delimiter');

if (stabilizeStreamingMarkdown('Opening **') !== 'Opening ')
    throw new Error('Streaming markdown turned an opening bold delimiter into visible content');

if (stabilizeStreamingMarkdown('[link](') !== '')
    throw new Error('Streaming markdown exposed an incomplete link before its target arrived');

if (stabilizeStreamingMarkdown('`') !== '')
    throw new Error('Streaming markdown exposed an unfinished inline-code delimiter');

for (const prefix of ['# ', '- ', '> ', '1', '1. ', '- [ ] ']) {
    if (stabilizeStreamingMarkdown(prefix) !== '')
        throw new Error(`Streaming markdown exposed an incomplete block prefix: ${prefix}`);
}

if (stabilizeStreamingMarkdown('Writing `code') !== 'Writing `code`')
    throw new Error('Streaming markdown did not stabilize an unfinished code span');

if (stabilizeStreamingMarkdown('[Cusco](https://example.com') !== '[Cusco](https://example.com)')
    throw new Error('Streaming markdown did not stabilize an unfinished link');

if (stabilizeStreamingMarkdown('- list item') !== '- list item')
    throw new Error('Streaming markdown changed a list marker');

const unfinishedFence = '```js\nconst answer = 42;';

if (stabilizeStreamingMarkdown(unfinishedFence) !== unfinishedFence)
    throw new Error('Streaming markdown changed an unfinished fenced code block');

print('Cusco markdown smoke passed');
