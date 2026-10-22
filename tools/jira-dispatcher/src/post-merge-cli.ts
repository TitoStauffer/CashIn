import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JiraClient, JiraHttpError } from "./jira/client.js";
import { loadEnvFile, readJiraCredentials } from "./env.js";
import { GitHubReadClient, GitHubReadError } from "./post-merge/github-client.js";
import { PostMergeError, processPostMergeEvent } from "./post-merge/service.js";

const USAGE = `Uso: npm run post-merge [-- --event-file <arquivo>]

Processa com segurança um evento pull_request.closed do GitHub Actions.
Em execução local, use uma cópia de payload de teste e credenciais de leitura/escrita apropriadas.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  loadEnvFile(resolve(process.env.JIRA_DISPATCHER_ENV_FILE ?? ".env"));
  const eventPath = optionValue("--event-file") ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new PostMergeError("GITHUB_EVENT_PATH não configurado; informe --event-file.");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as unknown;
  const repository = process.env.GITHUB_REPOSITORY?.split("/");
  if (!repository || repository.length !== 2 || !repository.every(Boolean)) {
    throw new PostMergeError("GITHUB_REPOSITORY deve ter o formato owner/repository.");
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new PostMergeError("GITHUB_TOKEN não configurado.");
  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) throw new PostMergeError("JIRA_BASE_URL deve ser uma URL HTTPS.");
  const reportingAppLogin = process.env.GITHUB_APP_BOT_LOGIN?.trim();
  if (!reportingAppLogin) throw new PostMergeError("GITHUB_APP_BOT_LOGIN não configurado.");

  const result = await processPostMergeEvent(event, {
    github: new GitHubReadClient(token),
    jira: new JiraClient({ baseUrl: baseUrl.replace(/\/$/, ""), credentials: readJiraCredentials(process.env) }),
    repositoryOwner: repository[0]!,
    repositoryName: repository[1]!,
    reportingAppLogin,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "BLOCKED") process.exitCode = 1;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new PostMergeError(`${name} requer um valor.`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ status: "FAILED", reason: safeFailure(error) })}\n`);
  process.exitCode = 1;
});

function safeFailure(error: unknown): string {
  if (error instanceof GitHubReadError) return `Integração GitHub indisponível (HTTP ${error.status}, ${error.operation}).`;
  if (error instanceof JiraHttpError) return `Integração Jira indisponível (HTTP ${error.status}).`;
  if (error instanceof PostMergeError) return error.message;
  if (error instanceof SyntaxError) return "O payload do GitHub não contém JSON válido.";
  return "Falha inesperada ao processar o encerramento pós-merge; consulte os logs do job sem expor credenciais.";
}
