export function activateWindowIfNeeded(window, focusedWindow, timestamp) {
    if (!window)
        return false;

    const wasMinimized = Boolean(window.minimized);
    const needsActivation = wasMinimized || focusedWindow !== window;

    if (!needsActivation)
        return false;

    if (wasMinimized)
        window.unminimize();
    window.activate(timestamp);
    return true;
}
