# Provider icon pile physics

This package owns the deterministic provider-icon drop setup, Matter.js
simulation adapter, and the pinned physics-engine build used by Cusco's Usage
card.

Cusco vendors Matter.js 0.20.0 from the upstream `build/matter.min.js` release:

https://github.com/liabru/matter-js/tree/0.20.0

The UMD global target is changed from `this` to `globalThis`, and a default
ES-module export is appended so the official build loads under GJS. The
physics engine remains otherwise unchanged. Matter.js is licensed under the
MIT license in `LICENSE.matter-js`.
