# Image Viewer and Editor Architecture

The image editor is a native GTK 4/libadwaita subsystem with three layers:

- A display-independent document model stores normalized annotation geometry, image transforms, selection, and bounded undo/redo history.
- A Cairo/GdkPixbuf renderer applies crop, rotation, and flip operations at source resolution, then flattens vector annotations into an ARGB PNG surface.
- A transient application window owns the viewing canvas, gestures, dialogs, save actions, and editing controls that adapt from a trailing sidebar to an `Adw.BottomSheet` on narrow windows.

Transcript, attachment, tool-result, and artifact renderers receive an `onOpenImage` callback. They pass local path and display metadata through that callback instead of importing the image window or opening the desktop URI handler. The main Cusco window supplies the callback and bridges **Save & Add to Chat** into its existing pending-attachment flow.

## Persistence boundary

Source files and immutable artifact revisions are never modified. User-selected copies are written through a same-directory temporary PNG and atomic move. Chat-bound edits receive unique names under `$XDG_DATA_HOME/io.github.stonega.Cusco/edited-images`, with a `0700` directory and `0600` files. These files are deliberately not treated as temporary cache entries because stored conversations keep their paths.

The editable document exists only for the viewer session. Saved PNGs contain the flattened pixels and no sidecar project state.

## Coordinate and history model

Annotation geometry and style sizes are normalized against the current oriented image. Crop, quarter-turn rotation, and flip operations remap annotations while recording corresponding image transforms for the renderer. Pointer gestures use transactions so intermediate motion does not fill the history stack; one completed stroke, move, or resize produces one undo entry.

Preview drawing maps normalized coordinates through the current fit/zoom/pan transform. Export replays image transforms on the original decoded pixbuf and renders annotations at the resulting full pixel dimensions.

## Format behavior

Embedded raster orientation is applied before editing. PNG, JPEG, WebP, and BMP sources are flattened to PNG. SVG rendering and the current animated-GIF frame can also be flattened after a visible warning. Alpha is preserved, but animation, vector instructions, color-profile metadata, EXIF, and other source metadata are intentionally outside the output contract.
