import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Soup from 'gi://Soup?version=3.0';

import { createImageArtifactFromPath } from '../chat/artifacts.js';
import { TOOL_PERMISSION_ASK } from '../tools/permissions.js';

const APP_ID = 'io.github.stonega.Cusco';
const DEFAULT_IMAGE_TIMEOUT_SECONDS = 90;
const DEFAULT_IMAGE_MIME_TYPE = 'image/png';

function createUserVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function isGioError(error, code) {
    return typeof error?.matches === 'function' && error.matches(Gio.IOErrorEnum, code);
}

function isLoopbackHost(host) {
    return host === 'localhost'
        || host === '::1'
        || host === '127.0.0.1'
        || host?.startsWith('127.');
}

function shouldBypassProxy(url) {
    try {
        return isLoopbackHost(GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host());
    } catch (_error) {
        return false;
    }
}

function createSession(url, timeoutSeconds) {
    const options = { timeout: timeoutSeconds };

    if (shouldBypassProxy(url))
        options.proxy_resolver = new Gio.SimpleProxyResolver({ default_proxy: null });

    return new Soup.Session(options);
}

function normalizeUrl(baseUrl, path) {
    return `${String(baseUrl ?? '').replace(/\/$/, '')}${path}`;
}

function encodeJsonBody(body) {
    return new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
}

function responseStatusCode(message) {
    const statusCode = Number(message.status_code);

    if (Number.isFinite(statusCode))
        return statusCode;

    return Number(message.get_status());
}

function responseMimeType(message) {
    try {
        const contentType = message.response_headers?.get_content_type?.();

        if (typeof contentType === 'string')
            return contentType;

        if (Array.isArray(contentType))
            return contentType.find((item) => typeof item === 'string') ?? DEFAULT_IMAGE_MIME_TYPE;
    } catch (_error) {
        // Missing or malformed Content-Type headers should not block saving.
    }

    return DEFAULT_IMAGE_MIME_TYPE;
}

function sendAndRead(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                resolve(session.send_and_read_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function postJson(url, headers, body, options = {}) {
    const {
        cancellable = null,
        providerName = 'Provider',
        timeoutSeconds = DEFAULT_IMAGE_TIMEOUT_SECONDS,
    } = options;
    const session = createSession(url, timeoutSeconds);
    const message = Soup.Message.new('POST', url);

    message.request_headers.append('Content-Type', 'application/json');

    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    message.set_request_body_from_bytes('application/json', encodeJsonBody(body));

    let bytes;

    try {
        bytes = await sendAndRead(session, message, cancellable);
    } catch (error) {
        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            error.userMessage = `${providerName} image generation was cancelled.`;
        else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
            error.userMessage = `${providerName} did not return an image within ${timeoutSeconds} seconds.`;

        throw error;
    }

    const responseText = new TextDecoder().decode(bytes.get_data());
    let responseJson = null;

    try {
        responseJson = JSON.parse(responseText);
    } catch (_error) {
        responseJson = null;
    }

    const status = responseStatusCode(message);

    if (status < 200 || status >= 300) {
        const messageText = responseJson?.error?.message ?? responseJson?.message ?? responseText;
        throw createUserVisibleError(`${providerName} image generation failed (${status}): ${messageText}`);
    }

    return responseJson;
}

async function getJson(url, headers, options = {}) {
    const {
        cancellable = null,
        providerName = 'Provider',
        timeoutSeconds = DEFAULT_IMAGE_TIMEOUT_SECONDS,
    } = options;
    const session = createSession(url, timeoutSeconds);
    const message = Soup.Message.new('GET', url);

    for (const [name, value] of Object.entries(headers))
        message.request_headers.append(name, value);

    let bytes;

    try {
        bytes = await sendAndRead(session, message, cancellable);
    } catch (error) {
        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            error.userMessage = `${providerName} image model discovery was cancelled.`;
        else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
            error.userMessage = `${providerName} did not return image models within ${timeoutSeconds} seconds.`;

        throw error;
    }

    const responseText = new TextDecoder().decode(bytes.get_data());
    let responseJson = null;

    try {
        responseJson = JSON.parse(responseText);
    } catch (_error) {
        responseJson = null;
    }

    const status = responseStatusCode(message);

    if (status < 200 || status >= 300) {
        const messageText = responseJson?.error?.message ?? responseJson?.message ?? responseText;
        throw createUserVisibleError(`${providerName} image model discovery failed (${status}): ${messageText}`);
    }

    return responseJson;
}

async function getBytes(url, options = {}) {
    const {
        cancellable = null,
        providerName = 'Provider',
        timeoutSeconds = DEFAULT_IMAGE_TIMEOUT_SECONDS,
    } = options;
    const session = createSession(url, timeoutSeconds);
    const message = Soup.Message.new('GET', url);

    let bytes;

    try {
        bytes = await sendAndRead(session, message, cancellable);
    } catch (error) {
        if (isGioError(error, Gio.IOErrorEnum.CANCELLED))
            error.userMessage = `${providerName} image download was cancelled.`;
        else if (isGioError(error, Gio.IOErrorEnum.TIMED_OUT))
            error.userMessage = `${providerName} image download timed out.`;

        throw error;
    }

    const status = responseStatusCode(message);

    if (status < 200 || status >= 300)
        throw createUserVisibleError(`${providerName} image download failed (${status}).`);

    return {
        bytes: bytes.get_data(),
        mimeType: responseMimeType(message),
    };
}

function normalizePrompt(prompt) {
    const text = String(prompt ?? '').trim();

    if (!text)
        throw createUserVisibleError('Image prompt cannot be empty.');

    return text;
}

function extensionForMimeType(mimeType) {
    switch (String(mimeType ?? '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
        return 'jpg';
    case 'image/webp':
        return 'webp';
    case 'image/gif':
        return 'gif';
    case 'image/svg+xml':
        return 'svg';
    case 'image/png':
    default:
        return 'png';
    }
}

function defaultImageDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        APP_ID,
        'generated-images',
    ]);
}

export function saveGeneratedImageBytes(bytes, options = {}) {
    const mimeType = options.mimeType || DEFAULT_IMAGE_MIME_TYPE;
    const directory = options.directory ?? defaultImageDirectory();
    const extension = extensionForMimeType(mimeType);
    const path = GLib.build_filenamev([
        directory,
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${GLib.uuid_string_random()}.${extension}`,
    ]);

    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(path, bytes);

    return {
        path,
        mimeType,
    };
}

export function buildOpenAiImageGenerationBody(prompt, modelId, options = {}) {
    const body = {
        model: modelId,
        prompt,
        n: 1,
    };

    if (options.size)
        body.size = String(options.size);

    return body;
}

export function buildGeminiImageGenerationBody(prompt, modelId) {
    return {
        model: modelId,
        input: [
            {
                type: 'text',
                text: prompt,
            },
        ],
    };
}

export function buildZaiImageGenerationBody(prompt, modelId, options = {}) {
    return {
        model: modelId,
        prompt,
        size: String(options.size ?? '1280x1280'),
    };
}

export function extractImageResponsePayload(response) {
    const dataItems = Array.isArray(response?.data) ? response.data : [];

    for (const item of dataItems) {
        if (typeof item?.b64_json === 'string' && item.b64_json)
            return {
                type: 'base64',
                data: item.b64_json,
                mimeType: item.mime_type ?? item.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
            };

        if (typeof item?.url === 'string' && item.url)
            return {
                type: 'url',
                url: item.url,
                mimeType: item.mime_type ?? item.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
            };
    }

    const interactionImage = response?.interaction?.output_image
        ?? response?.interaction?.outputImage
        ?? response?.output_image
        ?? response?.outputImage;

    if (typeof interactionImage?.data === 'string' && interactionImage.data) {
        return {
            type: 'base64',
            data: interactionImage.data,
            mimeType: interactionImage.mime_type ?? interactionImage.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
        };
    }

    const stepItems = Array.isArray(response?.steps) ? response.steps : [];

    for (const step of stepItems) {
        const contentItems = [
            ...(Array.isArray(step?.content) ? step.content : []),
            ...(Array.isArray(step?.summary) ? step.summary : []),
        ];

        for (const content of contentItems) {
            if (content?.type !== 'image')
                continue;

            if (typeof content.data === 'string' && content.data) {
                return {
                    type: 'base64',
                    data: content.data,
                    mimeType: content.mime_type ?? content.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
                };
            }

            if (typeof content.uri === 'string' && content.uri) {
                return {
                    type: 'url',
                    url: content.uri,
                    mimeType: content.mime_type ?? content.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
                };
            }
        }
    }

    const outputItems = Array.isArray(response?.output) ? response.output : [];

    for (const item of outputItems) {
        if (item?.type === 'image_generation_call' && typeof item?.result === 'string' && item.result) {
            return {
                type: 'base64',
                data: item.result,
                mimeType: item.mime_type ?? item.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
            };
        }

        if (item?.type === 'image' && typeof item?.data === 'string' && item.data) {
            return {
                type: 'base64',
                data: item.data,
                mimeType: item.mime_type ?? item.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
            };
        }

        if (item?.type === 'image' && typeof item?.uri === 'string' && item.uri) {
            return {
                type: 'url',
                url: item.uri,
                mimeType: item.mime_type ?? item.mimeType ?? DEFAULT_IMAGE_MIME_TYPE,
            };
        }
    }

    throw createUserVisibleError('The provider did not return an image.');
}

function modelIdFromItem(item) {
    return String(item?.id ?? item?.name ?? '').replace(/^models\//, '').trim();
}

function modelNameFromItem(item, id) {
    return String(item?.displayName ?? item?.name ?? item?.id ?? id).replace(/^models\//, '');
}

function extractModelItems(response) {
    const items = response?.data ?? response?.models ?? [];

    return Array.isArray(items) ? items : [];
}

export async function discoverOpenAiImageModels(config, options = {}) {
    const response = await getJson(
        normalizeUrl(config.baseUrl, '/models'),
        { Authorization: `Bearer ${config.apiKey}` },
        {
            cancellable: options.cancellable ?? null,
            providerName: config.name,
            timeoutSeconds: options.timeoutSeconds,
        },
    );

    return extractModelItems(response)
        .map((item) => {
            const id = modelIdFromItem(item);

            return id
                ? {
                    id,
                    name: modelNameFromItem(item, id),
                    description: item.description ?? 'Discovered image generation model.',
                }
                : null;
        })
        .filter((model) => model?.id?.startsWith('gpt-image-'));
}

export async function discoverGeminiImageModels(config, options = {}) {
    const response = await getJson(
        `${normalizeUrl(config.baseUrl, '/models')}?key=${encodeURIComponent(config.apiKey)}`,
        {},
        {
            cancellable: options.cancellable ?? null,
            providerName: config.name,
            timeoutSeconds: options.timeoutSeconds,
        },
    );

    return extractModelItems(response)
        .map((item) => {
            const id = modelIdFromItem(item);

            return id
                ? {
                    id,
                    name: modelNameFromItem(item, id),
                    description: item.description ?? 'Discovered image generation model.',
                }
                : null;
        })
        .filter((model) => model?.id?.endsWith('-image'));
}

export function discoverZaiImageModels() {
    return [
        {
            id: 'glm-image',
            name: 'GLM-Image',
            description: 'Z.ai text-to-image model.',
        },
    ];
}

async function readImagePayload(payload, options = {}) {
    if (payload.type === 'base64') {
        return {
            bytes: GLib.base64_decode(payload.data),
            mimeType: payload.mimeType || DEFAULT_IMAGE_MIME_TYPE,
        };
    }

    if (payload.type === 'url') {
        const downloader = options.downloadBytes ?? getBytes;
        const downloaded = await downloader(payload.url, {
            cancellable: options.cancellable ?? null,
            providerName: options.providerName,
            timeoutSeconds: options.timeoutSeconds,
        });

        if (downloaded instanceof Uint8Array)
            return {
                bytes: downloaded,
                mimeType: payload.mimeType || DEFAULT_IMAGE_MIME_TYPE,
            };

        return {
            bytes: downloaded?.bytes,
            mimeType: downloaded?.mimeType || payload.mimeType || DEFAULT_IMAGE_MIME_TYPE,
        };
    }

    throw createUserVisibleError('The provider returned an unsupported image payload.');
}

export async function generateImageForProvider(providerConfig, imageModel, prompt, options = {}) {
    const normalizedPrompt = normalizePrompt(prompt);
    const providerName = providerConfig.name ?? 'Provider';
    const modelId = String(imageModel?.id ?? imageModel ?? '').trim();

    if (!modelId)
        throw createUserVisibleError(`${providerName} does not have a selected image generation model.`);

    const requestJson = options.requestJson ?? postJson;
    const requestOptions = {
        cancellable: options.cancellable ?? null,
        providerName,
        timeoutSeconds: options.timeoutSeconds,
    };
    let response;

    switch (providerConfig.imageApiFormat) {
    case 'openai-images':
        response = await requestJson(
            normalizeUrl(providerConfig.baseUrl, '/images/generations'),
            { Authorization: `Bearer ${providerConfig.apiKey}` },
            buildOpenAiImageGenerationBody(normalizedPrompt, modelId, options),
            requestOptions,
        );
        break;
    case 'gemini-interactions':
        response = await requestJson(
            `${normalizeUrl(providerConfig.baseUrl, '/interactions')}?key=${encodeURIComponent(providerConfig.apiKey)}`,
            {},
            buildGeminiImageGenerationBody(normalizedPrompt, modelId),
            requestOptions,
        );
        break;
    case 'zai-images':
        response = await requestJson(
            normalizeUrl(providerConfig.baseUrl, '/images/generations'),
            { Authorization: `Bearer ${providerConfig.apiKey}` },
            buildZaiImageGenerationBody(normalizedPrompt, modelId, options),
            requestOptions,
        );
        break;
    default:
        throw createUserVisibleError(`${providerName} does not support image generation.`);
    }

    const payload = extractImageResponsePayload(response);
    const image = await readImagePayload(payload, {
        ...options,
        providerName,
    });
    const saveImage = options.saveImage ?? saveGeneratedImageBytes;
    const saved = await saveImage(image.bytes, {
        mimeType: image.mimeType,
        providerId: providerConfig.id,
        modelId,
        prompt: normalizedPrompt,
    });
    const mimeType = saved.mimeType ?? image.mimeType;
    const imageArtifact = createImageArtifactFromPath(saved.path, {
        mimeType,
        title: 'Generated image',
        generatedBy: 'image_gen',
    });

    return {
        name: 'image_gen',
        label: 'Image Generation',
        input: normalizedPrompt,
        prompt: normalizedPrompt,
        providerId: providerConfig.id,
        providerName,
        modelId,
        modelName: imageModel?.name ?? modelId,
        imagePath: saved.path,
        mimeType,
        artifacts: imageArtifact ? [imageArtifact] : [],
        detail: `${providerName} · ${modelId}`,
        output: `Generated image saved to ${saved.path}`,
    };
}

export function createImageGenerationTool(providerConfigs, options = {}) {
    return {
        name: 'image_gen',
        label: 'Image Generation',
        description: 'Generate an image with the active provider image generation model.',
        inputDescription: 'A detailed image prompt.',
        permissionPolicy: TOOL_PERMISSION_ASK,
        requiresPermission: true,
        concurrencySafe: false,
        run: async (input, runOptions = {}) => {
            const { provider, model } = providerConfigs.createImageGenerationConfig(
                runOptions.imageProviderId,
                runOptions.imageModelId,
            );

            return generateImageForProvider(provider, model, input, {
                ...options,
                ...runOptions,
            });
        },
    };
}
