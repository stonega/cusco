// Build-time entry point. The application imports the bundled mathjax.js.
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const inputOptions = {
    packages: ['base', 'ams', 'newcommand'],
    maxBuffer: 8192,
    maxMacros: 1000,
    formatError(_jax, error) { throw error; },
};
const output = new SVG({ fontCache: 'none' });

export function typeset(source, display = false) {
    // Definitions and equation numbering must not leak between messages.
    const document = mathjax.document('', {
        InputJax: new TeX(inputOptions),
        OutputJax: output,
    });
    const node = document.convert(source, { display, em: 16, ex: 8, containerWidth: 1280 });
    const svg = adaptor.firstChild(node);
    const viewBox = adaptor.getAttribute(svg, 'viewBox').split(/\s+/).map(Number);
    const depth = -parseFloat(adaptor.getStyle(svg, 'vertical-align') || '0');
    const height = parseFloat(adaptor.getAttribute(svg, 'height'));
    return { svg: adaptor.outerHTML(svg), viewBox, depthRatio: depth / height };
}
