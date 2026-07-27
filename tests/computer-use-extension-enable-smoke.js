import GLib from 'gi://GLib?version=2.0';

import {
    COMPUTER_USE_PROTOCOL_VERSION,
    ComputerUseService,
} from '../src/computerUse/service.js';

function createProxy(loaded = true) {
    return {
        get_name_owner() {
            return ':fake-shell';
        },
        connect() {
            return 1;
        },
        disconnect() {},
        call(method, _parameters, _flags, _timeout, _cancellable, callback) {
            callback(this, { method });
        },
        call_finish(result) {
            if (!loaded && result.method === 'Register') {
                throw new Error(
                    'GDBus.Error:org.freedesktop.DBus.Error.UnknownObject: Object does not exist',
                );
            }

            if (result.method === 'Register' || result.method === 'GetStatus') {
                return new GLib.Variant('(s)', [JSON.stringify({
                    protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
                    registered: true,
                    shellVersion: '50',
                })]);
            }

            return new GLib.Variant('()', []);
        },
        call_sync() {
            return new GLib.Variant('()', []);
        },
    };
}

const settings = {
    computerUseEnabled: true,
    computerUseCaptureEnabled: true,
    computerUseInputEnabled: true,
    computerUseWorkspaceSwitchingEnabled: true,
    computerUseActionTimeoutSeconds: 30,
};
let enableCalls = 0;
const computerUse = new ComputerUseService({
    proxy: createProxy(),
    accessibility: null,
    environmentStatus: () => ({ supported: true, reason: '' }),
    enableShellExtension: async () => {
        enableCalls += 1;
    },
    settings,
});
const enabledStatus = await computerUse.setEnabled(true);

if (!enabledStatus.available || enableCalls !== 1)
    throw new Error('Enabling computer use did not enable the GNOME Shell extension');

await computerUse.setEnabled(false);
computerUse.shutdown();

const failedComputerUse = new ComputerUseService({
    proxy: createProxy(false),
    accessibility: null,
    environmentStatus: () => ({ supported: true, reason: '' }),
    enableShellExtension: async () => {
        throw new Error('Extension is not installed');
    },
    settings,
});
const failedStatus = await failedComputerUse.setEnabled(true);
const refreshedFailedStatus = await failedComputerUse.status();
failedComputerUse.shutdown();

if (failedStatus.available
    || !failedStatus.reason.includes('Extension is not installed')
    || !refreshedFailedStatus.reason.includes('Extension is not installed')) {
    throw new Error('Computer use did not report an automatic extension enable failure');
}

const unsupportedComputerUse = new ComputerUseService({
    accessibility: null,
    environmentStatus: () => ({
        supported: false,
        reason: 'Computer use requires a Wayland session.',
    }),
    enableShellExtension: async () => {
        enableCalls += 1;
    },
    settings,
});
const unsupportedStatus = await unsupportedComputerUse.setEnabled(true);
unsupportedComputerUse.shutdown();

if (unsupportedStatus.supported || enableCalls !== 1)
    throw new Error('Computer use tried to enable the extension on an unsupported desktop');

print('Cusco computer-use extension enable smoke passed');
