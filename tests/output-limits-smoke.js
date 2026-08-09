import {
    CONTEXT_OUTPUT_RESERVE_TOKENS,
    createOutputCapacityError,
    DEFAULT_MAX_OUTPUT_TOKENS,
    estimateRequestInputTokens,
    isOutputCapacityError,
    normalizeMaxOutputTokens,
    resolveEffectiveMaxOutputTokens,
} from '../src/providers/outputLimits.js';

function assertEqual(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

assertEqual(DEFAULT_MAX_OUTPUT_TOKENS, 16384, 'Default custom-model output limit');
assertEqual(CONTEXT_OUTPUT_RESERVE_TOKENS, 4096, 'Context output reserve');
assertEqual(normalizeMaxOutputTokens(undefined), 16384, 'Missing configured output limit');
assertEqual(normalizeMaxOutputTokens(128), 128, 'Small configured output limit remains unchanged');
assertEqual(normalizeMaxOutputTokens(131072), 131072, 'Large model output limit remains unchanged');

assertEqual(resolveEffectiveMaxOutputTokens({
    configuredMaxOutputTokens: 32768,
    contextWindowTokens: 100000,
    estimatedInputTokens: 80000,
}), 15904, 'Remaining-context output clamp');
assertEqual(resolveEffectiveMaxOutputTokens({
    configuredMaxOutputTokens: 32768,
    callMaxOutputTokens: 4096,
    contextWindowTokens: 100000,
    estimatedInputTokens: 80000,
}), 4096, 'Call-specific output cap');
assertEqual(resolveEffectiveMaxOutputTokens({
    configuredMaxOutputTokens: 32768,
    contextWindowTokens: undefined,
    estimatedInputTokens: 999999,
}), 32768, 'Unknown context uses configured maximum');
assertEqual(resolveEffectiveMaxOutputTokens({
    configuredMaxOutputTokens: 32768,
    contextWindowTokens: 5000,
    estimatedInputTokens: 500,
}), 404, 'Small positive runtime remainder is preserved');
assertEqual(resolveEffectiveMaxOutputTokens({
    configuredMaxOutputTokens: 32768,
    contextWindowTokens: 4096,
    estimatedInputTokens: 1,
}), 0, 'Non-positive runtime remainder blocks dispatch');

const shortMessageEstimate = estimateRequestInputTokens([
    { role: 'user', content: 'Hello' },
]);
const largeToolEstimate = estimateRequestInputTokens([
    { role: 'user', content: 'Hello' },
], [{
    name: 'large_tool',
    description: 'x'.repeat(20000),
    inputSchema: {
        type: 'object',
        properties: { content: { type: 'string' } },
    },
}]);
const imageEstimate = estimateRequestInputTokens([
    {
        role: 'user',
        content: 'Describe this',
        attachments: [{ kind: 'image', name: 'image.png', path: '/tmp/image.png' }],
    },
]);

assertEqual(largeToolEstimate > shortMessageEstimate + 4096, true, 'Tool schemas count toward request context');
assertEqual(imageEstimate > shortMessageEstimate, true, 'Image attachments count toward request context');

const capacityError = createOutputCapacityError('Not enough room for a response.');
assertEqual(isOutputCapacityError(capacityError), true, 'Typed capacity error recognition');
assertEqual(isOutputCapacityError(new Error('Other failure')), false, 'Ordinary error is not capacity error');

print('Cusco output limits smoke passed');
