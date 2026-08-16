import { importPackageModule } from '../packageLoader.js';

const implementation = await importPackageModule('hooks/config.js');

export const {
    HOOK_EVENTS,
    defaultUserHooksPath,
    workspaceHooksPath,
    discoverHookSources,
    hookMatcherMatches,
    canonicalHookToolName,
} = implementation;
