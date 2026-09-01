import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(scriptDirectory, '..', '..', '..', '..', '.env'),
  override: false,
  quiet: true,
});

export class OnehrApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function apiConfigurationFromEnvironment() {
  const baseUrl = (process.env.ONEHR_API_URL || process.env.FORMBUILDER_API_URL || 'http://localhost:3001').replace(/\/$/, '');
  const username = process.env.ONEHR_USERNAME || process.env.FORMBUILDER_MCP_USERNAME || process.env.FORMS_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.ONEHR_PASSWORD || process.env.FORMBUILDER_MCP_PASSWORD || process.env.FORMS_BOOTSTRAP_ADMIN_PASSWORD;
  const cookie = process.env.ONEHR_SESSION_COOKIE;
  if (!cookie && (!username || !password)) {
    throw new Error('Set ONEHR_USERNAME/ONEHR_PASSWORD (or ONEHR_SESSION_COOKIE) for the target onEHR API');
  }
  return { baseUrl, username, password, cookie };
}

export class OnehrApiClient {
  constructor(configuration = apiConfigurationFromEnvironment()) {
    this.configuration = configuration;
    this.cookie = configuration.cookie;
  }

  async login() {
    if (this.cookie) return;
    const response = await fetch(`${this.configuration.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.configuration.username, password: this.configuration.password }),
    });
    const body = await readResponseBody(response);
    const setCookie = response.headers.get('set-cookie');
    if (!response.ok || !setCookie) {
      throw new OnehrApiError(response.status, body?.error || 'onEHR login failed', body);
    }
    this.cookie = setCookie.split(';')[0];
  }

  async request(method, apiPath, body, retry = true) {
    await this.login();
    const response = await fetch(`${this.configuration.baseUrl}${apiPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 && retry && !this.configuration.cookie) {
      this.cookie = undefined;
      await this.login();
      return this.request(method, apiPath, body, false);
    }
    const parsed = await readResponseBody(response);
    if (!response.ok) {
      throw new OnehrApiError(
        response.status,
        parsed?.error || parsed?.message || `${method} ${apiPath} failed with HTTP ${response.status}`,
        parsed,
      );
    }
    return parsed;
  }

  get(apiPath) { return this.request('GET', apiPath); }
  post(apiPath, body = {}) { return this.request('POST', apiPath, body); }
  put(apiPath, body) { return this.request('PUT', apiPath, body); }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text); }
  catch { return { message: text }; }
}
