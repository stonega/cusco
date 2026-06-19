import {
    inlineMarkdownToPangoMarkup,
    markdownToPangoMarkup,
    parseMarkdownBlocks,
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

if (!markdownToPangoMarkup('# Title').includes('weight="bold"'))
    throw new Error('Heading markdown was not converted to Pango markup');

if (!inlineMarkdownToPangoMarkup('Use **bold** and `code`.').includes('<b>bold</b>'))
    throw new Error('Inline bold markdown was not converted');

if (!inlineMarkdownToPangoMarkup('<unsafe>').includes('&lt;unsafe&gt;'))
    throw new Error('Markup was not escaped');

const emojiMarkup = inlineMarkdownToPangoMarkup('Hihi! \u{1F44B} How are you?');

if (!emojiMarkup.includes('\u{1F44B}') || emojiMarkup.includes('\uFFFD'))
    throw new Error(`Emoji was not preserved in markdown markup: ${emojiMarkup}`);

print('Cusco markdown smoke passed');
