# Hosted PR quality orchestration

## Current state

`tools/github-reviewer/src/agent-orchestrator.ts` implements the provider-neutral orchestration policy. It requires current-head CI and Sonar evidence, runs Code Review before QA, requires a formal GitHub Code Review decision before QA, and runs the Quality Gate Coordinator only after QA approves. Each agent result must identify the same full commit SHA and include a report. The current HEAD is re-read before and after agent execution, stale evidence is rejected, and failures return `INCONCLUSIVE` without proceeding to dependent stages.

The orchestrator receives infrastructure adapters for GitHub, execution locking, agent execution, and report publication. It does not load a model SDK, contact an AI service, create a GitHub review on its own, or merge a pull request. Tests use adapter fakes and do not represent hosted validation.

**Selected runtime: Codex CLI with ChatGPT Plus authentication.** The private repository uses a persistent Windows self-hosted runner under the signed-in Windows account. The Codex CLI reuses the ChatGPT-managed authentication already stored on that machine; it does not use an OpenAI API key. Model requests consume the account's Plus/Codex usage limits and are not unlimited. The runner is registered to this repository, starts at Windows logon, and is kept online while the machine is running.

The integration code and workflow are prepared, but hosted agent execution is not yet validated end to end. The workflow runs after successful CI for internal pull requests and after the `PR title` check completes, so PR metadata edits trigger a fresh evaluation; it can also be dispatched manually from `master`. It checks out trusted `master` code, fetches PR metadata and review inputs through a read-only Actions token, and never checks out or runs PR code. Codex starts with `--sandbox read-only --ignore-user-config --ephemeral --disable shell_tool`: the model receives the supplied review evidence but has no shell tool to read runner files or execute commands. The self-hosted Codex jobs receive only a read-only Actions token; the Codex process receives neither the Actions token nor GitHub App credentials. Separate GitHub-hosted publisher jobs receive App credentials only after validating the structured result, the current PR SHA, and a fingerprint recalculated with the read-only Actions token. Fork PRs are ineligible for this self-hosted runtime.

The runner itself is trusted private infrastructure and must remain restricted to this repository and the `codex-plus` workflow label. Its Codex authentication file is sensitive: it is not copied to GitHub Secrets, repository files, or artifacts. A shortcut in the signed-in user's Windows Startup folder starts the runner after sign-in; shutdown or sign-out makes it unavailable until the next login. The workflow serializes work by PR (falling back to the workflow-run branch when GitHub omits the PR number) and each Codex stage is a separate job.

Completed evidence is durable in App-authored GitHub reviews and PR comments. Reports carry a stable marker for stage, full HEAD SHA, and a SHA-256 fingerprint of the review inputs: the base commit, PR title/body, exact diff, summarized CI/Sonar states, and `AGENTS.md` read from that base commit. The publisher and Merge Readiness independently reload and fingerprint those inputs before accepting or writing evidence. A retry reuses a valid current result, updates an existing report comment instead of posting a duplicate, and retries `INCONCLUSIVE` outcomes. Formal Code Review is reused only when the latest App review is on the same SHA and has the same decision and body. Artifacts only transfer a result between jobs in one run; they are not the persistent ledger. If a SHA or input fingerprint differs, the old result is not reused. Transient GitHub API failures stop the affected stage and the next run reconciles from the durable review/comment state.

PR title, description, and diff are treated as untrusted. A deterministic guard blocks several direct instruction-override patterns as `INCONCLUSIVE`, and tests verify those cases; this is a heuristic, not proof of model immunity. The model can still misjudge code without an obvious injection string. The orchestration never merges, and PM must perform the separate final Merge Readiness and human workflow checks. If a future policy requires zero model-based approval risk, replace automatic model approvals with an independent human approval gate.

DEV-44 remains open until the workflow is merged, runner labels and secrets are verified remotely, a real low-risk run completes, and the reports and formal review are confirmed by Merge Readiness. No merge should be performed solely to validate this workflow.

## Required adapter contracts

A hosted runtime must implement the `AgentOrchestratorDependencies` interface and provide:

- `readHeadSha` and `readPrerequisites` using GitHub evidence for the target PR.
- Per-repository/PR/SHA/agent idempotency backed by App-authored formal reviews and marked PR comments, with GitHub Actions concurrency and retry recovery after a runner is interrupted.
- `executeAgent` for the independently authorized Code Review, QA, and Quality Gate Coordinator roles. It must return a structured decision, exact SHA, and Markdown evidence.
- `submitFormalCodeReview` using a GitHub identity authorized to review and distinct from the PR author. The review body carries the Code Review findings; report comments alone are not formal reviews.
- `publishReport` by reusing the DEV-40 publisher for Code Review inconclusive reports, QA, and Quality Gate Coordinator reports; it must re-check the PR head before publishing and update a matching marked comment.

No adapter may receive a credential that is unnecessary for its role. Untrusted PR code must never run in a privileged job. A model/agent adapter should receive only the diff and the read-only context needed for analysis, not execute PR scripts. GitHub App credentials must be isolated to the narrowly scoped action that submits a review or publishes a report.

## Activation checklist

1. Merge the DEV-44 workflow and runtime implementation to `master`.
2. Confirm the repository secrets `CASHIN_APP_ID`, `CASHIN_APP_INSTALLATION_ID`, and `CASHIN_APP_PRIVATE_KEY`, plus the `CASHIN_APP_BOT_LOGIN` repository variable, are available to the workflow.
3. Validate a low-risk internal test PR after successful CI, confirming the real Codex CLI ran with the shell tool disabled on the current SHA and the Code Review formal review, QA report, and Coordinator report were published.
4. Confirm Merge Readiness re-evaluates after the reports and accepts only evidence for the same current SHA. Test a new commit and ensure old evidence no longer satisfies the gate.
5. Confirm timeout, duplicate event, and runner-unavailable outcomes fail closed. Do not enable merge automation as part of this work.
6. Only after these checks, document the workflow as active and close DEV-44. The workflow never performs merge or Jira transitions.

## Local tests

From `tools/github-reviewer`:

```powershell
npm ci
npm test
```

The unit tests validate sequencing, durable marker parsing, stale SHA/context rejection, duplicate comment updates, API failure handling, prompt-injection heuristics, and Codex shell-tool disablement using fakes. They do not make network requests, publish GitHub reviews/comments, invoke Codex, or prove that the self-hosted runner works. A first end-to-end workflow run consumes the ChatGPT Plus/Codex usage allowance. `actionlint` and `zizmor` validate workflow syntax and security patterns but do not verify remote runner state, GitHub App secrets, or model behavior.
