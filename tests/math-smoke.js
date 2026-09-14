import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';

import { renderMath } from '../packages/nativeMath/render.js';
import { artifactForCodeBlock } from '../src/chat/artifacts.js';
import { MathLabel } from '../src/chat/math.js';
import {
    inlineMarkdownToPangoRenderModel,
    markdownToPangoRenderModel,
    parseMarkdownBlocks,
    stabilizeStreamingMarkdown,
} from '../src/chat/markdown.js';
import { createMessageContent, applyReferenceTextStyles } from '../src/chat/messageView.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function delay(milliseconds = 30) {
    return new Promise((resolve) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const example = '这个字走到第 $l$ 层，要过两道关：';
const exampleModel = markdownToPangoRenderModel(example);
assert(exampleModel.mathRanges.length === 1, 'The reported Chinese example has no math range');
const range = exampleModel.mathRanges[0];
assert(decoder.decode(encoder.encode(exampleModel.plainText).slice(range.start, range.end)) === '$l$',
    'Math ranges must use UTF-8 byte offsets and retain the original TeX');

for (const source of [
    String.raw`$x_i^2$`, String.raw`\(\alpha + \beta\)`,
    String.raw`$$\frac{1}{2}$$`, String.raw`\[\sqrt{x}\]`,
    '**$l$**', '*$x$*', '*$a*b$*', '- 中文 $x$', '[计算 $x$](https://example.com)',
]) {
    const model = markdownToPangoRenderModel(source);
    assert(model.mathRanges.length === 1, `Math was lost inside Markdown: ${source}`);
    assert(model.excludedAnimationRanges.length === 1, `Math should not animate word by word: ${source}`);
}

for (const source of [
    '$5 and $10', '$5 and $10；代码：`$l$`', '`$l$`', '`**$x$**`',
    String.raw`\$l\$`, '$ l $', '$l', String.raw`\(x`, '[$l$](https://example.com/$x$)',
]) {
    const model = inlineMarkdownToPangoRenderModel(source);
    assert(model.mathRanges.length === (source.startsWith('[') ? 1 : 0),
        `Literal text or link target was interpreted as math: ${source}`);
}
assert(inlineMarkdownToPangoRenderModel('`**$x$**`').plainText === '**$x$**',
    'Code spans must preserve their contents');

const display = '$$\n\\begin{aligned}\na&=b+c\\\\\nd&=e\n\\end{aligned}\n$$';
const blocks = parseMarkdownBlocks(`Before\n${display} after\n\n` + '```tex\n$x$\n$$\n```');
assert(blocks.map((block) => block.type).join(',') === 'markdown,math,markdown,code',
    'Display math must be a separate block without consuming adjacent prose or code');
assert(blocks[1].content === display && blocks[2].content === ' after',
    'Display source or trailing text was changed');
assert(artifactForCodeBlock([{ id: 'saved', kind: 'svg', path: '/tmp/saved.svg', sourceBlockIndex: 1 }],
    3, blocks[3])?.id === 'saved', 'Display math shifted the saved artifact association');
assert(parseMarkdownBlocks('```tex\n$$x$$\n```')[0].type === 'code', 'A code fence was treated as math');
const table = parseMarkdownBlocks('| Value | Result |\n|---|---|\n| $|x|$ | $x^2$ |')[0];
assert(table.rows[0][0] === '$|x|$' && table.rows[0][1] === '$x^2$',
    'Absolute-value bars inside table math must not split cells');
assert(parseMarkdownBlocks('  \\[x^2\\]')[0].type === 'math', 'Bracket display math was not recognized');

for (const source of [display, String.raw`\[a*b`, String.raw`\(x_1`, '$a*b$'])
    assert(stabilizeStreamingMarkdown(source) === source, `Streaming changed TeX: ${source}`);
assert(stabilizeStreamingMarkdown(`${display}\n**after`) === `${display}\n**after**`,
    'Markdown stabilization did not resume after multiline math');

for (const tex of [
    'l', 'x_i^2', String.raw`\frac{a+b}{c}`, String.raw`\sqrt[3]{x}`, String.raw`\sum_{i=1}^n i`,
    String.raw`\int_0^1 x^2\,dx`, String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`,
]) {
    const result = renderMath(tex, true);
    assert(result?.svg.includes('<path'), `No SVG glyphs for ${tex}`);
    assert(!/https?:\/\//.test(result.svg.replace('http://www.w3.org/2000/svg', '')),
        `Formula needs an external resource: ${tex}`);
}
for (const tex of [String.raw`\frac{a}`, String.raw`\notACommand{x}`,
    String.raw`\require{html}`, String.raw`\href{https://example.com}{x}`, 'x'.repeat(8193)]) {
    assert(renderMath(tex) === null, `Unsupported or invalid TeX should fall back to source: ${tex.slice(0,50)}`);
}
assert(renderMath(String.raw`\newcommand{\cuscomath}{x}\cuscomath`), 'Local macros should work');
assert(renderMath(String.raw`\cuscomath`) === null, 'Macros leaked between messages');

const preview = [
    example,
    '',
    String.raw`行内分数 $\frac{a+b}{c}$、下标 $x_i^2$ 和根号 $\sqrt{x}$。`,
    '',
    String.raw`$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$`,
    '',
    String.raw`\[\begin{pmatrix}a&b\\c&d\end{pmatrix}\]`,
    '',
    '| 变量 | 公式 |', '|---|---|', String.raw`| 第 $l$ 层 | $\alpha + \beta$ |`,
    '',
    '美元 $5 and $10；代码：`$l$`。',
].join('\n');

// Exercise token-by-token input with nested TeX and changing block shapes.
for (let index = 1; index <= preview.length; index++) {
    const source = stabilizeStreamingMarkdown(preview.slice(0, index));
    for (const block of parseMarkdownBlocks(source)) {
        if (block.type !== 'markdown' && block.type !== 'math')
            continue;
        const model = block.type === 'math'
            ? inlineMarkdownToPangoRenderModel(block.content)
            : markdownToPangoRenderModel(block.content);
        assert(Pango.parse_markup(model.markup, -1, '\0')[0], 'Streaming produced invalid Pango markup');
        for (const math of model.mathRanges)
            renderMath(math.tex, math.display);
    }
}

if (Gtk.init_check()) {
    const content = createMessageContent(preview, { role: 'assistant' });
    for (const side of ['top', 'bottom', 'start', 'end'])
        content[`set_margin_${side}`](24);
    const scroller = new Gtk.ScrolledWindow({ child: content });
    const window = new Gtk.Window({ child: scroller, default_width: 660, default_height: 540 });
    window.present();
    await delay(100);

    const label = content.get_first_child();
    assert(label instanceof MathLabel, 'Chat did not use the native math label');
    assert(label.get_text().includes('$l$'), 'Copyable TeX was replaced with an object placeholder');
    label.select_region(0, -1);
    assert(label.get_selection_bounds()[0], 'Math text cannot be selected');
    label.select_region(0, 0);
    applyReferenceTextStyles(label, [{ kind: 'skill', insertText: '$l$' }], {
        skill: { foreground: '#18794e' },
    });
    const attributes = label.get_attributes().to_string();
    assert(attributes.includes('shape'), 'Reference highlighting removed formula layout');

    const streaming = createMessageContent('第 $l', { streaming: true, streamAnimationStyle: 'none' });
    const streamingLabel = streaming.get_first_child();
    streaming.updateContent('第 $l$ 层');
    assert(streaming.get_first_child() === streamingLabel, 'Inline math needlessly replaced the streaming label');
    assert(streamingLabel.get_attributes().to_string().includes('shape'), 'Completed streaming math was not rendered');
    await streaming.finishStreaming({ flush: true });

    const settings = Gtk.Settings.get_default();
    const previousDark = settings.gtk_application_prefer_dark_theme;
    for (const dark of [false, true]) {
        settings.gtk_application_prefer_dark_theme = dark;
        await delay(100);
        const paintable = new Gtk.WidgetPaintable({ widget: window });
        const snapshot = new Gtk.Snapshot();
        paintable.snapshot(snapshot, window.get_width(), window.get_height());
        const texture = window.get_renderer().render_texture(snapshot.to_node(), null);
        assert(texture.get_width() > 0, 'Native math snapshot failed');
        if (ARGV.includes('--capture'))
            texture.save_to_png(`/tmp/cusco-math-${dark ? 'dark' : 'light'}.png`);
    }
    settings.gtk_application_prefer_dark_theme = previousDark;
    scroller.set_child(null);
    window.set_child(null);
    await delay();
    window.destroy();
    await delay();
} else {
    print('No display: native GTK math checks skipped');
}

print('Cusco math smoke passed');
