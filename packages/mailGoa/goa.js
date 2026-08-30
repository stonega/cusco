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
                    `GNOME Online Accounts could not refresh mail credentials: ${error.message}`,
                    'Your mail account needs attention. Reconnect it in Settings → Online Accounts.',
                ));
            }
        });
    });
}

export function extractGoaCredential(finished) {
    const values = Array.isArray(finished) ? finished : [finished];

    if (values[0] === false)
        throw new Error('GNOME Online Accounts reported that credential retrieval failed.');

    const credential = values.find((value) => (
        typeof value === 'string' && value.length > 0
    ));

    if (!credential)
        throw new Error('GNOME Online Accounts returned an empty credential.');

    return credential;
}

function getOAuth2AccessToken(oauth2, cancellable = null) {
    return new Promise((resolve, reject) => {
        oauth2.call_get_access_token(cancellable, (proxy, result) => {
            try {
                resolve(extractGoaCredential(proxy.call_get_access_token_finish(result)));
            } catch (error) {
                reject(userVisibleError(
                    `GNOME Online Accounts could not provide a mail access token: ${error.message}`,
                    'Your mail account needs attention. Reconnect it in Settings → Online Accounts.',
                ));
            }
        });
    });
}

function getImapPassword(passwordBased, cancellable = null) {
    return new Promise((resolve, reject) => {
        passwordBased.call_get_password(
            'imap-password',
            cancellable,
            (proxy, result) => {
                try {
                    resolve(extractGoaCredential(proxy.call_get_password_finish(result)));
                } catch (error) {
                    reject(userVisibleError(
                        `GNOME Online Accounts could not provide the IMAP password: ${error.message}`,
                        'Your mail account needs attention. Reconnect it in Settings → Online Accounts.',
                    ));
                }
            },
        );
    });
}

function accountRecord(object, { includeGoogle = false } = {}) {
    const account = object?.get_account?.();
    const mail = object?.get_mail?.();
    const oauth2 = object?.get_oauth2_based?.();
    const passwordBased = object?.get_password_based?.();

    if (!account || !mail || (!oauth2 && !passwordBased))
        return null;

    const providerType = String(proxyProperty(account, 'provider_type') ?? '').trim();
    const providerName = String(proxyProperty(account, 'provider_name') ?? '').trim();
    const isGoogle = providerType.toLowerCase() === 'google'
        || providerName.toLowerCase() === 'google';

    if (isGoogle && !includeGoogle)
        return null;

    const id = String(proxyProperty(account, 'id') ?? '').trim();
    const presentationIdentity = String(
        proxyProperty(account, 'presentation_identity') ?? '',
    ).trim();
    const emailAddress = String(
        proxyProperty(mail, 'email_address') ?? presentationIdentity,
    ).trim();
    const imapHost = String(proxyProperty(mail, 'imap_host') ?? '').trim();
    const imapUserName = String(
        proxyProperty(mail, 'imap_user_name') ?? emailAddress ?? presentationIdentity,
    ).trim();
    const imapUseSsl = Boolean(proxyProperty(mail, 'imap_use_ssl'));
    const imapUseTls = Boolean(proxyProperty(mail, 'imap_use_tls'));

    if (!id
        || !Boolean(proxyProperty(mail, 'imap_supported'))
        || !imapHost
        || (!imapUseSsl && !imapUseTls)
        || Boolean(proxyProperty(mail, 'imap_accept_ssl_errors'))) {
        return null;
    }

    return {
        id,
        providerType,
        providerName: providerName || providerType || 'Mail',
        presentationIdentity: presentationIdentity || emailAddress,
        emailAddress: emailAddress || presentationIdentity,
        imapHost,
        imapUserName: imapUserName || emailAddress || presentationIdentity,
        imapUseSsl,
        imapUseTls,
        credentialType: oauth2 ? 'oauth2' : 'password',
        object,
    };
}

export class GoaMailAccountProvider {
    constructor(options = {}) {
        this._clientFactory = options.clientFactory ?? createGoaClient;
        this._includeGoogle = options.includeGoogle === true;
        this._client = null;
    }

    async listAccounts({ cancellable = null } = {}) {
        this._client = await this._clientFactory(cancellable);
        return (this._client.get_accounts?.() ?? [])
            .map((object) => accountRecord(object, { includeGoogle: this._includeGoogle }))
            .filter(Boolean);
    }

    async getCredential(accountRecordValue, { cancellable = null } = {}) {
        const object = accountRecordValue?.object;
        const account = object?.get_account?.();
        const oauth2 = object?.get_oauth2_based?.();
        const passwordBased = object?.get_password_based?.();

        if (!account || (!oauth2 && !passwordBased)) {
            throw userVisibleError(
                'The selected GNOME Online Account no longer exposes mail credentials.',
                'The selected mail account is no longer available. Reconnect Mail.',
            );
        }

        await ensureCredentials(account, cancellable);

        if (oauth2) {
            return {
                type: 'oauth2',
                secret: await getOAuth2AccessToken(oauth2, cancellable),
            };
        }

        return {
            type: 'password',
            secret: await getImapPassword(passwordBased, cancellable),
        };
    }

    dispose() {
        this._client = null;
    }
}
