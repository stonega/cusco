import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import { APP_ID } from './appInfo.js';
import { CuscoWindow } from './window.js';
import { installSearchProvider } from './searchProvider.js';

export { APP_ID };

export function automationIdFromArguments(args = []) {
    const values = Array.from(args, (value) => String(value ?? ''));
    const inline = values.find((value) => value.startsWith('--run-automation='));

    if (inline)
        return inline.slice('--run-automation='.length).trim();

    const index = values.indexOf('--run-automation');
    return index >= 0 ? String(values[index + 1] ?? '').trim() : '';
}

let applicationStylesInstalled = false;

function installApplicationStyles() {
    if (applicationStylesInstalled)
        return;

    const display = Gdk.Display.get_default();

    if (!display)
        return;

    const provider = new Gtk.CssProvider();

    for (const path of getStylesheetPaths()) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;

        provider.load_from_path(path);
        Gtk.StyleContext.add_provider_for_display(
            display,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
        applicationStylesInstalled = true;
        return;
    }
}

function getStylesheetPaths() {
    const modulePath = Gio.File.new_for_uri(import.meta.url).get_path();

    if (!modulePath)
        return [];

    const moduleDir = GLib.path_get_dirname(modulePath);

    return [
        GLib.build_filenamev([moduleDir, 'resources', 'style.css']),
        GLib.build_filenamev([moduleDir, '..', 'data', 'resources', 'style.css']),
    ];
}

export const CuscoApplication = GObject.registerClass(
class CuscoApplication extends Adw.Application {
    _init() {
        super._init({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
        });
    }

    vfunc_startup() {
        super.vfunc_startup();
        this._installActions();
        this._searchProvider = installSearchProvider(this);
    }

    vfunc_activate() {
        installApplicationStyles();

        let window = this.active_window;

        if (!window)
            window = new CuscoWindow(this);

        if (this._headlessAutomationWindow === window) {
            this._headlessAutomationWindow = null;

            if (this._automationHoldActive) {
                this._automationHoldActive = false;
                this.release();
            }
        }

        window.present();
    }

    vfunc_command_line(commandLine) {
        const args = commandLine.get_arguments();
        const automationId = automationIdFromArguments(args);

        if (automationId) {
            installApplicationStyles();
            let window = this.active_window;

            if (!window) {
                window = new CuscoWindow(this);
                this._headlessAutomationWindow = window;
                this._automationHoldActive = true;
                this.hold();
            }

            this._automationRunCount = (this._automationRunCount ?? 0) + 1;

            window.runAutomation(automationId).catch((error) => {
                logError(error, `Failed to run automation ${automationId}`);
            }).finally(() => {
                this._automationRunCount = Math.max(0, (this._automationRunCount ?? 1) - 1);

                if (this._automationRunCount > 0 || this._headlessAutomationWindow !== window)
                    return;

                this._headlessAutomationWindow = null;
                window.close();

                if (this._automationHoldActive) {
                    this._automationHoldActive = false;
                    this.release();
                }

                this.quit();
            });
            return 0;
        }

        this.activate();

        const window = this.active_window;

        if (args.includes('--new-chat'))
            window?.createNewConversation();

        if (args.includes('--quick-prompt'))
            window?.focusComposer();

        return 0;
    }

    _installActions() {
        const newChatAction = new Gio.SimpleAction({ name: 'new-chat' });
        newChatAction.connect('activate', () => this.active_window?.createNewConversation());
        this.add_action(newChatAction);
        this.set_accels_for_action('app.new-chat', ['<primary>n']);

        const preferencesAction = new Gio.SimpleAction({ name: 'preferences' });
        preferencesAction.connect('activate', () => this.active_window?.showSettings());
        this.add_action(preferencesAction);
        this.set_accels_for_action('app.preferences', ['<primary>comma']);

        const commandPaletteAction = new Gio.SimpleAction({ name: 'command-palette' });
        commandPaletteAction.connect('activate', () => this.active_window?.showCommandPalette());
        this.add_action(commandPaletteAction);
        this.set_accels_for_action('app.command-palette', ['<primary>k']);

        const focusComposerAction = new Gio.SimpleAction({ name: 'focus-composer' });
        focusComposerAction.connect('activate', () => this.active_window?.focusComposer());
        this.add_action(focusComposerAction);
        this.set_accels_for_action('app.focus-composer', ['<primary>l']);

        const quitAction = new Gio.SimpleAction({ name: 'quit' });
        quitAction.connect('activate', () => this.quit());
        this.add_action(quitAction);
        this.set_accels_for_action('app.quit', ['<primary>q']);
    }
});
