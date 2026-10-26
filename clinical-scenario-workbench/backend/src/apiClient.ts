/**
 * Session-cookie-holding HTTP client for the onEHR Forms API. Deliberately
 * mirrors packages/mcp-server/src/apiClient.ts's login/cookie/retry-once
 * pattern (copied+adapted, not imported - this project stays decoupled from
 * the main repo's workspace graph on purpose, see README.md - the same
 * approach vital-signs-generator/backend/src/formsApiClient.ts already
 * takes). No API-key mechanism exists anywhere in Forms; every client, human
 * or machine, authenticates the same way a browser session would.
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

export type FetchLike = typeof fetch;

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
