import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, readJson } from './state.mjs';
import { loopbackRequest } from './http.mjs';

const REDIRECT_URI = 'http://127.0.0.1/team-devspace-oauth-callback';

export class LocalOAuth {
  constructor(state, home) {
    this.state = state;
    this.resource = new URL('/mcp', state.gateway).href;
    this.path = join(home, 'local-oauth.json');
  }

  async token() {
    if (this.credentials?.expiresAt > Date.now() + 60000) return this.credentials.accessToken;
    // Reuse one grant/refresh for concurrent MCP sessions, not a session lock.
    this.pending ??= this.obtain().finally(() => { this.pending = null; });
    return this.pending;
  }

  async obtain() {
    this.credentials ??= await readJson(this.path, {});
    if (this.credentials.resource !== this.resource) this.credentials = {};
    if (this.credentials.expiresAt > Date.now() + 60000) return this.credentials.accessToken;
    if (this.credentials.refreshToken && this.credentials.clientId) {
      const response = await this.form('/token', {
        grant_type: 'refresh_token', client_id: this.credentials.clientId,
        refresh_token: this.credentials.refreshToken, resource: this.resource,
      });
      if (response.status === 200) return this.save(response, this.credentials.clientId);
      // Only rejected credentials justify a new owner grant. Network/server faults do not.
      if (![400, 401].includes(response.status)) throw new Error('Local OAuth refresh failed');
    }
    return this.grant();
  }

  async form(path, fields) {
    return loopbackRequest(this.state.ports.devspace, path, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  async grant() {
    const registered = await loopbackRequest(this.state.ports.devspace, '/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Team DevSpace local bridge',
        redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    if (registered.status !== 201 && registered.status !== 200) throw new Error('Local OAuth client registration failed');
    const clientId = JSON.parse(registered.text).client_id;
    if (typeof clientId !== 'string' || !clientId) throw new Error('Invalid local OAuth client');
    const verifier = randomBytes(32).toString('base64url');
    const expectedState = randomBytes(32).toString('base64url');
    const authorized = await this.form('/authorize', {
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI,
      scope: 'devspace', resource: this.resource, state: expectedState,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      owner_token: this.state.ownerToken,
    });
    if (authorized.status !== 302 || !authorized.headers.location) throw new Error('Local DevSpace owner authorization failed');
    const location = new URL(authorized.headers.location);
    const expected = new URL(REDIRECT_URI);
    if (location.origin !== expected.origin || location.pathname !== expected.pathname ||
        location.searchParams.get('state') !== expectedState || !location.searchParams.get('code')) {
      throw new Error('Invalid local OAuth callback');
    }
    const tokens = await this.form('/token', {
      grant_type: 'authorization_code', client_id: clientId, code: location.searchParams.get('code'),
      code_verifier: verifier, redirect_uri: REDIRECT_URI, resource: this.resource,
    });
    return this.save(tokens, clientId);
  }

  async save(response, clientId) {
    if (response.status !== 200) throw new Error('Local OAuth token exchange failed');
    const value = JSON.parse(response.text);
    if (typeof value.access_token !== 'string' || !value.access_token ||
        value.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
      throw new Error('Invalid local OAuth token response');
    }
    this.credentials = { resource: this.resource, clientId, accessToken: value.access_token,
      refreshToken: value.refresh_token, expiresAt: Date.now() + value.expires_in * 1000 };
    await atomicJson(this.path, this.credentials);
    return this.credentials.accessToken;
  }
}
