import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('markdownPango/markdown.js');

export const {
    parseMarkdownBlocks,
    stabilizeStreamingMarkdown,
    inlineMarkdownToPangoMarkup,
    inlineMarkdownToPangoRenderModel,
    markdownToPangoRenderModel,
    markdownToPangoMarkup,
} = implementation;
