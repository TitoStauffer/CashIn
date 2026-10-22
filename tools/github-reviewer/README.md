# CashIn -- DevAgents GitHub Publisher

This local tool publishes agent reports as comments on CashIn pull requests using the `CashIn -- DevAgents` GitHub App. It also retains the existing formal Code Review command. The shared report publisher supports the Code Review Agent (for inconclusive reports only), Quality Gate Coordinator, QA Agent, and PM Agent; reports use distinct signatures.

It does not merge pull requests or change GitHub App permissions. The existing formal review flow remains separate from report comments.

## Hosted agent orchestration status

`src/agent-orchestrator.ts` contains the provider-neutral sequencing core for Code Review, QA, and Quality Gate Coordinator. `src/codex-cli-agent.ts` adapts those roles to the Codex CLI, using the signed-in ChatGPT account, a read-only sandbox, and `--disable shell_tool` so the model cannot issue commands on the runner. The workflow runs after successful CI or PR title validation on an internal PR, or through manual dispatch from `master`. PR title validation also re-triggers agents after metadata edits so stale reports can be replaced. Codex jobs run on the self-hosted Windows runner without GitHub App credentials; separate GitHub-hosted jobs publish validated results. Trusted checkouts pin `actions/checkout` v7.0.1, pass the workflow token explicitly, and set `persist-credentials: false`. A run from the Windows runner confirmed this checkout succeeds. The workflow does not merge or modify Jira.

The context contains complete changed text files and direct local TypeScript dependencies at the exact HEAD (base for removed files), current-SHA check-run metadata, and the API-confirmed formal Code Review before QA/Coordinator. Changes are limited to 32 files, dependencies to 20 additional files, and combined snapshots to 250 KB. Source snapshots are never executed. The fingerprint ignores checkbox marks and check URLs/timestamps; changes to requirements, code, base SHA or check outcomes still invalidate evidence. This prevents checklist maintenance and identical check retries from consuming another model round. The injection heuristic scans added lines and complete snapshots as untrusted source.

The gate fetches individual ruleset details: the list endpoint returns summaries without rules. For a single-maintainer repository using App reviews, require the `Merge Readiness` status together with all CI/Sonar checks. That status independently requires the App's formal current-SHA approval plus structured QA and Coordinator approvals. GitHub's separate human-review count can be zero in this configuration; the formal App review remains mandatory in the gate. A required gate can make GitHub report `blocked` until the gate itself passes. This aggregate state is ignored only for that self-required, ruleset-only configuration with no human count, code-owner/last-push requirement, designated reviewers or unsupported rule types. All individual evidence checks still apply. Opaque classic-protection blocks and unsupported rules stay blocked. There are no bypass actors and the workflow does not merge.

The Codex CLI uses the ChatGPT Plus allowance, not OpenAI API billing. The repository has a persistent Windows self-hosted runner named `cashin-codex-plus-windows`; the runner must be online and the signed-in Windows account must retain its Codex authentication. Keep one runner/job stream per `CODEX_HOME` so refreshed authentication is not used concurrently. The runner must not execute workflows from fork PRs. App-authored PR comments/reviews are the durable evidence ledger: markers include the full SHA and an input fingerprint; retries reuse terminal results and patch existing comments. Direct prompt-injection patterns fail as `INCONCLUSIVE`, but the heuristic cannot prove model immunity. The workflow never merges; final merge readiness and PM approval remain separate. See [`docs/hosted-agent-orchestration.md`](../../docs/hosted-agent-orchestration.md) for remaining validation. DEV-44 is not complete until the workflow runs successfully and its current evidence passes Merge Readiness.

## Verified CI execution context

For API and Web checks, the loader reads `GET /repos/{repository}/actions/jobs/{job_id}` and `/actions/runs/{run_id}` through the existing authenticated client. It accepts only GitHub Actions App `15368` with a repository-local details URL, then verifies job/check IDs, check-suite association, repository, PR association, `.github/workflows/ci.yml`, and exact HEAD SHA in both job and run (never substituting a PR merge SHA). Individual step names, states and conclusions let QA compare real test/no-skip step outcomes with the CI contract. Missing ownership/link metadata is explicitly unavailable; API errors, mismatches and unsupported sizes/formats stop evaluation. Failed, skipped or missing steps never become successful evidence.

The CI contract includes a workflow snapshot and API/Web package scripts loaded at that same SHA. Each snapshot retains the original source SHA-256; environment values are omitted while variable names/presence, PostgreSQL setup, test commands and the no-skip guard remain visible. Only scalar `env` mappings are supported; ambiguous YAML environment formats fail closed. Package dependencies and raw job logs are not sent to the model. Each configuration file is limited to 32 KB, each new API response to 100 KB with a 15-second timeout, and each job to 40 steps of at most 160 characters per name. These snapshots and step names are untrusted source and participate in the injection guard. The fingerprint includes step outcomes and original configuration hashes but omits job/run IDs, links and timestamps, preserving equivalent reruns. QA retains its own decision: metadata and configuration do not establish individual assertions or test counts, and missing evidence can still yield `INCONCLUSIVE`.

The six orchestration reader/publisher jobs and Merge Readiness evaluator use `actions: read` on their workflow `GITHUB_TOKEN` to reload the same evidence independently. This adds no App permission or secret. Other clients that validate context fingerprints need an existing read-only context token with access to Actions; a denied read fails closed.

## Requirements

- Node.js 22.12 or newer.
- The `CashIn -- DevAgents` GitHub App installed on the target repository with permission to read pull requests and create pull request conversation comments.
- The App ID and path to its private key. The installation ID is optional: the publisher discovers the installation for the configured repository when it is omitted.

## Local configuration

Copy `.env.example` to `.env` and set:

```dotenv
GITHUB_APP_ID=your-app-id
# Optional; leave blank to discover the installation from the repository.
GITHUB_APP_INSTALLATION_ID=
# Set this only when supplying the PEM as a protected runtime secret.
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_PRIVATE_KEY_PATH=C:\Users\your-user\secure-path\github-app.private-key.pem
GITHUB_REPOSITORY_OWNER=TitoStauffer
GITHUB_REPOSITORY_NAME=CashIn
```

The `.env` file is ignored by Git. Keep the `.pem` outside the repository, do not paste it into chat, and do not include it in logs or commits. Set either `GITHUB_APP_PRIVATE_KEY` as a protected runtime secret or use `GITHUB_APP_PRIVATE_KEY_PATH` for a local PEM file. The report publisher uses `@octokit/auth-app` to authenticate as the app, discover its repository installation when necessary, and create short-lived installation tokens in memory. Tokens are never written to files or logs.

## GitHub Actions secrets

The Merge Readiness workflow reads the App credentials from repository Actions secrets named `CASHIN_APP_ID`, `CASHIN_APP_INSTALLATION_ID`, and `CASHIN_APP_PRIVATE_KEY`. GitHub reserves secret names beginning with `GITHUB_`, so those names intentionally differ from the local `.env` variables above.

Install the package dependencies from this directory:

```powershell
npm ci
```

## Publish an agent report

Create a Markdown report file, then explicitly pass the target PR number, its current head commit SHA, agent role, and status:

```powershell
npm run publish-report -- --pr 42 --sha <current-head-sha> --agent qa --status APPROVED --report-file .\qa-report.md
```

Supported agent values and signatures:

| Value | Signature |
| --- | --- |
| `qualityGate` | Codex — Quality Gate Coordinator |
| `qa` | Codex — QA Agent |
| `pm` | Codex — PM Agent |

The command verifies that the PR is open and that its current head SHA matches the supplied SHA before posting. This prevents a report from being attached to a newer, unreviewed commit. The command creates a visible comment; run it only with the intended PR number. `--env-file`, `--owner`, and `--repository` can override the default configuration.

To check the CLI syntax without sending a request:

```powershell
npm run publish-report -- --help
```

## Verify access without posting

```powershell
npm run review -- verify --pr 11
```

This checks that the App credentials work and that the requested CashIn PR is open. It does not submit a review.

## Submit a formal review

The Code Review agent must complete its analysis first. Submit only its documented decision, with a body that matches that decision:

```powershell
npm run review -- submit --pr 11 --decision APPROVED --body-file .\review-summary.md
npm run review -- submit --pr 11 --decision CHANGES_REQUESTED --body-file .\review-summary.md
```

The body must contain `Code Review — APPROVED` or `Code Review — CHANGES_REQUESTED`, matching the selected decision. `INCONCLUSIVE` cannot be submitted as a formal approval or change request. The tool verifies the PR is open, pins the review to the latest head commit it read, and rejects an attempt by the app to approve its own PR. It reports the GitHub review URL on success.

The formal review command is unchanged and remains responsible only for Code Review decisions. It does not make the review decision. Never submit `APPROVED` when the Code Review agent found a blocking issue or could not complete its analysis. QA remains independent and required by the project workflow.

## Evaluate merge readiness

The read-only Merge Readiness Gate checks a specific PR and its current HEAD. It does not merge, post comments, or change Jira. Run it with an explicit PR number:

```powershell
npm run readiness -- --pr 26
```

The command prints one JSON object and uses these exit codes:

| Status | Exit code | Meaning |
| --- | ---: | --- |
| `READY_TO_MERGE` | 0 | All required evidence was confirmed for the current HEAD. This is a recommendation; it does not merge. |
| `BLOCKED` | 1 | A required check, review, report, protection rule, or PR condition failed or is missing. |
| `INCONCLUSIVE` | 2 | GitHub data could not be confirmed, including permission errors and API failures. |

The gate verifies current-head CI and Sonar checks, required contexts from branch protection/rulesets, formal Code Review approval, structured QA and Quality Gate Coordinator reports authored by this GitHub App, unresolved review threads, and whether the PR HEAD, base commit, metadata, exact diff, check summary, or `AGENTS.md` instructions changed during evaluation. A GitHub `mergeable_state` of `unstable` is not independently treated as a failure when GitHub confirms `mergeable: true`; the gate evaluates the required check results and formal approvals directly. Failed, missing, pending, or stale required evidence still blocks readiness. Agent evidence must include a marker bound to the full HEAD SHA and the current SHA-256 context fingerprint, in addition to the exact signature, `**Status:** APPROVED`, full 40-character `**Commit:**`, and a non-empty bullet list under `**Verificações de QA:**` (QA) or `**Checks verificados:**` (Quality Gate Coordinator). Any missing or stale evidence fails closed.

GitHub App access required for evaluation:

- Repository metadata: read.
- Pull requests: read (including formal reviews).
- Checks and commit statuses: read.
- Issue comments: read.
- Repository administration: read branch protection and rulesets.
- GraphQL access to pull request review threads.

The code-reviewer App token is short-lived and exists only in memory. If GitHub returns 403 or the repository plan/API does not expose branch protection or rulesets, the gate returns `INCONCLUSIVE`; it never assumes that protection is enabled. No permissions are changed by this tool.

Example JSON shape:

```json
{
  "status": "BLOCKED",
  "pullRequest": { "number": 26, "headSha": "<current-head-sha>" },
  "evaluatedAt": "<ISO-8601 timestamp>",
  "evidence": {},
  "reasons": [],
  "limitations": []
}
```

### GitHub Actions integration

`.github/workflows/merge-readiness.yml` invokes the same evaluator from the trusted `master` branch. It never checks out or runs code from a pull request, and it does not merge or change Jira. The workflow evaluates only open pull requests targeting `master`.

It runs after a PR opens, reopens, is edited, is synchronized, or becomes ready for review. It also runs when the `CI` or `PR title` workflow completes, after the GitHub App posts or edits a recognized QA, Quality Gate, PM, or Code Review report, and when a user manually dispatches the workflow with a PR number. New, edited, or dismissed formal reviews run `.github/workflows/pr-review-signal.yml`, which has no secrets, no token permissions, and no checkout; its completion triggers the trusted evaluator through `workflow_run`. The evaluator independently reads the formal review record. The report publisher must use the GitHub App installation token. Events created with `GITHUB_TOKEN` do not start another workflow.

For `workflow_run`, the workflow uses the single PR association included in the event payload, then re-reads the PR from GitHub and confirms it is still open and targets `master`. The evaluator always reads the current PR HEAD and verifies it again after collecting evidence; it does not assume the completed CI or review signal belongs to the latest SHA. Ambiguous associations produce `INCONCLUSIVE`. Events that do not map to an eligible PR are summarized as skipped. API failures produce `INCONCLUSIVE` when a PR SHA is known.

All gate runs for one PR share a concurrency group and are serialized rather than canceling the active run. This prevents an older evaluation from publishing its status after a newer run for the same PR.

The evaluator publishes the `Merge Readiness` commit status directly on the evaluated HEAD SHA. `READY_TO_MERGE` maps to `success`, `BLOCKED` to `failure`, and `INCONCLUSIVE` to `error`. The job summary includes the SHA, evidence, reasons, and limitations. The evaluator excludes its own `Merge Readiness` context from required-check dependencies to avoid a circular check. The status is a readiness report; GitHub prevents merges only if the repository has configured an applicable branch protection rule or ruleset that requires it.

#### GitHub Actions configuration

Set these repository Actions secrets:

| Secret | Value |
| --- | --- |
| `CASHIN_APP_ID` | App ID for `CashIn -- DevAgents` |
| `CASHIN_APP_INSTALLATION_ID` | Installation ID for the CashIn repository |
| `CASHIN_APP_PRIVATE_KEY` | Full PEM private key, stored as a secret (newlines may be escaped as `\\n`) |

The workflow uses the existing repository variable `CASHIN_APP_BOT_LOGIN` to filter evidence comments. The local CLI continues to use `GITHUB_APP_*` names in `.env`; only GitHub Actions secrets use the `CASHIN_APP_*` names above. Read-only review inputs (diff, checks, Actions job/run evidence, CI snapshots, and `AGENTS.md` at the PR base SHA) use the workflow `GITHUB_TOKEN`, which needs `contents: read`, `pull-requests: read`, `checks: read`, and `actions: read`; Merge Readiness also needs `statuses: write`. The App installation token is used for formal reviews and comments. No new GitHub App permissions or secrets are required by this change.

If the App secrets are missing, the workflow reports `INCONCLUSIVE` instead of treating the gate as approved. If GitHub returns 403 for checks, statuses, branch protection, or rulesets, the workflow also reports `INCONCLUSIVE`. This repository has previously received 403 responses for branch protection and rulesets. Until the App can read these resources and the current private-repository plan exposes the required policy data, `READY_TO_MERGE` cannot be confirmed. No merge is attempted by this workflow.

To run it manually, open **Actions → Merge Readiness → Run workflow**, enter the PR number, and start the run. To validate the real event automation, open a later PR after this workflow is merged into `master`; a workflow added only on its own feature branch cannot serve as the trusted workflow source for `pull_request_target` or `workflow_run`.

### Validate hosted agent orchestration

Use an open pull request targeting `master`. A successful `CI` or `PR title` completion triggers evaluation by `Codex Agent Orchestration`; `agent-stage-cli.ts` starts a model only after all required CI/Sonar evidence has passed for the PR HEAD. An early title-triggered evaluation can therefore stop safely while CI is pending; CI completion triggers a new evaluation. The first job runs on the self-hosted Windows runner labeled `codex-plus`; subsequent jobs publish the formal Code Review and the QA and Quality Gate Coordinator reports through the GitHub App. For recovery, open **Actions → Codex Agent Orchestration → Run workflow**, select `master`, enter the open PR number, and start the run. The trigger and job sequence are defined in `.github/workflows/agent-orchestration.yml`.

For an end-to-end check, confirm that the workflow run resolves to the intended open PR, then compare the SHA in every agent report with the PR's current HEAD. After the reports are published, inspect the `Merge Readiness` check and its JSON summary for the same SHA. A skipped orchestration, missing report, stale SHA, runner failure, or `INCONCLUSIVE` readiness result is a validation failure or an explicit blocker; do not replace it with a manual approval. If the PR head changes, wait for the new CI-triggered run and evaluate the new SHA. Keep a validation PR unmerged until the project owner decides otherwise.

This process validates the hosted workflow and integrations, not the safety of merging arbitrary pull request code on the self-hosted runner. The workflows must continue to execute trusted code from `master` and must not check out or run PR-controlled scripts with access to the runner's local Codex credentials.

## Verify

```powershell
npm test
```
