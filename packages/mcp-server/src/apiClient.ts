/**
 * Thin bridge to the Forms REST API - no business logic lives here. Every
 * tool in this server is a call to an endpoint apps/api already exposes and
 * already validates; this just handles authentication (a session cookie,
 * like the browser would hold) and JSON request/response plumbing so tool
 * handlers stay one-liners.
 */

export interface FormbuilderApiConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export class FormbuilderApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

export function loadConfigFromEnv(): FormbuilderApiConfig {
  const baseUrl = (process.env.FORMBUILDER_API_URL || 'http://localhost:3001').replace(/\/$/, '');
  // Reuses the same admin bootstrap credentials Forms already documents (see
  // docs/authentication.md) instead of inventing a second credential source
  // just for this server.
  const username = process.env.FORMBUILDER_MCP_USERNAME || process.env.FORMS_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.FORMBUILDER_MCP_PASSWORD || process.env.FORMS_BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Missing Forms credentials: set FORMBUILDER_MCP_USERNAME/FORMBUILDER_MCP_PASSWORD (or reuse '
      + 'FORMS_BOOTSTRAP_ADMIN_USERNAME/FORMS_BOOTSTRAP_ADMIN_PASSWORD) in the environment this server runs with.',
    );
  }
  return { baseUrl, username, password };
}

export type FetchLike = typeof fetch;

/** Session-cookie-holding HTTP client for the Forms API. Logs in lazily on
 * first use and re-authenticates once, transparently, if the session has
 * expired - callers never need to think about the login step. `fetchImpl`
 * defaults to the global fetch; tests inject a stub instead of needing a
 * real running API. */
export class FormbuilderApiClient {
  private cookie: string | undefined;
  private loginPromise: Promise<void> | undefined;

  constructor(private readonly config: FormbuilderApiConfig, private readonly fetchImpl: FetchLike = fetch) {}

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
      throw new FormbuilderApiError(response.status, `Forms login failed for user "${this.config.username}"`, body);
    }
    // fetch's Headers only exposes one combined Set-Cookie value; that's fine
    // here since Forms only ever sets the one session cookie on login.
    this.cookie = setCookie.split(';')[0];
  }

  /** Performs one request, retrying exactly once after a fresh login if the
   * session had expired (a 401) - so a long-running MCP server doesn't need
   * the caller to notice/handle that itself. */
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
      const message = parsed?.error || parsed?.message || `${method} ${path} failed with HTTP ${response.status}`;
      throw new FormbuilderApiError(response.status, message, parsed);
    }
    return parsed as T;
  }

  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.request<T>('POST', path, body ?? {}); }
  put<T>(path: string, body: unknown): Promise<T> { return this.request<T>('PUT', path, body); }
  patch<T>(path: string, body: unknown): Promise<T> { return this.request<T>('PATCH', path, body); }
  delete<T>(path: string): Promise<T> { return this.request<T>('DELETE', path); }
}
