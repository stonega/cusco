import Gtk from 'gi://Gtk?version=4.0';

import { ArtifactWebRuntime } from '../web/runtime.js';

const MAX_ACTIVE_INLINE_WEB_VIEWS = 4;
const ACTIVE_INLINE_CONTROLLERS = [];

function removeActiveController(controller) {
    const index = ACTIVE_INLINE_CONTROLLERS.indexOf(controller);

    if (index >= 0)
        ACTIVE_INLINE_CONTROLLERS.splice(index, 1);
}

function registerActiveController(controller) {
    removeActiveController(controller);
    ACTIVE_INLINE_CONTROLLERS.push(controller);

    while (ACTIVE_INLINE_CONTROLLERS.length > MAX_ACTIVE_INLINE_WEB_VIEWS) {
        const oldest = ACTIVE_INLINE_CONTROLLERS.shift();
        oldest?.pause();
    }
}

function createInlinePlaceholder(label, onActivate) {
    const button = new Gtk.Button({
        label,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
    });
    button.connect('clicked', onActivate);
    return button;
}

export class WebArtifactRenderer {
    constructor(artifactManager, options = {}) {
        this._runtime = options.runtime ?? new ArtifactWebRuntime(artifactManager);
    }

    supports(resolved) {
        return resolved.artifact.kind === 'html';
    }

    createInlineView(_manager, resolved, options = {}) {
        if (resolved.artifact.preferredPresentation === 'panel') {
            return createInlinePlaceholder('Open interactive artifact', () => {
                options.onOpenArtifact?.();
            });
        }

        const stack = new Gtk.Stack({
            hexpand: true,
            vexpand: false,
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            transition_duration: 120,
        });
        stack.set_size_request(360, 260);
        let webView = null;
        let placeholder = null;
        const controller = {
            pause: () => {
                if (!webView)
                    return;

                const retiredView = webView;

                retiredView.disposeArtifactView?.();
                stack.remove(retiredView);
                retiredView.releaseArtifactView?.();
                webView = null;
                placeholder?.set_label('Resume interactive preview');
                stack.set_visible_child_name('placeholder');
            },
        };
        const activate = () => {
            if (webView) {
                registerActiveController(controller);
                return;
            }

            webView = this._runtime.createWebView(resolved, {
                onExternalLink: options.onExternalLink,
                onTerminated: options.onTerminated,
            });
            stack.add_named(webView, 'preview');
            stack.set_visible_child_name('preview');
            registerActiveController(controller);
        };
        placeholder = createInlinePlaceholder(
            'Run interactive preview',
            activate,
        );

        stack.add_named(placeholder, 'placeholder');
        stack.set_visible_child_name('placeholder');
        stack.pauseArtifactView = controller.pause;
        stack.reloadArtifactView = () => webView?.reload();
        stack.connect('unrealize', () => {
            controller.pause();
            removeActiveController(controller);
        });

        if (options.autoActivate !== false)
            activate();

        return stack;
    }

    createWorkspaceView(_manager, resolved, options = {}) {
        const webView = this._runtime.createWebView(resolved, {
            onExternalLink: options.onExternalLink,
            onTerminated: options.onTerminated,
        });

        webView.reloadArtifactView = () => webView.reload();
        return webView;
    }
}
