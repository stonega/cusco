# Provider authentication

OpenAI, Anthropic, Google Gemini, and Grok can offer more than one way to
authenticate chat requests. Open **Settings → Providers**, expand a provider,
and choose an option under **Authentication**.

## API key

API key is the default. Enter the key in Settings to store it in the desktop
Secret Service, or set the environment variable shown beside the field. This
continues to use the provider's developer API and is also required for image
generation.

## Account connection

The additional choices open the provider's sign-in page and store the returned
OAuth tokens in Secret Service. Cusco does not read logins, cookies, or token
files from Codex, Claude Code, Gemini CLI, Grok CLI, or another application.

- **ChatGPT subscription** is available under OpenAI.
- **Claude subscription** is available under Anthropic. After approval, copy
  the code shown by the provider back into Cusco.
- **Google OAuth** is available under Google Gemini when the Cusco package has
  been configured with its own Google desktop OAuth client.
- **Grok subscription** is available under Grok.

> **Claude Code OAuth risk:** Claude subscription authentication is an
> unofficial compatibility path. Anthropic may classify its traffic as extra
> usage instead of usage included with a Claude plan, and may change or block
> the flow without notice. Check your Anthropic account usage after connecting.

Consumer subscription access is separate from developer API billing and can
depend on your plan and the provider's terms. The ChatGPT, Claude, and Grok
compatibility endpoints can also change without notice. If a connection stops
working, reconnect it in Settings or switch back to API key.

Changing the selected method keeps the other credential so you can switch
back. Select **Disconnect** to remove the selected account token. OAuth account
connections authenticate chat only; image generation still needs an API key.

For a source build, Google OAuth requires
`CUSCO_GEMINI_OAUTH_CLIENT_ID`. Set
`CUSCO_GEMINI_OAUTH_CLIENT_SECRET` too when the registered desktop client
requires it.
