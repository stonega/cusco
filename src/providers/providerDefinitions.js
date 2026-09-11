// Transport origins and authentication are application-owned, never remotely updated.
export const PROVIDER_DEFINITIONS = [
    {
        "id": "openai",
        "name": "OpenAI",
        "description": "OpenAI Responses API for GPT models.",
        "themeColor": "#000000",
        "implemented": true,
        "enabled": false,
        "apiFormat": "openai-responses",
        "imageApiFormat": "openai-images",
        "apiKeyRequired": true,
        "apiKeyConfigured": false,
        "apiKeyEnvVar": "OPENAI_API_KEY",
        "baseUrl": "https://api.openai.com/v1"
    },
    {
        "id": "anthropic",
        "name": "Anthropic",
        "description": "Claude Messages API.",
        "themeColor": "#F1F0E8",
        "implemented": true,
        "enabled": false,
        "apiFormat": "anthropic-messages",
        "apiKeyRequired": true,
        "apiKeyConfigured": false,
        "apiKeyEnvVar": "ANTHROPIC_API_KEY",
        "baseUrl": "https://api.anthropic.com/v1"
    },
    {
        "id": "gemini",
        "name": "Google Gemini",
        "description": "Gemini generateContent API.",
        "themeColor": "#3186FF",
        "implemented": true,
        "enabled": false,
        "apiFormat": "gemini-generate-content",
        "imageApiFormat": "gemini-interactions",
        "apiKeyRequired": true,
        "apiKeyConfigured": false,
        "apiKeyEnvVar": "GEMINI_API_KEY",
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta"
    },
    {
        "id": "kimi",
        "name": "Kimi",
        "description": "Moonshot Kimi OpenAI-compatible API.",
        "themeColor": "#1783FF",
        "implemented": true,
        "enabled": false,
        "apiFormat": "openai-chat-completions",
        "apiKeyRequired": true,
        "apiKeyConfigured": false,
        "apiKeyEnvVar": "MOONSHOT_API_KEY",
        "baseUrl": "https://api.moonshot.ai/v1",
        "defaultEndpointPresetId": "global",
        "endpointPresetId": "global",
        "endpointPresets": [
            {
                "id": "global",
                "label": "Global",
                "baseUrl": "https://api.moonshot.ai/v1"
            },
            {
                "id": "cn",
                "label": "CN",
                "baseUrl": "https://api.moonshot.cn/v1"
            }
        ],
        "chatPath": "/chat/completions"
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "description": "DeepSeek Responses API.",
        "themeColor": "#4D6BFE",
        "implemented": true,
        "enabled": false,
        "apiFormat": "openai-responses",
        "apiKeyRequired": true,
        "apiKeyConfigured": false,
        "apiKeyEnvVar": "DEEPSEEK_API_KEY",
        "baseUrl": "https://api.deepseek.com"
    },
    {
        "id": "grok",
        "name": "Grok",
        "description": "xAI Grok Responses API.",
        "themeColor": "#111111",
        "implemented": true,
        "enabled": false,
        "apiFormat": "openai-responses",
        "imageApiFormat": "openai-images",
        "apiKeyRequired": true,
        "apiKeyConfigured": false,
        "apiKeyEnvVar": "XAI_API_KEY",
        "baseUrl": "https://api.x.ai/v1"
    },
    {
        "id": "zai",
        "name": "Z.ai",
        "description": "Z.ai GLM OpenAI-compatible API.",
        "themeColor": "#000000",
        "implemented": true,
        "enabled": false,
        "apiFormat": "openai-chat-completions",
        "supportsModelDiscovery": false,
        "imageApiFormat": "zai-images",
        "imageModelDiscoveryRequiresApiKey": false,
        "apiKeyRequired": true,
        "apiKeyConfigured": false,
        "apiKeyEnvVar": "ZAI_API_KEY",
        "baseUrl": "https://api.z.ai/api/paas/v4",
        "chatPath": "/chat/completions"
    }
];
