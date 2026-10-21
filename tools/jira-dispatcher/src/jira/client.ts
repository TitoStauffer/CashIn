import type { JiraCredentials } from "../env.js";
import { sleep } from "../time.js";
import { textToAdf } from "./adf.js";

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory?: { key: string; name?: string };
}

export interface JiraIssueLink {
  type: { name: string; inward?: string; outward?: string };
  inwardIssue?: { key: string; fields?: { status?: JiraStatus } };
  outwardIssue?: { key: string; fields?: { status?: JiraStatus } };
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    status?: JiraStatus;
    summary?: string;
    project?: { key?: string };
    issuetype?: { name?: string };
    issuelinks?: JiraIssueLink[];
  };
}

export interface JiraComment {
  id: string;
  body: unknown;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
}

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string };
}

export interface JiraLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

/** Operations the dispatcher needs from Jira. Kept small so tests can provide a fake. */
export interface JiraApi {
  myself(): Promise<{ accountId: string; displayName?: string }>;
  searchIssues(jql: string, fields: string[], maxResults: number): Promise<JiraIssue[]>;
  getIssue(key: string, fields: string[]): Promise<JiraIssue>;
  getTransitions(key: string): Promise<JiraTransition[]>;
  transitionIssue(key: string, transitionId: string): Promise<void>;
  addComment(key: string, text: string): Promise<void>;
  listComments(key: string): Promise<JiraComment[]>;
  setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void>;
  getIssueProperty(key: string, propertyKey: string): Promise<unknown | undefined>;
  listFields(): Promise<JiraField[]>;
  listLinkTypes(): Promise<JiraLinkType[]>;
}

export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string
  ) {
    super(`Jira ${method} ${path} respondeu ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "JiraHttpError";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface JiraClientOptions {
  baseUrl: string;
  credentials: JiraCredentials;
  fetch?: typeof fetch;
  /** Retries for idempotent reads on 429/5xx/network errors. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Jira Cloud REST v3 client. Credentials are only used to build the Authorization header
 * and never appear in error messages.
 */
export class JiraClient implements JiraApi {
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: JiraClientOptions) {
    const { email, apiToken } = options.credentials;
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  myself() {
    return this.request<{ accountId: string; displayName?: string }>("GET", "/rest/api/3/myself");
  }

  async searchIssues(jql: string, fields: string[], maxResults: number): Promise<JiraIssue[]> {
    // POST /search/jql is idempotent (read only), so it is safe to retry.
    const result = await this.request<{ issues?: JiraIssue[] }>(
      "POST",
      "/rest/api/3/search/jql",
      { jql, fields, maxResults },
      { retry: true }
    );
    return result.issues ?? [];
  }

  getIssue(key: string, fields: string[]) {
    const query = new URLSearchParams({ fields: fields.join(",") });
    return this.request<JiraIssue>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?${query}`);
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions?: JiraTransition[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`
    );
    return result.transitions ?? [];
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    // Never retried automatically: a repeated transition could move the issue twice.
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId }
    });
  }

  async addComment(key: string, text: string): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) });
  }

  async listComments(key: string): Promise<JiraComment[]> {
    const comments: JiraComment[] = [];
    for (let startAt = 0; startAt < 10_000; startAt += 100) {
      const query = new URLSearchParams({ startAt: String(startAt), maxResults: "100" });
      const result = await this.request<{ comments?: JiraComment[]; total?: number }>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?${query}`
      );
      const page = Array.isArray(result.comments) ? result.comments : [];
      comments.push(...page);
      if (page.length < 100 || (typeof result.total === "number" && comments.length >= result.total)) return comments;
    }
    throw new Error("Jira comment pagination exceeded the supported limit.");
  }

  async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
    await this.request(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`,
      value,
      { retry: true }
    );
  }

  async getIssueProperty(key: string, propertyKey: string): Promise<unknown | undefined> {
    try {
      const result = await this.request<{ value?: unknown }>(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`
      );
      return result.value;
    } catch (error) {
      if (error instanceof JiraHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  listFields() {
    return this.request<JiraField[]>("GET", "/rest/api/3/field");
  }

  listLinkTypes() {
    return this.request<{ issueLinkTypes: JiraLinkType[] }>("GET", "/rest/api/3/issueLinkType").then((r) => r.issueLinkTypes ?? []);
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    options: { retry?: boolean } = {}
  ): Promise<T> {
    const retry = options.retry ?? method === "GET";
    const maxRetries = retry ? this.options.maxRetries ?? 3 : 0;
    const baseDelay = this.options.retryBaseDelayMs ?? 1000;
    let attempt = 0;

    for (;;) {
      try {
        return await this.send<T>(method, path, body);
      } catch (error) {
        const retryable = error instanceof JiraHttpError ? error.retryable : !(error instanceof JiraHttpError);
        if (!retryable || attempt >= maxRetries) throw error;
        attempt += 1;
        await sleep(baseDelay * 2 ** (attempt - 1));
      }
    }
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
    });

    if (!response.ok) {
      throw new JiraHttpError(response.status, method, path.split("?")[0] ?? path, await safeErrorDetail(response));
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
    const messages = [...(data.errorMessages ?? []), ...Object.values(data.errors ?? {})];
    return messages.join("; ").slice(0, 500);
  } catch {
    return "";
  }
}

/** Status matching accepts either the status id or its (case-insensitive) name. */
export function statusMatches(status: JiraStatus | undefined, candidates: string[]): boolean {
  if (!status) return false;
  return candidates.some(
    (candidate) => candidate === status.id || candidate.trim().toLowerCase() === status.name.trim().toLowerCase()
  );
}
