import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('imageEditorCore/renderer.js');

export const {
    loadImageSource,
    loadImageSourceAsync,
    applyImageTransforms,
    renderDocumentToSurface,
    exportDocumentPng,
    defaultEditedImageDirectory,
    createEditedImagePath,
    saveDocumentForChat,
} = implementation;
