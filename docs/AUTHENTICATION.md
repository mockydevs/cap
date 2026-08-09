# Authentication configuration

Cap supports password authentication and Google OpenID Connect. Google accounts are linked by the immutable Google `sub` claim; a first login with a Google-verified email can attach to the existing Cap user with that normalized email. Provider access and refresh tokens are not stored.

## Google Cloud configuration

Create one OAuth client of type **Web application** and one of type **Desktop app** in the same Google Cloud project. Configure the consent screen and authorized domain for each deployed Cap environment.

For the web client, register this exact redirect URI:

```text
https://YOUR_CAP_DOMAIN/api/auth/google/callback
```

Set these server-only variables in Coolify:

```text
GOOGLE_OAUTH_CLIENT_ID=web-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=web-client-secret
GOOGLE_DESKTOP_OAUTH_CLIENT_ID=desktop-client-id.apps.googleusercontent.com
```

`NEXT_PUBLIC_APP_URL` must use the same origin as the registered web redirect. Never expose `GOOGLE_OAUTH_CLIENT_SECRET` through a `NEXT_PUBLIC_` variable or desktop bundle.

The web flow uses Authorization Code, S256 PKCE, random state and nonce cookies, an exact server-derived redirect URI, and signature/issuer/audience/email verification. The native flow opens the system browser, listens on a random `127.0.0.1` loopback port, and uses a Desktop-type client with S256 PKCE, state, and nonce. Google passwords are never entered in Cap.
