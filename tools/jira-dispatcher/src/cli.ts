#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexCliRunner, quoteForCmd } from "./codex.js";
import { isValidIssueKey, loadConfig, type DispatcherConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { loadEnvFile, readJiraCredentials } from "./env.js";
import { fieldValues } from "./jira/adf.js";
import { JiraClient } from "./jira/client.js";
import { JsonLogger, type Logger } from "./logger.js";
import { renderTemplateFile } from "./prompt.js";
import { Redactor } from "./redact.js";
import { RequestQueue, type OperatorRequest } from "./requests.js";
import { ProcessLock, StateStore, isProcessAlive } from "./state.js";
import { GitWorkspace } from "./workspace.js";

const USAGE = `Uso: jira-dispatcher <comando> [opções]

Comandos:
  check                 Valida configuração, Git, credenciais do Jira, templates e Codex CLI
  discover <ISSUE>      Lista campos, transições e tipos de link de uma issue (para configurar)
  once [--dry-run]      Executa um ciclo: seleciona, reserva e roda até o fim (--dry-run só lista)
  run                   Inicia o dispatcher em loop
  status [ISSUE]        Mostra o estado das execuções
  resume <ISSUE>        Retoma a última execução interrompida/falha da issue
  clear <ISSUE>         Marca a última execução bloqueante como cancelada (não altera o Jira)
  stop [--now]          Pede ao dispatcher em execução para parar (--now encerra o Codex)

Opções:
  --config <arquivo>    Padrão: ./dispatcher.config.json
  --env-file <arquivo>  Padrão: .env ao lado do arquivo de configuração
`;

interface Context {
  config: DispatcherConfig;
  redactor: Redactor;
  logger: Logger;
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const configPath = resolve(takeOption(args, "--config") ?? "dispatcher.config.json");
  const envFileOption = takeOption(args, "--env-file");
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [command, target] = args.filter((a) => !a.startsWith("--"));

  if (!command || command === "help" || flags.has("--help")) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const config = loadConfig(configPath);
  loadEnvFile(envFileOption ? resolve(envFileOption) : join(config.configDir, ".env"));
  const redactor = Redactor.fromEnvironment(process.env);
  const logger = new JsonLogger({
    filePath: join(config.stateDir, "logs", "dispatcher.jsonl"),
    level: config.logLevel,
    redactor
  });
  const ctx: Context = { config, redactor, logger };

  switch (command) {
    case "check":
      return check(ctx);
    case "discover":
      return discover(ctx, requireIssueKey(target));
    case "once":
      return withLock(ctx, (dispatcher) => once(dispatcher, flags.has("--dry-run")));
    case "run":
      return withLock(ctx, (dispatcher, queue) => runDaemon(ctx, dispatcher, queue));
    case "status":
      return status(ctx, target);
    case "resume":
      return directOrQueued(ctx, { action: "resume", issueKey: requireIssueKey(target) });
    case "clear":
      return directOrQueued(ctx, { action: "clear", issueKey: requireIssueKey(target) });
    case "stop":
      return stop(ctx, flags.has("--now"));
    default:
      process.stderr.write(`Comando desconhecido: ${command}\n\n${USAGE}`);
      return 1;
  }
}

function createDispatcher(ctx: Context, store: StateStore): Dispatcher {
  const credentials = readJiraCredentials(process.env);
  const redactor = Redactor.fromEnvironment(process.env, [credentials.apiToken]);
  return new Dispatcher({
    config: ctx.config,
    jira: new JiraClient({ baseUrl: ctx.config.jira.baseUrl, credentials }),
    store,
    workspace: new GitWorkspace(ctx.config),
    codex: new CodexCliRunner(ctx.config, redactor),
    logger: ctx.logger,
    redactor
  });
}

async function withLock(ctx: Context, fn: (dispatcher: Dispatcher, queue: RequestQueue) => Promise<number>): Promise<number> {
  const lock = new ProcessLock(ctx.config.stateDir);
  const acquired = lock.tryAcquire();
  if (!acquired.acquired) {
    const holder = acquired.holder;
    process.stderr.write(
      `Outro dispatcher já está em execução${holder ? ` (pid ${holder.pid} em ${holder.host}, desde ${holder.startedAt})` : ""}.\n`
    );
    return 2;
  }
  const release = () => lock.release();
  process.once("exit", release);
  try {
    const store = new StateStore(ctx.config.stateDir);
    return await fn(createDispatcher(ctx, store), new RequestQueue(ctx.config.stateDir));
  } finally {
    release();
  }
}

async function once(dispatcher: Dispatcher, dryRun: boolean): Promise<number> {
  const summary = await dispatcher.pollOnce({ dryRun });
  if (dryRun) {
    process.stdout.write(`Elegíveis (sem reservar): ${summary.started.join(", ") || "nenhuma"}\n`);
    for (const skipped of summary.skipped) process.stdout.write(`  - ${skipped.issueKey}: ${skipped.reason}\n`);
    return 0;
  }
  await dispatcher.waitForRuns();
  return 0;
}

async function runDaemon(ctx: Context, dispatcher: Dispatcher, queue: RequestQueue): Promise<number> {
  const stopController = new AbortController();
  let signals = 0;
  const onSignal = (signal: string) => {
    signals += 1;
    if (signals === 1) {
      ctx.logger.info("shutdown_requested", { signal, mode: "drain" });
      dispatcher.drain();
      stopController.abort();
    } else {
      ctx.logger.warn("shutdown_requested", { signal, mode: "now" });
      dispatcher.forceStop();
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  ctx.logger.info("dispatcher_started", {
    pid: process.pid,
    pollIntervalSeconds: ctx.config.pollIntervalSeconds,
    maxConcurrentRuns: ctx.config.maxConcurrentRuns,
    worktree: ctx.config.worktree.enabled
  });

  await dispatcher.runLoop(stopController.signal, async () => {
    for (const request of queue.drain()) {
      ctx.logger.info("operator_request", { ...request });
      if (request.action === "stop") {
        if (request.mode === "now") dispatcher.forceStop();
        else dispatcher.drain();
        stopController.abort();
      } else if (request.action === "resume") {
        await dispatcher.resume(request.issueKey).catch((error: Error) => ctx.logger.error("resume_failed", { issueKey: request.issueKey, error: error.message }));
      } else {
        try {
          dispatcher.clear(request.issueKey);
        } catch (error) {
          ctx.logger.error("clear_failed", { issueKey: request.issueKey, error: (error as Error).message });
        }
      }
    }
  });
  return 0;
}

/** Runs resume/clear directly when no dispatcher is running; otherwise hands it to the running one. */
async function directOrQueued(ctx: Context, request: Extract<OperatorRequest, { action: "resume" | "clear" }>): Promise<number> {
  const lock = new ProcessLock(ctx.config.stateDir);
  const holder = lock.readHolder();
  if (holder && isProcessAlive(holder.pid)) {
    new RequestQueue(ctx.config.stateDir).enqueue(request);
    process.stdout.write(`Pedido "${request.action} ${request.issueKey}" enviado ao dispatcher em execução (pid ${holder.pid}).\n`);
    return 0;
  }
  return withLock(ctx, async (dispatcher) => {
    if (request.action === "clear") {
      const run = dispatcher.clear(request.issueKey);
      process.stdout.write(`Execução ${run.runId} de ${run.issueKey} marcada como cancelada.\n`);
      return 0;
    }
    const run = await dispatcher.resume(request.issueKey);
    process.stdout.write(`Retomada ${run.issueKey}: run ${run.runId} (${run.status}). Aguardando o Codex terminar...\n`);
    await dispatcher.waitForRuns();
    return 0;
  });
}

async function stop(ctx: Context, now: boolean): Promise<number> {
  const holder = new ProcessLock(ctx.config.stateDir).readHolder();
  if (!holder || !isProcessAlive(holder.pid)) {
    process.stdout.write("Nenhum dispatcher em execução.\n");
    return 0;
  }
  new RequestQueue(ctx.config.stateDir).enqueue({ action: "stop", mode: now ? "now" : "drain" });
  process.stdout.write(
    now
      ? "Pedido de parada imediata enviado: o Codex será encerrado e as execuções ficarão como interrupted.\n"
      : "Pedido de parada enviado: nenhum ticket novo será iniciado; as execuções ativas terminarão normalmente.\n"
  );
  return 0;
}

function status(ctx: Context, issueKey?: string): number {
  const store = new StateStore(ctx.config.stateDir);
  const runs = issueKey ? store.forIssue(issueKey) : store.all();
  const holder = new ProcessLock(ctx.config.stateDir).readHolder();
  const alive = holder && isProcessAlive(holder.pid);
  process.stdout.write(`Dispatcher: ${alive ? `em execução (pid ${holder!.pid})` : "parado"}\n`);
  if (runs.length === 0) {
    process.stdout.write("Nenhuma execução registrada.\n");
    return 0;
  }
  for (const run of runs.slice(-50)) {
    process.stdout.write(
      [
        `${run.issueKey}  ${run.runId}`,
        `  status: ${run.status} (fase: ${run.phase})  criado: ${run.createdAt}  atualizado: ${run.updatedAt}`,
        run.prUrl ? `  PR: ${run.prUrl}` : undefined,
        run.jiraStatusAfter ? `  Jira ao final: ${run.jiraStatusAfter}` : undefined,
        run.error ? `  erro: [${run.error.phase}] ${run.error.message}` : undefined,
        run.workdir ? `  diretório: ${run.workdir}` : undefined,
        `  logs: ${run.logDir}`
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    );
  }
  return 0;
}

async function check(ctx: Context): Promise<number> {
  const { config } = ctx;
  let failures = 0;
  const report = (ok: boolean, label: string, detail = "") => {
    if (!ok) failures += 1;
    process.stdout.write(`${ok ? "OK  " : "FALHA"} ${label}${detail ? ` — ${ctx.redactor.redact(detail)}` : ""}\n`);
  };

  report(true, "Configuração carregada");
  try {
    await new GitWorkspace(config).verifyRepository();
    report(true, "Repositório Git", `${config.repoPath} (branch padrão ${config.defaultBranch})`);
  } catch (error) {
    report(false, "Repositório Git", (error as Error).message);
  }

  for (const [label, file] of [
    ["Template de execução", config.codex.promptTemplateFile],
    ["Template de retomada", config.codex.resumePromptTemplateFile],
    ["Schema do resultado", config.codex.outputSchemaFile]
  ] as const) {
    report(existsSync(file), label, file);
  }
  try {
    const sample = { issueKey: "DEV-0", issueUrl: "", runId: "check", workdir: "", defaultBranch: "", remote: "", reservedStatus: "", workspaceNote: "" };
    renderTemplateFile(config.codex.promptTemplateFile, sample);
    report(true, "Placeholders do template de execução");
  } catch (error) {
    report(false, "Placeholders do template de execução", (error as Error).message);
  }

  let jira: JiraClient | undefined;
  try {
    const credentials = readJiraCredentials(process.env);
    const client = new JiraClient({ baseUrl: config.jira.baseUrl, credentials, maxRetries: 0 });
    const me = await client.myself();
    jira = client;
    report(true, "Autenticação no Jira", `conta ${me.displayName ?? me.accountId}`);
  } catch (error) {
    report(false, "Autenticação no Jira", (error as Error).message);
  }
  if (jira) {
    try {
      const issues = await jira.searchIssues(config.jira.eligibilityJql, ["status"], config.jira.maxResults);
      report(true, "JQL de elegibilidade", `${issues.length} issue(s): ${issues.map((i) => i.key).join(", ") || "nenhuma"}`);
    } catch (error) {
      report(false, "JQL de elegibilidade", (error as Error).message);
    }
  }

  const version = await codexVersion(config);
  report(version.ok, "Codex CLI", version.detail);

  process.stdout.write(failures === 0 ? "\nTodas as verificações passaram.\n" : `\n${failures} verificação(ões) falharam.\n`);
  return failures === 0 ? 0 : 1;
}

function codexVersion(config: DispatcherConfig): Promise<{ ok: boolean; detail: string }> {
  const useShell = process.platform === "win32" && !/\.exe$/i.test(config.codex.command);
  return new Promise((resolveVersion) => {
    execFile(
      useShell ? quoteForCmd(config.codex.command) : config.codex.command,
      ["--version"],
      { shell: useShell, windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) resolveVersion({ ok: false, detail: `${config.codex.command} --version falhou: ${error.message}` });
        else resolveVersion({ ok: true, detail: (stdout || stderr).trim() });
      }
    );
  });
}

async function discover(ctx: Context, issueKey: string): Promise<number> {
  const jira = new JiraClient({ baseUrl: ctx.config.jira.baseUrl, credentials: readJiraCredentials(process.env) });
  const [issue, fields, transitions, linkTypes] = await Promise.all([
    jira.getIssue(issueKey, ["*all"]),
    jira.listFields(),
    jira.getTransitions(issueKey),
    jira.listLinkTypes()
  ]);
  const names = new Map(fields.map((f) => [f.id, f.name]));
  const out = (line = "") => process.stdout.write(`${ctx.redactor.redact(line)}\n`);

  out(`Issue ${issue.key}`);
  out(`Status atual: ${issue.fields.status?.name} (id ${issue.fields.status?.id}, categoria ${issue.fields.status?.statusCategory?.key})`);
  out("\nCampos preenchidos (id — nome: amostra):");
  for (const [id, value] of Object.entries(issue.fields).sort(([a], [b]) => a.localeCompare(b))) {
    const values = fieldValues(value);
    if (values.length === 0) continue;
    const sample = values.join(" | ").replace(/\s+/g, " ").slice(0, 80);
    out(`  ${id} — ${names.get(id) ?? "?"}: ${sample}`);
  }
  out("\nTransições disponíveis agora (id — nome → status destino [id]):");
  for (const t of transitions) out(`  ${t.id} — ${t.name} → ${t.to.name} [${t.to.id}]`);
  out("\nTipos de link (nome: inward / outward):");
  for (const l of linkTypes) out(`  ${l.name}: "${l.inward}" / "${l.outward}"`);
  const links = issue.fields.issuelinks ?? [];
  if (links.length) {
    out("\nLinks desta issue:");
    for (const link of links) {
      const other = link.inwardIssue ?? link.outwardIssue;
      out(`  ${link.type.name} (${link.inwardIssue ? "inward" : "outward"}) ${other?.key} — ${other?.fields?.status?.name ?? "?"}`);
    }
  }
  return 0;
}

function requireIssueKey(value: string | undefined): string {
  if (!value || !isValidIssueKey(value)) throw new Error("Informe uma chave de issue válida, por exemplo DEV-10.");
  return value;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const redactor = Redactor.fromEnvironment(process.env);
    process.stderr.write(`Erro: ${redactor.redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
);
