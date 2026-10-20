import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { CodexRunner, CodexRunResult } from "./codex.js";
import { isValidIssueKey, type DispatcherConfig } from "./config.js";
import { eligibilityFields, evaluateEligibility } from "./eligibility.js";
import { statusMatches, type JiraApi, type JiraTransition } from "./jira/client.js";
import type { Logger } from "./logger.js";
import { renderTemplateFile } from "./prompt.js";
import type { Redactor } from "./redact.js";
import { BLOCKING_STATUSES, isProcessAlive, type RunRecord, type StateStore } from "./state.js";
import { formatJiraTimestamp, sleep } from "./time.js";
import type { PreparedWorkspace, Workspace } from "./workspace.js";

export interface DispatcherDeps {
  config: DispatcherConfig;
  jira: JiraApi;
  store: StateStore;
  workspace: Workspace;
  codex: CodexRunner;
  logger: Logger;
  redactor: Redactor;
  now?: () => Date;
  /** Delay between comment retries; tests set it to 0. */
  commentRetryDelayMs?: number;
}

export interface PollSummary {
  considered: number;
  started: string[];
  skipped: { issueKey: string; reason: string }[];
}

export class Dispatcher {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly forceAbort = new AbortController();
  private draining = false;
  private readonly now: () => Date;

  constructor(private readonly deps: DispatcherDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get isDraining(): boolean {
    return this.draining;
  }

  get logDirRoot(): string {
    return join(this.deps.config.stateDir, "runs");
  }

  /**
   * Called once at startup while holding the process lock: any run still marked active belongs to a
   * previous dispatcher process. If its Codex process is gone the run becomes `interrupted`;
   * if Codex is still alive it keeps blocking the issue until it exits.
   */
  recover(): RunRecord[] {
    const recovered: RunRecord[] = [];
    for (const run of this.deps.store.active()) {
      if (this.inFlight.has(run.runId)) continue;
      const sameHost = run.dispatcherHost === hostname();
      // Runs owned by this process are mid-reservation; they are not orphans.
      if (sameHost && run.dispatcherPid === process.pid) continue;
      if (sameHost && run.childPid && isProcessAlive(run.childPid)) {
        if (run.phase !== "orphaned") {
          this.deps.store.update(run.runId, { phase: "orphaned" });
          this.deps.logger.warn("run_orphaned_codex_alive", { issueKey: run.issueKey, runId: run.runId, childPid: run.childPid });
        }
        continue;
      }
      const updated = this.deps.store.update(run.runId, {
        status: "interrupted",
        error: { phase: run.phase, message: "A execução foi interrompida antes de terminar (dispatcher ou Codex encerrado)." },
        finishedAt: this.now().toISOString()
      });
      this.deps.logger.warn("run_interrupted_recovered", { issueKey: run.issueKey, runId: run.runId, phase: run.phase });
      recovered.push(updated);
    }
    return recovered;
  }

  /** Finds eligible issues and starts runs up to the concurrency limit. */
  async pollOnce(options: { dryRun?: boolean } = {}): Promise<PollSummary> {
    const summary: PollSummary = { considered: 0, started: [], skipped: [] };
    if (this.draining) return summary;
    this.recover();

    const { config, jira, store, logger } = this.deps;
    let slots = config.maxConcurrentRuns - store.active().length;
    if (slots <= 0 && !options.dryRun) {
      logger.debug("poll_skipped_no_slots", { active: store.active().length });
      return summary;
    }

    const issues = await jira.searchIssues(config.jira.eligibilityJql, eligibilityFields(config), config.jira.maxResults);
    logger.info("poll_completed", { found: issues.length });

    for (const issue of issues) {
      if (!options.dryRun && slots <= 0) break;
      summary.considered += 1;
      const skip = (reason: string) => {
        summary.skipped.push({ issueKey: issue.key, reason });
        logger.info("issue_skipped", { issueKey: issue.key, reason });
      };

      if (!isValidIssueKey(issue.key)) {
        skip("chave de issue inválida");
        continue;
      }
      const active = store.activeForIssue(issue.key);
      if (active) {
        skip(`execução ativa ${active.runId}`);
        continue;
      }
      const blocking = store.blockingRunForIssue(issue.key);
      if (blocking) {
        skip(`execução anterior ${blocking.runId} terminou como ${blocking.status}; use resume ou clear`);
        continue;
      }
      const eligibility = evaluateEligibility(issue, config);
      if (!eligibility.eligible) {
        skip(`não elegível: ${eligibility.reasons.join("; ")}`);
        continue;
      }
      if (options.dryRun) {
        summary.started.push(issue.key);
        continue;
      }
      if (await this.reserveAndStart(issue.key)) {
        summary.started.push(issue.key);
        slots -= 1;
      }
    }
    return summary;
  }

  /** Reserves an issue in Jira and launches Codex. Returns true when Codex was started. */
  async reserveAndStart(issueKey: string): Promise<boolean> {
    const { config, jira, store } = this.deps;
    const run = store.create({ issueKey, logDirRoot: this.logDirRoot });
    const log = this.deps.logger.child({ issueKey, runId: run.runId });
    log.info("run_created");

    // 1. Revalidate against fresh data right before changing anything in Jira.
    let fresh;
    try {
      fresh = await jira.getIssue(issueKey, eligibilityFields(config));
    } catch (error) {
      this.cancel(run, "revalidation", `Falha ao ler a issue: ${this.message(error)}`, log);
      return false;
    }
    const eligibility = evaluateEligibility(fresh, config);
    if (!eligibility.eligible) {
      this.cancel(run, "revalidation", `Deixou de ser elegível: ${eligibility.reasons.join("; ")}`, log);
      return false;
    }

    // 2. Find the reservation transition among those Jira offers right now.
    let transition: JiraTransition;
    try {
      const transitions = await jira.getTransitions(issueKey);
      transition = this.pickReservationTransition(transitions);
    } catch (error) {
      this.fail(run, "reservation", this.message(error), log);
      return false;
    }

    // 3. Reserve. A transition is never retried automatically.
    store.update(run.runId, { phase: "transitioning" });
    try {
      await jira.transitionIssue(issueKey, transition.id);
    } catch (error) {
      this.fail(run, "reservation", `Transição "${transition.name}" falhou: ${this.message(error)}`, log);
      return false;
    }
    store.update(run.runId, { jiraReserved: true, phase: "reserved" });
    log.info("issue_reserved", { transition: transition.name, to: transition.to.name });

    try {
      const after = await jira.getIssue(issueKey, ["status"]);
      if (!statusMatches(after.fields.status, [config.jira.reservationTargetStatus])) {
        this.fail(
          run,
          "reservation",
          `Após a transição, a issue está em "${after.fields.status?.name ?? "?"}", não em "${config.jira.reservationTargetStatus}".`,
          log
        );
        return false;
      }
    } catch (error) {
      log.warn("reservation_status_check_failed", { error: this.message(error) });
    }

    // 4. Mandatory start comment (AGENTS.md). Only the comment is retried, never the transition.
    const started = formatJiraTimestamp(this.now(), config.jira.commentTimeZone);
    const commentOk = await this.commentWithRetry(
      issueKey,
      `Iniciado em ${started}. Execução autônoma iniciada pelo dispatcher. runId: ${run.runId}.`,
      log
    );
    if (!commentOk) {
      this.fail(run, "start_comment", "A issue foi reservada, mas o comentário de início falhou após novas tentativas.", log);
      return false;
    }
    store.update(run.runId, { startCommentPosted: true });
    await this.recordRunProperty(issueKey, run.runId, "running", log);

    // 5. Workspace and Codex.
    let prepared: PreparedWorkspace;
    try {
      prepared = await this.deps.workspace.prepare(issueKey, run.runId);
    } catch (error) {
      this.fail(run, "workspace", this.message(error), log);
      return false;
    }

    let prompt: string;
    try {
      prompt = renderTemplateFile(config.codex.promptTemplateFile, {
        issueKey,
        issueUrl: `${config.jira.baseUrl}/browse/${issueKey}`,
        runId: run.runId,
        workdir: prepared.workdir,
        defaultBranch: config.defaultBranch,
        remote: config.remote,
        reservedStatus: transition.to.name,
        workspaceNote: prepared.worktreePath
          ? `Criou uma worktree dedicada em \`${prepared.worktreePath}\`, em HEAD destacado na versão atual de \`${config.remote}/${config.defaultBranch}\`. Crie a branch da issue a partir daqui, conforme o AGENTS.md. Instale as dependências necessárias nesta worktree.`
          : "Verificou que o checkout principal está limpo. Crie a branch da issue a partir da branch padrão, conforme o AGENTS.md."
      });
    } catch (error) {
      this.fail(run, "prompt", this.message(error), log);
      return false;
    }

    this.launch(run, prepared, prompt, log);
    return true;
  }

  /**
   * Resumes the most recent interrupted/failed run of an issue in a new run (new runId).
   * It never repeats the reservation transition.
   */
  async resume(issueKey: string): Promise<RunRecord> {
    const { config, jira, store } = this.deps;
    if (!isValidIssueKey(issueKey)) throw new Error(`Chave de issue inválida: ${issueKey}`);
    this.recover();
    if (store.activeForIssue(issueKey)) throw new Error(`${issueKey} já tem uma execução ativa.`);
    const previous = store.latestForIssue(issueKey);
    if (!previous || !BLOCKING_STATUSES.includes(previous.status)) {
      throw new Error(`${issueKey} não tem execução interrompida, com falha ou aguardando atenção para retomar.`);
    }

    const issue = await jira.getIssue(issueKey, ["status"]);
    if (!statusMatches(issue.fields.status, config.jira.resumableStatuses)) {
      throw new Error(
        `${issueKey} está em "${issue.fields.status?.name ?? "?"}", que não está em resumableStatuses. Verifique o Jira manualmente.`
      );
    }

    const run = store.create({ issueKey, logDirRoot: this.logDirRoot, previousRunId: previous.runId });
    store.update(run.runId, { jiraReserved: true, phase: "resuming" });
    const log = this.deps.logger.child({ issueKey, runId: run.runId, previousRunId: previous.runId });
    log.info("run_resume_requested", { previousStatus: previous.status });

    const timestamp = formatJiraTimestamp(this.now(), config.jira.commentTimeZone);
    const comment = previous.startCommentPosted
      ? `Execução autônoma retomada em ${timestamp}. runId: ${run.runId} (anterior: ${previous.runId}).`
      : `Iniciado em ${timestamp}. Execução autônoma retomada pelo dispatcher. runId: ${run.runId} (anterior: ${previous.runId}).`;
    if (await this.commentWithRetry(issueKey, comment, log)) {
      store.update(run.runId, { startCommentPosted: true });
    } else if (!previous.startCommentPosted) {
      this.fail(run, "start_comment", "O comentário de início continua falhando; a execução não foi retomada.", log);
      return store.get(run.runId)!;
    }
    await this.recordRunProperty(issueKey, run.runId, "running", log);

    let prepared: PreparedWorkspace;
    try {
      prepared = previous.workdir
        ? await this.deps.workspace.reuse(previous.workdir, previous.worktreePath)
        : await this.deps.workspace.prepare(issueKey, run.runId);
    } catch (error) {
      this.fail(run, "workspace", this.message(error), log);
      return store.get(run.runId)!;
    }
    const snapshot = await this.deps.workspace.snapshot(prepared.workdir);

    let prompt: string;
    try {
      prompt = renderTemplateFile(config.codex.resumePromptTemplateFile, {
        issueKey,
        issueUrl: `${config.jira.baseUrl}/browse/${issueKey}`,
        runId: run.runId,
        previousRunId: previous.runId,
        previousStatus: previous.status,
        previousError: previous.error ? `${previous.error.phase}: ${previous.error.message}` : undefined,
        previousSummary: previous.summary,
        jiraStatus: issue.fields.status?.name,
        workdir: prepared.workdir,
        branch: snapshot.branch,
        head: snapshot.head,
        dirtyFiles: snapshot.dirtyFiles ?? 0
      });
    } catch (error) {
      this.fail(run, "prompt", this.message(error), log);
      return store.get(run.runId)!;
    }

    this.launch(run, prepared, prompt, log);
    return store.get(run.runId)!;
  }

  /** Marks the latest blocking run of an issue as cancelled so the issue can be selected again. Jira is not touched. */
  clear(issueKey: string): RunRecord {
    const run = this.deps.store.blockingRunForIssue(issueKey);
    if (!run) throw new Error(`${issueKey} não tem execução bloqueante para limpar.`);
    const updated = this.deps.store.update(run.runId, { status: "cancelled", phase: "cleared_by_operator" });
    this.deps.logger.info("run_cleared", { issueKey, runId: run.runId });
    return updated;
  }

  /** Stops selecting new issues; running Codex processes continue until they finish. */
  drain(): void {
    if (!this.draining) this.deps.logger.info("dispatcher_draining", { activeRuns: this.inFlight.size });
    this.draining = true;
  }

  /** Stops running Codex processes; their runs are recorded as interrupted and can be resumed. */
  forceStop(): void {
    this.drain();
    this.deps.logger.warn("dispatcher_force_stop", { activeRuns: this.inFlight.size });
    this.forceAbort.abort();
  }

  async waitForRuns(): Promise<void> {
    while (this.inFlight.size > 0 || this.background.size > 0) {
      await Promise.allSettled([...this.inFlight.values(), ...this.background]);
    }
  }

  get activeRunCount(): number {
    return this.inFlight.size;
  }

  /**
   * Main loop. Operator requests and Jira polls run sequentially in the same loop, so they never race.
   * When `stop` aborts (or drain() is called) it stops polling and waits for active runs,
   * still handling requests so a forced stop can be requested while draining.
   */
  async runLoop(stop: AbortSignal, handleRequests: () => Promise<void> | void = () => undefined, tickMs = 2000): Promise<void> {
    this.recover();
    let nextPollAt = 0;
    while (!stop.aborted && !this.draining) {
      await this.safely("requests_failed", handleRequests);
      if (this.draining || stop.aborted) break;
      if (this.now().getTime() >= nextPollAt) {
        await this.safely("poll_failed", () => this.pollOnce());
        nextPollAt = this.now().getTime() + this.deps.config.pollIntervalSeconds * 1000;
      }
      await sleep(tickMs, stop);
    }
    this.drain();
    while (this.inFlight.size > 0 || this.background.size > 0) {
      await this.safely("requests_failed", handleRequests);
      await Promise.race([sleep(tickMs), Promise.allSettled([...this.inFlight.values(), ...this.background])]);
    }
    this.deps.logger.info("dispatcher_stopped");
  }

  private async safely(event: string, fn: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.deps.logger.error(event, { error: this.message(error) });
    }
  }

  // ---- internals ----

  private pickReservationTransition(transitions: JiraTransition[]): JiraTransition {
    const { reservationTransitionId, reservationTargetStatus } = this.deps.config.jira;
    const candidates = reservationTransitionId
      ? transitions.filter((t) => t.id === reservationTransitionId)
      : transitions.filter((t) => statusMatches(t.to, [reservationTargetStatus]));
    if (candidates.length === 0) {
      const available = transitions.map((t) => `${t.name} → ${t.to.name}`).join(", ") || "nenhuma";
      throw new Error(`Nenhuma transição disponível para "${reservationTargetStatus}". Disponíveis: ${available}.`);
    }
    if (candidates.length > 1) {
      throw new Error(
        `Mais de uma transição leva a "${reservationTargetStatus}" (${candidates.map((t) => t.id).join(", ")}); configure reservationTransitionId.`
      );
    }
    return candidates[0]!;
  }

  private launch(run: RunRecord, prepared: PreparedWorkspace, prompt: string, log: Logger): void {
    const { store, codex } = this.deps;
    mkdirSync(run.logDir, { recursive: true });
    store.update(run.runId, {
      status: "running",
      phase: "codex",
      workdir: prepared.workdir,
      worktreePath: prepared.worktreePath,
      dispatcherPid: process.pid,
      dispatcherHost: hostname()
    });
    log.info("codex_starting", { workdir: prepared.workdir });

    const task = codex
      .run({
        prompt,
        workdir: prepared.workdir,
        extraWritableDirs: prepared.extraWritableDirs,
        logDir: run.logDir,
        signal: this.forceAbort.signal,
        onSpawn: (pid) => store.update(run.runId, { childPid: pid }),
        onThreadId: (threadId) => store.update(run.runId, { codexThreadId: threadId })
      })
      .then((result) => this.finalize(run.runId, result, log))
      .catch((error) => {
        this.fail(store.get(run.runId)!, "codex", this.message(error), log);
      })
      .finally(() => this.inFlight.delete(run.runId));
    this.inFlight.set(run.runId, task);
  }

  private async finalize(runId: string, result: CodexRunResult, log: Logger): Promise<void> {
    const { store, jira, config } = this.deps;
    const run = store.get(runId)!;
    const base = {
      exitCode: result.exitCode,
      signal: result.signal,
      codexThreadId: result.threadId ?? run.codexThreadId,
      finishedAt: this.now().toISOString()
    };

    if (result.spawnError) return void this.fail(run, "codex_spawn", result.spawnError, log, base);
    if (result.aborted) {
      store.update(runId, { ...base, status: "interrupted", error: { phase: "codex", message: "Codex encerrado pelo desligamento forçado do dispatcher." } });
      log.warn("run_interrupted");
      return;
    }
    if (result.timedOut) return void this.fail(run, "codex_timeout", `Codex excedeu ${config.codex.timeoutMinutes} minutos.`, log, base);
    if (result.exitCode !== 0) {
      return void this.fail(run, "codex_exit", `Codex terminou com código ${result.exitCode}${result.lastError ? `: ${result.lastError}` : ""}.`, log, base);
    }

    let jiraStatusAfter: string | undefined;
    let jiraStatusIsDone = false;
    try {
      const issue = await jira.getIssue(run.issueKey, ["status"]);
      jiraStatusAfter = issue.fields.status?.name;
      jiraStatusIsDone = statusMatches(issue.fields.status, config.jira.doneStatuses);
    } catch (error) {
      log.warn("final_status_check_failed", { error: this.message(error) });
    }

    const final = result.finalResult;
    if (!final) {
      store.update(runId, { ...base, jiraStatusAfter, status: "needs_attention", error: { phase: "result", message: result.resultError ?? "Resultado ausente." } });
      log.warn("run_needs_attention", { reason: result.resultError });
      return;
    }

    const common = { ...base, jiraStatusAfter, outcome: final.outcome, prUrl: final.prUrl, summary: this.deps.redactor.redact(final.summary) };
    if (final.issueKey !== run.issueKey) {
      store.update(runId, { ...common, status: "needs_attention", error: { phase: "result", message: `Resultado se refere a ${final.issueKey}, não a ${run.issueKey}.` } });
      log.warn("run_needs_attention", { reason: "issue_key_mismatch" });
      return;
    }

    if (final.outcome === "done" && jiraStatusIsDone) {
      store.update(runId, { ...common, status: "completed", phase: "done" });
      await this.recordRunProperty(run.issueKey, runId, "completed", log);
      log.info("run_completed", { prUrl: final.prUrl, jiraStatus: jiraStatusAfter });
      return;
    }
    if (final.outcome === "failed") {
      return void this.fail(run, "codex_reported_failure", final.summary, log, common);
    }
    const message =
      final.outcome === "done"
        ? `Codex informou "done", mas o Jira está em "${jiraStatusAfter ?? "desconhecido"}".`
        : `Codex finalizou com "${final.outcome}".`;
    store.update(runId, { ...common, status: "needs_attention", error: { phase: "result", message } });
    await this.recordRunProperty(run.issueKey, runId, "needs_attention", log);
    log.warn("run_needs_attention", { outcome: final.outcome, jiraStatus: jiraStatusAfter });
  }

  private cancel(run: RunRecord, phase: string, message: string, log: Logger): void {
    this.deps.store.update(run.runId, { status: "cancelled", phase, error: { phase, message: this.deps.redactor.redact(message) }, finishedAt: this.now().toISOString() });
    log.info("run_cancelled_before_reservation", { phase, reason: message });
  }

  private fail(run: RunRecord, phase: string, message: string, log: Logger, extra: Partial<RunRecord> = {}): void {
    const safe = this.deps.redactor.redact(message);
    const current = this.deps.store.get(run.runId) ?? run;
    this.deps.store.update(run.runId, { ...extra, status: "failed", phase, error: { phase, message: safe }, finishedAt: this.now().toISOString() });
    log.error("run_failed", { phase, error: safe });
    if (current.jiraReserved) {
      // Best effort: record the failure on the issue (no status change).
      const timestamp = formatJiraTimestamp(this.now(), this.deps.config.jira.commentTimeZone);
      const task = this.commentWithRetry(
        run.issueKey,
        `Execução autônoma ${run.runId} interrompida em ${timestamp}. Fase: ${phase}. Motivo: ${safe.slice(0, 500)}. Nenhuma transição adicional foi feita pelo dispatcher.`,
        log,
        1
      )
        .then(() => this.recordRunProperty(run.issueKey, run.runId, "failed", log))
        .finally(() => this.background.delete(task));
      this.background.add(task);
    }
  }

  private async commentWithRetry(issueKey: string, text: string, log: Logger, attempts = 3): Promise<boolean> {
    const delay = this.deps.commentRetryDelayMs ?? 2000;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.deps.jira.addComment(issueKey, text);
        return true;
      } catch (error) {
        log.warn("jira_comment_failed", { attempt, error: this.message(error) });
        if (attempt < attempts) await sleep(delay * attempt);
      }
    }
    return false;
  }

  private async recordRunProperty(issueKey: string, runId: string, status: string, log: Logger): Promise<void> {
    const key = this.deps.config.jira.runPropertyKey;
    if (!key) return;
    try {
      await this.deps.jira.setIssueProperty(issueKey, key, { runId, status, host: hostname(), updatedAt: this.now().toISOString() });
    } catch (error) {
      log.warn("jira_property_failed", { error: this.message(error) });
    }
  }

  private message(error: unknown): string {
    return this.deps.redactor.redact(error instanceof Error ? error.message : String(error));
  }
}
