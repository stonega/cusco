import {
    FallbackArtifactRenderer,
    NativeChartArtifactRenderer,
    NativeDataArtifactRenderer,
    NativeDocumentArtifactRenderer,
    NativeImageArtifactRenderer,
    NativePdfArtifactRenderer,
    NativeSourceArtifactRenderer,
} from './native.js';
import { WebArtifactRenderer } from './web.js';

export class ArtifactRendererRegistry {
    constructor(artifactManager) {
        this._artifacts = artifactManager;
        this._renderers = [];
    }

    register(renderer, options = {}) {
        if (!renderer || typeof renderer.supports !== 'function')
            throw new Error('Artifact renderer must provide a supports function.');

        if (options.prepend)
            this._renderers.unshift(renderer);
        else
            this._renderers.push(renderer);

        return renderer;
    }

    unregister(renderer) {
        const index = this._renderers.indexOf(renderer);

        if (index >= 0)
            this._renderers.splice(index, 1);
    }

    resolve(referenceOrResolved) {
        if (referenceOrResolved?.artifact && referenceOrResolved?.revision)
            return referenceOrResolved;

        return this._artifacts.resolveReference(referenceOrResolved);
    }

    rendererFor(referenceOrResolved) {
        const resolved = this.resolve(referenceOrResolved);

        if (!resolved)
            return { resolved: null, renderer: null };

        return {
            resolved,
            renderer: this._renderers.find((renderer) => renderer.supports(resolved)) ?? null,
        };
    }

    createInlineView(referenceOrResolved, options = {}) {
        const { resolved, renderer } = this.rendererFor(referenceOrResolved);

        return renderer?.createInlineView?.(this._artifacts, resolved, options) ?? null;
    }

    createWorkspaceView(referenceOrResolved, options = {}) {
        const { resolved, renderer } = this.rendererFor(referenceOrResolved);

        return renderer?.createWorkspaceView?.(this._artifacts, resolved, options) ?? null;
    }
}

export function createDefaultArtifactRendererRegistry(artifactManager, options = {}) {
    const registry = new ArtifactRendererRegistry(artifactManager);

    registry.register(new NativeImageArtifactRenderer());
    registry.register(new WebArtifactRenderer(artifactManager, options.web));
    registry.register(new NativeChartArtifactRenderer());
    registry.register(new NativeDataArtifactRenderer());
    registry.register(new NativeDocumentArtifactRenderer());
    registry.register(new NativeSourceArtifactRenderer());
    registry.register(new NativePdfArtifactRenderer());
    registry.register(new FallbackArtifactRenderer());
    return registry;
}
