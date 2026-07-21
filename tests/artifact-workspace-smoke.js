import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';

import { ArtifactManager } from '../src/artifacts/manager.js';
import { createDefaultArtifactRendererRegistry } from '../src/artifacts/renderers/registry.js';
import { createArtifactWorkspace } from '../src/artifacts/views/workspace.js';
import { ArtifactFileStore } from '../src/storage/artifactStore.js';

if (Gtk.init_check()) {
    Adw.init();
    const root = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `cusco-artifact-workspace-${GLib.uuid_string_random()}`,
    ]);
    const manager = new ArtifactManager({ store: new ArtifactFileStore({ root }) });
    const created = manager.createArtifact({
        title: 'Workspace smoke',
        kind: 'html',
        content: '<!doctype html><html><body><h1>Artifact loaded</h1><script>document.documentElement.dataset.cusco = "ready";</script></body></html>',
        filename: 'index.html',
        entrypoint: 'index.html',
        preferredPresentation: 'panel',
    }, {
        originConversationId: 'conversation-1',
    });
    const registry = createDefaultArtifactRendererRegistry(manager);
    const chart = manager.createArtifact({
        title: 'Chart smoke',
        kind: 'chart',
        content: JSON.stringify({
            type: 'bar',
            labels: ['One', 'Two'],
            series: [{ name: 'Value', values: [1, 2] }],
        }),
        filename: 'chart.json',
        entrypoint: 'chart.json',
        preferredPresentation: 'inline',
    }, {
        originConversationId: 'conversation-1',
    });
    const chartView = registry.createInlineView(chart.reference);

    if (!chartView)
        throw new Error('Typed chart artifact did not produce an inline view');

    const markdownDocument = manager.createArtifact({
        title: 'Markdown document',
        kind: 'document',
        format: 'markdown',
        content: [
            '| Task | Owner |',
            '| --- | --- |',
            '| Preview tables | Cusco |',
            '',
            '- [ ] Pending task',
            '- [x] Completed task',
        ].join('\n'),
        filename: 'document.md',
        entrypoint: 'document.md',
        preferredPresentation: 'inline',
    }, {
        originConversationId: 'conversation-1',
    });
    const markdownView = registry.createInlineView(markdownDocument.reference);
    const descendantWidgets = (widget) => {
        const widgets = [widget];

        for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling())
            widgets.push(...descendantWidgets(child));

        return widgets;
    };
    const markdownWidgets = descendantWidgets(markdownView);

    if (!markdownWidgets.some((widget) => widget.has_css_class?.('cusco-markdown-table')))
        throw new Error('Markdown artifact preview did not render its table');

    const markdownPreviewText = markdownWidgets
        .filter((widget) => widget instanceof Gtk.Label)
        .map((label) => label.get_text())
        .join('\n');

    if (!markdownPreviewText.includes('☐ Pending task')
        || !markdownPreviewText.includes('☑ Completed task')) {
        throw new Error(`Markdown artifact preview did not render task markers: ${markdownPreviewText}`);
    }

    const workspace = createArtifactWorkspace({
        artifactManager: manager,
        artifactRegistry: registry,
    });

    workspace.setConversation('conversation-1');

    if (!workspace.openReference(created.reference))
        throw new Error('Artifact workspace rejected a valid reference');

    if (workspace.getActiveReference()?.revisionId !== created.revision.id)
        throw new Error('Artifact workspace did not retain its active revision');

    const splitView = new Adw.OverlaySplitView({
        content: chartView,
        sidebar: workspace,
        sidebar_position: Gtk.PackType.END,
        show_sidebar: true,
        pin_sidebar: true,
    });
    splitView.set_min_sidebar_width(360);
    splitView.set_max_sidebar_width(680);
    splitView.set_sidebar_width_fraction(0.38);
    const findWebView = (widget) => {
        if (widget instanceof WebKit.WebView)
            return widget;

        for (let child = widget.get_first_child?.(); child; child = child.get_next_sibling()) {
            const found = findWebView(child);

            if (found)
                return found;
        }

        return null;
    };
    const webView = findWebView(workspace);

    if (!webView)
        throw new Error('Artifact workspace did not create its WebKit preview');

    const window = new Gtk.Window({
        child: splitView,
        default_width: 640,
        default_height: 480,
    });
    const loop = new GLib.MainLoop(null, false);
    let loaded = false;
    let scriptRan = false;
    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    webView.connect('load-changed', (_view, event) => {
        if (event !== WebKit.LoadEvent.FINISHED)
            return;

        loaded = true;
        webView.evaluate_javascript(
            'document.documentElement.dataset.cusco',
            -1,
            null,
            null,
            null,
            (view, result) => {
                try {
                    scriptRan = view.evaluate_javascript_finish(result).to_string() === 'ready';
                } finally {
                    loop.quit();
                }
            },
        );
    });
    window.present();
    loop.run();

    if (timeoutId)
        GLib.source_remove(timeoutId);

    if (!loaded)
        throw new Error('Sandboxed artifact WebKit view did not finish loading');

    if (!scriptRan)
        throw new Error('Artifact script capability did not execute inside the sandbox');

    if (!webView.get_uri()?.startsWith('cusco-artifact://'))
        throw new Error(`Artifact loaded from an unsafe URI: ${webView.get_uri()}`);

    if (webView.get_settings().get_javascript_can_access_clipboard())
        throw new Error('Artifact JavaScript received clipboard access');

    const noScriptArtifact = manager.createArtifact({
        title: 'Static HTML',
        kind: 'html',
        content: '<!doctype html><html><body>Static</body></html>',
        filename: 'index.html',
        entrypoint: 'index.html',
        capabilities: [],
    });
    const noScriptView = registry.createWorkspaceView(noScriptArtifact.reference);

    if (noScriptView.get_settings().get_enable_javascript())
        throw new Error('Static HTML artifact unexpectedly received script execution');

    noScriptView.disposeArtifactView();

    window.destroy();
    print('Cusco artifact workspace smoke passed');
} else {
    print('Cusco artifact workspace smoke skipped (no display)');
}
