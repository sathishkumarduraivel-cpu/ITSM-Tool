// OAuth 2.0 Authorization Code flow against Google and Microsoft (Entra ID).
// Deliberately does NOT verify the id_token's JWT signature (which would
// need a JWKS-fetching library) -- instead it calls the provider's own
// userinfo endpoint with the access_token this server obtained directly
// from their token endpoint (server-to-server, over HTTPS, using our own
// client_secret). That access token could only have come from a real,
// successful code exchange with the provider, so the profile it returns is
// exactly as trustworthy as a verified id_token would be, without adding a
// new dependency -- consistent with this project's zero-native-deps
// philosophy (see services/crypto.js's own comment on the same principle).
import fetch from 'node-fetch';

export const PROVIDERS = {
  google: {
    label: 'Google',
    scope: 'openid email profile',
    authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    extraAuthParams: () => ({ access_type: 'online', prompt: 'select_account' }),
    async fetchProfile(accessToken) {
      const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error_description || 'Could not read your Google profile.');
      if (!data.email) throw new Error('Google did not return an email address.');
      return { email: data.email, name: data.name || data.email, providerUserId: data.sub };
    },
  },
  microsoft: {
    label: 'Microsoft',
    scope: 'openid email profile User.Read',
    authUrl: (sso) => `https://login.microsoftonline.com/${sso.tenant_id || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: (sso) => `https://login.microsoftonline.com/${sso.tenant_id || 'common'}/oauth2/v2.0/token`,
    extraAuthParams: () => ({ prompt: 'select_account' }),
    async fetchProfile(accessToken) {
      const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error?.message || 'Could not read your Microsoft profile.');
      const email = data.mail || data.userPrincipalName;
      if (!email) throw new Error('Microsoft did not return an email address.');
      return { email, name: data.displayName || email, providerUserId: data.id };
    },
  },
};

export async function exchangeCode(sso, code, redirectUri) {
  const meta = PROVIDERS[sso.provider];
  if (!meta) throw new Error(`Unknown SSO provider: ${sso.provider}`);
  const resp = await fetch(meta.tokenUrl(sso), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: sso.client_id,
      client_secret: sso.client_secret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error_description || data?.error || 'Sign-in with this provider failed.');
  return data.access_token;
}
