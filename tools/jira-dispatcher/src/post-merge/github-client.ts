const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface GitHubCheckRun {
  name: string;
  head_sha: string;
  app?: { slug?: string } | null;
  status: string;
  conclusion: string | null;
  started_at?: string;
  completed_at?: string | null;
}

export interface GitHubReview {
  user?: { login?: string };
  state: string;
  commit_id: string;
  submitted_at: string | null;
}

export interface GitHubIssueComment {
  user?: { login?: string };
  body: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GitHubReadApi {
  getPullRequest(owner: string, repository: string, number: number): Promise<GitHubPullRequest>;
  listCheckRuns(owner: string, repository: string, sha: string): Promise<GitHubCheckRun[]>;
  listReviews(owner: string, repository: string, number: number): Promise<GitHubReview[]>;
  listIssueComments(owner: string, repository: string, number: number): Promise<GitHubIssueComment[]>;
  listUnresolvedReviewThreads(owner: string, repository: string, number: number): Promise<number>;
}

export class GitHubReadError extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`GitHub ${operation} falhou com HTTP ${status}.`);
    this.name = "GitHubReadError";
  }
}

export class GitHubReadClient implements GitHubReadApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    if (!token.trim()) throw new Error("GITHUB_TOKEN não configurado.");
  }

  getPullRequest(owner: string, repository: string, number: number): Promise<GitHubPullRequest> {
    return this.request(`/repos/${pathPart(owner)}/${pathPart(repository)}/pulls/${number}`, "pull request");
  }

  async listCheckRuns(owner: string, repository: string, sha: string): Promise<GitHubCheckRun[]> {
    const response = await this.request<{ check_runs?: GitHubCheckRun[] }>(
      `/repos/${pathPart(owner)}/${pathPart(repository)}/commits/${pathPart(sha)}/check-runs?per_page=100`,
      "check runs",
    );
    return response.check_runs ?? [];
  }

  listReviews(owner: string, repository: string, number: number): Promise<GitHubReview[]> {
    return this.listPages(`/repos/${pathPart(owner)}/${pathPart(repository)}/pulls/${number}/reviews`, "pull request reviews");
  }

  listIssueComments(owner: string, repository: string, number: number): Promise<GitHubIssueComment[]> {
    return this.listPages(`/repos/${pathPart(owner)}/${pathPart(repository)}/issues/${number}/comments`, "pull request comments");
  }

  async listUnresolvedReviewThreads(owner: string, repository: string, number: number): Promise<number> {
    let after: string | null = null;
    let unresolvedCount = 0;
    for (let page = 0; page < 10; page += 1) {
      const result: GraphQlResponse = await this.request<GraphQlResponse>("/graphql", "review threads", {
        method: "POST",
        body: JSON.stringify({ query: REVIEW_THREADS_QUERY, variables: { owner, repository, number, after } }),
      });
      if (result.errors?.length) throw new Error("GitHub não retornou a lista de threads de revisão.");
      const threads: NonNullable<NonNullable<NonNullable<GraphQlResponse["data"]>["repository"]>["pullRequest"]>["reviewThreads"] = result.data?.repository?.pullRequest?.reviewThreads;
      if (!threads || !Array.isArray(threads.nodes)) throw new Error("GitHub retornou uma resposta inválida de threads.");
      unresolvedCount += threads.nodes.filter((thread) => thread.isResolved === false).length;
      if (!threads.pageInfo.hasNextPage) return unresolvedCount;
      after = threads.pageInfo.endCursor;
      if (!after) throw new Error("GitHub retornou um cursor de paginação inválido.");
    }
    throw new Error("GitHub review-thread pagination exceeded the supported limit.");
  }

  private async listPages<T>(path: string, operation: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.request<T[]>(`${path}?per_page=100&page=${page}`, operation);
      if (!Array.isArray(result)) throw new Error(`GitHub retornou uma resposta inválida para ${operation}.`);
      items.push(...result);
      if (result.length < 100) return items;
    }
    throw new Error(`GitHub ${operation} excedeu o limite de paginação suportado.`);
  }

  private async request<T>(path: string, operation: string, request: { method?: string; body?: string } = {}): Promise<T> {
    const method = request.method ?? "GET";
    const maxRetries = 3;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${API_BASE}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": API_VERSION,
            ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt >= maxRetries) throw new Error(`Falha de rede ao consultar ${operation}.`, { cause: error });
        await delay(500 * 2 ** attempt);
        continue;
      }

      if (response.ok) return await response.json() as T;
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        await delay(retryDelay(response.headers.get("retry-after"), attempt));
        continue;
      }
      throw new GitHubReadError(response.status, operation);
    }
  }
}

interface GraphQlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes: Array<{ isResolved: boolean }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
  };
  errors?: unknown[];
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repository: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes { isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function retryDelay(header: string | null, attempt: number): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : 500 * 2 ** attempt;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
