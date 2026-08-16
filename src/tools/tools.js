import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('toolRuntime/tools.js');

export const {
    calculateExpression,
    summarizeStructuredData,
    extractExaSearchResults,
    extractDuckDuckGoSearchResults,
    searchWeb,
    listLocalDirectory,
    readLocalTextFile,
    commandUsesSudo,
    normalizeBashTimeoutSeconds,
    runBashCommand,
    parseToolRequest,
    formatToolResultForTranscript,
    ToolManager,
} = implementation;
