# Image Viewer and Editor

Select an image in a message, tool result, artifact preview, or composer attachment to open it in Cusco's native image viewer. Images open fitted to the window. Use the mouse, touchpad, or the zoom controls to zoom and pan; the header also provides fullscreen and image information.

## Draw and annotate

Select **Draw** to add annotations. The right sidebar provides selection, pencil, line, arrow, rectangle, ellipse, and text tools, along with a preset color palette, four size choices, and optional shape fill. After creating an annotation, Cusco returns to Select so it can be moved, resized, recolored, duplicated, or deleted. Duplicate and Delete appear only while an annotation is selected. Undo and redo treat one stroke or drag as one action.

On narrow windows, the same controls open as a bottom sheet so the canvas remains usable.

Choose Text and click the image to type directly at that position. Press Enter or click elsewhere to finish, Escape to cancel, and double-click existing text (or select it and press Enter) to edit it again. The exported image is flattened, so annotation objects are not editable after the viewer closes.

## Crop and transform

Select **Crop** to drag the crop handles or choose Free, Original, Square, 5:4, 4:3, 3:2, or 16:9. The same panel can rotate left or right and flip horizontally or vertically. Cropping and transforms also move or clip existing annotations.

## Saving and adding to chat

Edits never replace the original image.

- **Save a Copy…** writes a flattened PNG to a location you choose and adds a `.png` extension when needed.
- **Save & Add to Chat** writes a durable PNG in Cusco's application data and adds it to the composer. It does not send a message; add any prompt you want and send normally.

If the active provider does not accept image input, saving remains available but adding to chat is disabled. SVG images and animated GIFs can be viewed; editing them creates a static PNG from the displayed rendering or animation frame. Animation, vector data, EXIF, and other source metadata are not retained in edited PNGs.

Cusco keeps edited images used by conversations because conversation history references their local paths.
