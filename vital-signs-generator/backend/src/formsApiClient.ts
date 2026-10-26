/**
 * Session-cookie-holding HTTP client for the onEHR Forms API. Deliberately
 * mirrors packages/mcp-server/src/apiClient.ts's login/cookie/retry-once
 * pattern (copied+adapted, not imported - this project stays decoupled
 * from the main repo's workspace graph on purpose, see README.md).
 */

export interface FormsApiConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export class FormsApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

export function loadFormsApiConfigFromEnv(): FormsApiConfig {
  const baseUrl = (process.env.FORMS_API_URL || 'http://localhost:3001').replace(/\/$/, '');
  const username = process.env.FORMS_USERNAME;
  const password = process.env.FORMS_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing Forms credentials: set FORMS_USERNAME/FORMS_PASSWORD in the environment this backend runs with.');
  }
  return { baseUrl, username, password };
}

export type FetchLike = typeof fetch;

/** Logs in lazily on first use and re-authenticates once, transparently,
 * if the session has expired - callers never need to think about the
 * login step. `fetchImpl` defaults to the global fetch; tests inject a
 * stub instead of needing a real running API. */
export class FormsApiClient {
  private cookie: string | undefined;
  private loginPromise: Promise<void> | undefined;

  constructor(private readonly config: FormsApiConfig, private readonly fetchImpl: FetchLike = fetch) {}

  private async ensureSession(): Promise<void> {
    if (this.cookie) return;
    if (!this.loginPromise) this.loginPromise = this.login();
    await this.loginPromise;
  }

  private async login(): Promise<void> {
    const response = await this.fetchImpl(`${this.config.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.config.username, password: this.config.password }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (!response.ok || !setCookie) {
      const body = await response.json().catch(() => undefined);
      throw new FormsApiError(response.status, `Forms login failed for user "${this.config.username}"`, body);
    }
    this.cookie = setCookie.split(';')[0];
  }

  /** Performs one request, retrying exactly once after a fresh login if the
   * session had expired (a 401). */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureSession();
    const attempt = async (): Promise<Response> => this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    let response = await attempt();
    if (response.status === 401) {
      this.cookie = undefined;
      this.loginPromise = undefined;
      await this.ensureSession();
      response = await attempt();
    }

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const message = (parsed as { error?: string; message?: string } | undefined)?.error
        || (parsed as { error?: string; message?: string } | undefined)?.message
        || `${method} ${path} failed with HTTP ${response.status}`;
      throw new FormsApiError(response.status, message, parsed);
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.request<T>('POST', path, body ?? {}); }
  put<T>(path: string, body: unknown): Promise<T> { return this.request<T>('PUT', path, body); }
  patch<T>(path: string, body: unknown): Promise<T> { return this.request<T>('PATCH', path, body); }
}
