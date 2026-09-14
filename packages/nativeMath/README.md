# Native math

`label.js` exports `MathLabel`, a selectable GTK label that paints local SVG
formulas into Pango shape ranges. `render.js` exports `renderMath(tex, display)`;
invalid, oversized, or unsupported input returns `null` and stays visible as TeX.
The original TeX remains in the label for accessibility and copying. In display
math, selected text normalizes line breaks to spaces; the message Copy action
always retains the original source.

The application uses the checked-in `mathjax.js` bundle, so rendering needs no
browser, Node.js, network access, external fonts, or extra GI dependency. SVG
rasterization uses the existing GdkPixbuf SVG loader. Formula colors follow the
label foreground, and textures use the display scale factor.

The bundle contains MathJax **3.2.2** (Apache-2.0; see `LICENSE.mathjax`) and its
TeX SVG font paths. Version 3 supplies the synchronous, self-contained font
pipeline used by GJS. Only `base`, `ams`, and `newcommand` are enabled. This
supports fractions, roots, scripts, sums, integrals, matrices, and aligned
equations; it does not load arbitrary TeX packages or external resources.
Each conversion has fresh TeX state, and caches and input expansion are bounded.

To rebuild with the pinned dependencies (development only), in this directory:

```sh
bun install --frozen-lockfile
bun run build
```

`mathjax-entry.js` is the auditable build entry point; do not edit the generated
bundle. Run `gjs -m tests/math-smoke.js` from the repository root after rebuilding.
