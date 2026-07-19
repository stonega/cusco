function actorIsVisible(actor) {
    if (typeof actor?.get_visible === 'function')
        return Boolean(actor.get_visible());

    return Boolean(actor?.visible);
}

function setActorVisible(actor, visible) {
    if (!actor)
        return;

    if (visible)
        actor.show();
    else
        actor.hide();
}

export class EmergencyStopController {
    constructor(indicator, {
        display,
        keyBindingFlags = 0,
        keyBindingNone = 0,
        onStop = () => {},
        onError = () => {},
    } = {}) {
        if (!indicator)
            throw new TypeError('An emergency-stop indicator is required.');
        if (!display)
            throw new TypeError('A Mutter display is required.');

        this._indicator = indicator;
        this._container = indicator.container ?? indicator;
        this._display = display;
        this._keyBindingFlags = keyBindingFlags;
        this._keyBindingNone = keyBindingNone;
        this._onStop = onStop;
        this._onError = onError;
        this._active = false;
        this._escapeActionId = keyBindingNone;
        this._displacedActors = [];
        this._acceleratorSignalId = display.connect(
            'accelerator-activated',
            (_display, actionId) => this._onAcceleratorActivated(actionId),
        );

        setActorVisible(this._indicator, false);
        if (this._container !== this._indicator)
            setActorVisible(this._container, false);
    }

    get active() {
        return this._active;
    }

    _reportError(error) {
        try {
            this._onError(error);
        } catch (_reportingError) {
            // Do not let error reporting break the emergency-stop lifecycle.
        }
    }

    _replaceCenterContent() {
        if (this._displacedActors.length > 0)
            return;

        try {
            const parent = this._container.get_parent?.();
            const siblings = parent?.get_children?.() ?? [];

            for (const actor of siblings) {
                if (actor === this._container)
                    continue;

                this._displacedActors.push({
                    actor,
                    visible: actorIsVisible(actor),
                });
                setActorVisible(actor, false);
            }
        } catch (error) {
            this._reportError(error);
        }
    }

    _restoreCenterContent() {
        const displacedActors = this._displacedActors;
        this._displacedActors = [];

        for (const {actor, visible} of displacedActors) {
            try {
                setActorVisible(actor, visible);
            } catch (error) {
                // Another extension may have destroyed a center actor while hidden.
                this._reportError(error);
            }
        }
    }

    _grabEscape() {
        if (this._escapeActionId !== this._keyBindingNone)
            return;

        try {
            this._escapeActionId = this._display.grab_accelerator(
                'Escape',
                this._keyBindingFlags,
            );

            if (this._escapeActionId === this._keyBindingNone) {
                this._reportError(new Error(
                    'GNOME Shell could not reserve Escape for the active computer-use stop control.',
                ));
            }
        } catch (error) {
            this._escapeActionId = this._keyBindingNone;
            this._reportError(error);
        }
    }

    _ungrabEscape() {
        if (this._escapeActionId === this._keyBindingNone)
            return;

        const actionId = this._escapeActionId;
        this._escapeActionId = this._keyBindingNone;

        try {
            this._display.ungrab_accelerator(actionId);
        } catch (error) {
            this._reportError(error);
        }
    }

    _onAcceleratorActivated(actionId) {
        if (!this._active || actionId !== this._escapeActionId)
            return;

        try {
            this._onStop();
        } catch (error) {
            this._reportError(error);
        }
    }

    setActive(active) {
        const nextActive = Boolean(active);

        if (nextActive === this._active)
            return false;

        this._active = nextActive;

        if (nextActive) {
            this._replaceCenterContent();
            setActorVisible(this._container, true);
            if (this._container !== this._indicator)
                setActorVisible(this._indicator, true);
            this._grabEscape();
        } else {
            this._ungrabEscape();
            setActorVisible(this._indicator, false);
            if (this._container !== this._indicator)
                setActorVisible(this._container, false);
            this._restoreCenterContent();
        }

        return true;
    }

    destroy() {
        this.setActive(false);

        if (this._acceleratorSignalId) {
            this._display.disconnect(this._acceleratorSignalId);
            this._acceleratorSignalId = 0;
        }

        this._indicator = null;
        this._container = null;
        this._display = null;
        this._onStop = () => {};
    }
}
