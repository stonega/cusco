import { clone, validateParameterValue } from './validation.js';

// This registry is code-owned: catalog updates can supply values, never wire paths.
export const CHAT_PARAMETER_FIELDS = {
    'openai-responses': { temperature: 'temperature', topP: 'top_p', parallelToolCalls: 'parallel_tool_calls', toolChoice: 'tool_choice' },
    'openai-chat-completions': { temperature: 'temperature', topP: 'top_p', stop: 'stop', seed: 'seed', frequencyPenalty: 'frequency_penalty', presencePenalty: 'presence_penalty', parallelToolCalls: 'parallel_tool_calls', toolChoice: 'tool_choice', responseFormat: 'response_format' },
    'anthropic-messages': { temperature: 'temperature', topP: 'top_p', topK: 'top_k', stop: 'stop_sequences' },
    'gemini-generate-content': { temperature: 'temperature', topP: 'topP', topK: 'topK', stop: 'stopSequences', seed: 'seed', frequencyPenalty: 'frequencyPenalty', presencePenalty: 'presencePenalty' },
};
export const IMAGE_PARAMETER_FIELDS = {
    'openai-images': { size: 'size', quality: 'quality', outputFormat: 'output_format', background: 'background' },
    'gemini-interactions': {},
    'zai-images': { size: 'size' },
};
const PROVIDER_FORMATS = {
    openai: 'openai-responses', anthropic: 'anthropic-messages', gemini: 'gemini-generate-content',
    kimi: 'openai-chat-completions', deepseek: 'openai-responses', grok: 'openai-responses', zai: 'openai-chat-completions',
};
export const RUNTIME_PARAMETERS = Object.fromEntries([
    ...Object.entries(PROVIDER_FORMATS).map(([id, format]) => [id, Object.keys(CHAT_PARAMETER_FIELDS[format])]),
    ['openai:image', Object.keys(IMAGE_PARAMETER_FIELDS['openai-images'])],
    ['grok:image', Object.keys(IMAGE_PARAMETER_FIELDS['openai-images'])],
    ['gemini:image', []], ['zai:image', ['size']],
]);

export function parameterValues(model, requested = {}, { thinkingLevel = 'off', fields = {} } = {}) {
    const values = {};
    const parameters = model?.parameters ?? {};
    for (const name of Object.keys(requested)) {
        if (!parameters[name]?.runtime || parameters[name].support !== 'supported' || !fields[name])
            throw new Error(`The selected model does not support the ${name} request parameter in Cusco.`);
    }
    for (const [name, descriptor] of Object.entries(parameters)) {
        const explicit = Object.hasOwn(requested, name);
        if (!explicit && (!descriptor.runtime || descriptor.support !== 'supported'
            || !fields[name] || !Object.hasOwn(descriptor, 'default')))
            continue;
        if (descriptor.onlyWithoutThinking && thinkingLevel !== 'off') {
            if (explicit)
                throw new Error(`${name} cannot be used with this model's reasoning mode.`);
            continue;
        }
        const value = explicit ? requested[name] : descriptor.default;
        validateParameterValue(value, descriptor, `parameters.${name}`);
        if (name === 'stop' && (!Array.isArray(value) || value.some(item => typeof item !== 'string')))
            throw new Error('Stop sequences must be an array of strings.');
        values[fields[name]] = clone(value);
    }
    return values;
}

export function applyChatParameters(body, format, options) {
    const model = options.model;
    if (model?.supportsStreaming === false && options.stream)
        throw new Error('The selected model does not support streaming.');
    const hasTools = (body.tools?.length ?? 0) > 0;
    if (hasTools && model?.supportsFunctionCalling === false)
        throw new Error('The selected model does not support tool calls.');
    const values = parameterValues(model, options.parameters, {
        fields: CHAT_PARAMETER_FIELDS[format] ?? {}, thinkingLevel: options.thinkingLevel ?? 'off',
    });
    if (!hasTools && ('tool_choice' in values || 'parallel_tool_calls' in values))
        throw new Error('Tool parameters require tools in the request.');
    Object.assign(format === 'gemini-generate-content' ? body.generationConfig : body, values);
    return body;
}
