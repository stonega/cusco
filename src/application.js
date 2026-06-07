import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio?version=2.0';
import GObject from 'gi://GObject?version=2.0';

import { CuscoWindow } from './window.js';

export const APP_ID = 'io.github.stonega.Cusco';

export const CuscoApplication = GObject.registerClass(
class CuscoApplication extends Adw.Application {
    _init() {
        super._init({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
    }

    vfunc_startup() {
        super.vfunc_startup();
        this._installActions();
    }

    vfunc_activate() {
        let window = this.active_window;

        if (!window)
            window = new CuscoWindow(this);

        window.present();
    }

    _installActions() {
        const quitAction = new Gio.SimpleAction({ name: 'quit' });
        quitAction.connect('activate', () => this.quit());
        this.add_action(quitAction);
        this.set_accels_for_action('app.quit', ['<primary>q']);
    }
});
