import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import WebKit from 'gi://WebKit?version=6.0';

import { normalizeArtifactBundlePath } from '../../storage/artifactStore.js';

export const ARTIFACT_WEB_SCHEME = 'cusco-artifact';

const TEXT_ENCODER = new TextEncoder();

export function artifactContentSecurityPolicy(capabilities = []) {
    const allowNetwork = capabilities.includes('network');
    const networkSources = allowNetwork ? ' https: http:' : '';

    return [
        `default-src 'none'`,
        `base-uri 'none'`,
        `object-src 'none'`,
        `frame-src 'none'`,
        `worker-src 'none'`,
        `form-action 'none'`,
        `connect-src 'self'${networkSources}`,
        `img-src 'self' data: blob:${networkSources}`,
        `media-src 'self' data: blob:${networkSources}`,
        `font-src 'self' data:${networkSources}`,
        `style-src 'self' 'unsafe-inline'${networkSources}`,
        `script-src 'self' 'unsafe-inline'`,
    ].join('; ');
}

export function artifactWebUri(artifactId, revisionId, relativePath) {
    const safeArtifactId = String(artifactId ?? '').trim();
    const safeRevisionId = String(revisionId ?? '').trim();
    const path = normalizeArtifactBundlePath(relativePath);

    if (!/^[A-Za-z0-9._-]+$/.test(safeArtifactId)
        || !/^[A-Za-z0-9._-]+$/.test(safeRevisionId)) {
        throw new Error('Artifact web URI contains an invalid identifier.');
    }

    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `${ARTIFACT_WEB_SCHEME}://${safeArtifactId}/${safeRevisionId}/${encodedPath}`;
}

export function parseArtifactWebUri(uri) {
    try {
        const parsed = GLib.Uri.parse(String(uri ?? ''), GLib.UriFlags.NONE);

        if (parsed.get_scheme() !== ARTIFACT_WEB_SCHEME)
            return null;

        const artifactId = parsed.get_host();
        const parts = String(parsed.get_path() ?? '')
            .split('/')
            .filter(Boolean)
            .map((part) => decodeURIComponent(part));
        const revisionId = parts.shift() ?? '';
        const relativePath = normalizeArtifactBundlePath(parts.join('/'));

        if (!artifactId || !revisionId)
            return null;

        return { artifactId, revisionId, relativePath };
    } catch (_error) {
        return null;
    }
}

export function isArtifactWebUriAllowed(uri, binding) {
    if (uri === 'about:blank')
        return true;

    const parsed = parseArtifactWebUri(uri);

    return Boolean(parsed
        && parsed.artifactId === binding?.artifactId
        && parsed.revisionId === binding?.revisionId);
}

function finishRequest(request, contents, mimeType = 'text/plain') {
    const bytes = contents instanceof Uint8Array ? contents : TEXT_ENCODER.encode(String(contents ?? ''));
    const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
    request.finish(stream, bytes.length, mimeType);
}

function finishRequestDenied(request) {
    finishRequest(request, 'Artifact resource is unavailable.', 'text/plain');
}

export class ArtifactWebRuntime {
    constructor(artifactManager) {
        this._artifacts = artifactManager;
        this.context = WebKit.WebContext.new();
        this.networkSession = WebKit.NetworkSession.new_ephemeral();
        const securityManager = this.context.get_security_manager();

        securityManager.register_uri_scheme_as_secure(ARTIFACT_WEB_SCHEME);
        securityManager.register_uri_scheme_as_display_isolated(ARTIFACT_WEB_SCHEME);
        this.networkSession.connect('download-started', (_session, download) => {
            download.cancel();
        });
        this.context.register_uri_scheme(ARTIFACT_WEB_SCHEME, (request) => {
            this._handleSchemeRequest(request);
        });
    }

    _handleSchemeRequest(request) {
        const view = request.get_web_view();
        const binding = view?._cuscoArtifactBinding;
        const parsed = parseArtifactWebUri(request.get_uri());

        if (!parsed
            || !binding
            || parsed.artifactId !== binding.artifactId
            || parsed.revisionId !== binding.revisionId) {
            finishRequestDenied(request);
            return;
        }

        const resolved = this._artifacts.getArtifactRevision(parsed.artifactId, parsed.revisionId);
        const descriptor = resolved?.revision.manifest.files.find((file) => (
            file.path === parsed.relativePath
        ));

        if (!resolved || !descriptor) {
            finishRequestDenied(request);
            return;
        }

        try {
            finishRequest(
                request,
                this._artifacts.readFile(parsed.artifactId, parsed.revisionId, parsed.relativePath),
                descriptor.mimeType,
            );
        } catch (error) {
            logError(error, `Failed to serve artifact resource: ${request.get_uri()}`);
            finishRequestDenied(request);
        }
    }

    createWebView(resolved, options = {}) {
        const capabilities = resolved.artifact.capabilities ?? [];
        const scriptsEnabled = capabilities.includes('scripts');
        const persistentStorageEnabled = capabilities.includes('persistent-storage');
        const settings = new WebKit.Settings();

        settings.set_enable_javascript(scriptsEnabled);
        settings.set_enable_javascript_markup(scriptsEnabled);
        settings.set_javascript_can_access_clipboard(false);
        settings.set_javascript_can_open_windows_automatically(false);
        settings.set_allow_file_access_from_file_urls(false);
        settings.set_allow_universal_access_from_file_urls(false);
        settings.set_allow_modal_dialogs(false);
        settings.set_enable_developer_extras(false);
        settings.set_enable_dns_prefetching(false);
        settings.set_enable_fullscreen(false);
        settings.set_enable_html5_database(false);
        settings.set_enable_html5_local_storage(persistentStorageEnabled);
        settings.set_enable_media_stream(false);
        settings.set_enable_webrtc(false);
        settings.set_enable_page_cache(false);
        settings.set_media_playback_requires_user_gesture(true);

        const binding = {
            artifactId: resolved.artifact.id,
            revisionId: resolved.revision.id,
        };
        const webView = new WebKit.WebView({
            web_context: this.context,
            network_session: this.networkSession,
            settings,
            default_content_security_policy: artifactContentSecurityPolicy(capabilities),
            hexpand: true,
            vexpand: true,
        });

        webView._cuscoArtifactBinding = binding;
        webView.connect('decide-policy', (_view, decision, decisionType) => {
            if (decisionType === WebKit.PolicyDecisionType.NAVIGATION_ACTION
                || decisionType === WebKit.PolicyDecisionType.NEW_WINDOW_ACTION) {
                const action = decision.get_navigation_action();
                const uri = action?.get_request()?.get_uri() ?? '';

                if (isArtifactWebUriAllowed(uri, binding)) {
                    decision.use();
                } else {
                    decision.ignore();

                    if (action?.is_user_gesture?.() && /^https?:\/\//i.test(uri))
                        options.onExternalLink?.(uri);
                }

                return true;
            }

            return false;
        });
        webView.connect('permission-request', (_view, request) => {
            request.deny();
            return true;
        });
        webView.connect('context-menu', () => true);
        webView.connect('create', () => null);
        webView.connect('web-process-terminated', (_view, reason) => {
            options.onTerminated?.(reason);
        });

        const entrypointUri = artifactWebUri(
            resolved.artifact.id,
            resolved.revision.id,
            resolved.revision.manifest.entrypoint,
        );
        webView.load_uri(entrypointUri);
        webView.disposeArtifactView = () => webView.stop_loading();
        webView.releaseArtifactView = () => webView.run_dispose();
        webView.stopArtifactView = () => webView.terminate_web_process();
        return webView;
    }
}
