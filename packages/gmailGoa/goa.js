import Goa from 'gi://Goa?version=1.0';

function userVisibleError(message, userMessage = message) {
    const error = new Error(message);
    error.userMessage = userMessage;
    return error;
}

function proxyProperty(proxy, name) {
    if (!proxy)
        return undefined;

    if (proxy[name] !== undefined)
        return proxy[name];

    const camelName = name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());

    if (proxy[camelName] !== undefined)
        return proxy[camelName];

    const getter = proxy[`get_${name}`];
    return typeof getter === 'function' ? getter.call(proxy) : undefined;
}

function createGoaClient(cancellable = null) {
    return new Promise((resolve, reject) => {
        Goa.Client.new(cancellable, (_source, result) => {
            try {
                resolve(Goa.Client.new_finish(result));
            } catch (error) {
                reject(userVisibleError(
                    `Could not connect to GNOME Online Accounts: ${error.message}`,
                    'GNOME Online Accounts is unavailable. Open Settings → Online Accounts and try again.',
                ));
            }
        });
    });
}

function ensureCredentials(account, cancellable = null) {
    return new Promise((resolve, reject) => {
        account.call_ensure_credentials(cancellable, (proxy, result) => {
            try {
                resolve(proxy.call_ensure_credentials_finish(result));
            } catch (error) {
                reject(userVisibleError(
                    `GNOME Online Accounts could not refresh Google credentials: ${error.message}`,
                    'Your Google account needs attention. Reconnect it in Settings → Online Accounts.',
                ));
            }
        });
    });
}

export function extractGoaAccessToken(finished) {
    const values = Array.isArray(finished) ? finished : [finished];

    if (values[0] === false)
        throw new Error('GNOME Online Accounts reported that token retrieval failed.');

    const token = values.find((value) => (
        typeof value === 'string' && value.trim().length > 0
    ));

    if (!token)
        throw new Error('GNOME Online Accounts returned an empty access token.');

    return token.trim();
}

function getOAuth2AccessToken(oauth2, cancellable = null) {
    return new Promise((resolve, reject) => {
        oauth2.call_get_access_token(cancellable, (proxy, result) => {
            try {
                const finished = proxy.call_get_access_token_finish(result);
                resolve(extractGoaAccessToken(finished));
            } catch (error) {
                reject(userVisibleError(
                    `GNOME Online Accounts could not provide a Google access token: ${error.message}`,
                    'Your Google account needs attention. Reconnect it in Settings → Online Accounts.',
                ));
            }
        });
    });
}

function accountRecord(object) {
    const account = object?.get_account?.();
    const mail = object?.get_mail?.();
    const oauth2 = object?.get_oauth2_based?.();

    if (!account || !mail || !oauth2)
        return null;

    const providerType = String(proxyProperty(account, 'provider_type') ?? '').trim();
    const providerName = String(proxyProperty(account, 'provider_name') ?? '').trim();

    if (providerType.toLowerCase() !== 'google'
        && providerName.toLowerCase() !== 'google') {
        return null;
    }

    const id = String(proxyProperty(account, 'id') ?? '').trim();
    const presentationIdentity = String(
        proxyProperty(account, 'presentation_identity') ?? '',
    ).trim();
    const emailAddress = String(
        proxyProperty(mail, 'email_address') ?? presentationIdentity,
    ).trim();
    const imapSupported = Boolean(proxyProperty(mail, 'imap_supported'));
    const imapHost = String(proxyProperty(mail, 'imap_host') ?? '').trim();
    const imapUserName = String(
        proxyProperty(mail, 'imap_user_name') ?? emailAddress ?? presentationIdentity,
    ).trim();

    if (!id || !imapSupported || !imapHost)
        return null;

    return {
        id,
        providerType: providerType || 'google',
        providerName: providerName || 'Google',
        presentationIdentity: presentationIdentity || emailAddress,
        emailAddress: emailAddress || presentationIdentity,
        imapHost,
        imapUserName: imapUserName || emailAddress || presentationIdentity,
        imapUseSsl: Boolean(proxyProperty(mail, 'imap_use_ssl')),
        imapUseTls: Boolean(proxyProperty(mail, 'imap_use_tls')),
        object,
    };
}

export class GoaGoogleAccountProvider {
    constructor(options = {}) {
        this._clientFactory = options.clientFactory ?? createGoaClient;
        this._client = null;
    }

    async listAccounts({ cancellable = null } = {}) {
        this._client = await this._clientFactory(cancellable);
        return (this._client.get_accounts?.() ?? [])
            .map(accountRecord)
            .filter(Boolean);
    }

    async getAccessToken(accountRecordValue, { cancellable = null } = {}) {
        const object = accountRecordValue?.object;
        const account = object?.get_account?.();
        const oauth2 = object?.get_oauth2_based?.();

        if (!account || !oauth2) {
            throw userVisibleError(
                'The selected GNOME Online Account no longer exposes Google OAuth.',
                'The selected Google account is no longer available. Reconnect Gmail.',
            );
        }

        await ensureCredentials(account, cancellable);
        return await getOAuth2AccessToken(oauth2, cancellable);
    }

    dispose() {
        this._client = null;
    }
}
