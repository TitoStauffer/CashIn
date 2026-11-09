# CashIn -- DevAgents GitHub Publisher

This local tool publishes agent reports as comments on CashIn pull requests using the `CashIn -- DevAgents` GitHub App. It also retains the existing formal Code Review command. The shared report publisher supports the Code Review Agent (for inconclusive reports only), Quality Gate Coordinator, QA Agent, and PM Agent; reports use distinct signatures.

It does not merge pull requests or change GitHub App permissions. The existing formal review flow remains separate from report comments.

## Hosted agent orchestration status

`src/agent-orchestrator.ts` contains the provider-neutral sequencing core for Code Review, QA, and Quality Gate Coordinator. It describes the `full` track only: the review track is decided by the production stage CLI, so that module always sequences QA and is not the file to read for track behaviour. `src/review-track.ts` classifies each round as `full` or `light` from the changed-file list the privileged job reads from the API: a change is `light` only when every changed file is `*.md`, `*.test.*` or `docs/knowledge/context-map.json`, and `full` otherwise — migrations, manifests, lockfiles, Dockerfiles, `compose.yaml`, fixtures, workflows and the readiness evaluator included. The `light` track skips QA only — the single model stage on the serialized runner — while CI, Code Review and the deterministic Coordinator run on both. An empty or unusable list classifies as `full`, and the Coordinator refuses to decide without the list; `Merge Readiness` recomputes the track itself and blocks when it changes during an evaluation. See [review tracks](../../docs/hosted-agent-orchestration.md#review-tracks). `src/claude-cli-agent.ts` adapts Code Review and QA to the Claude Code CLI, the default runtime (`AGENT_RUNTIME=claude`): it reuses the same prompt and output schema and runs isolated — no tools, MCP servers, hooks, auto-memory, `CLAUDE.md` or default system prompt, in an empty temporary directory — and rejects the result unless the session `init` event confirms no tools beyond the CLI-internal `StructuredOutput`, no MCP servers and no executed hooks. `src/codex-cli-agent.ts` remains as the fallback (`AGENT_RUNTIME=codex`) and adapts Code Review and QA to the Codex CLI, using the signed-in ChatGPT account, a read-only sandbox, and `--disable shell_tool` so the model cannot issue commands on the runner. The workflow runs only after the complete `CI` workflow succeeds on an internal PR, or through manual dispatch from `master`. CI sequences PR metadata validation, API/Web/automation tools (the `GitHub Reviewer` check) and SonarQube before emitting that signal. Before loading review context or calling an Agent, the stage compares the current base and HEAD and rejects branches that are `behind`, `diverged`, or unconfirmed. Metadata edits run a trusted title workflow with no PR checkout. Human edits that change title or substantive body content rerun CI for the current HEAD after validation; proven checkbox-only edits and App checklist edits skip recovery and do not retrigger agents. The CI title job reads live PR metadata so title corrections recover an initially blocked run. Agent jobs (Claude Code by default, Codex as the fallback) run on the self-hosted Windows runner without GitHub App credentials; separate GitHub-hosted jobs publish validated results and synchronize only the approval checkbox owned by each stage after reloading and revalidating the current PR. Trusted checkouts pin `actions/checkout` v7.0.1, pass the workflow token explicitly, and set `persist-credentials: false`. The workflow does not merge or modify Jira.

The hosted Code Review is instructed to inspect the complete supplied diff, related source snapshots, acceptance criteria, affected contracts, and tests before deciding. It must continue after finding an issue and consolidate every proven finding from that round in one report, including the reviewed areas with no relevant blockers.

The context contains complete changed text files and direct local TypeScript dependencies at the exact HEAD (base for removed files), current-SHA check-run metadata, and the API-confirmed formal Code Review before QA/Coordinator. Generated `test/fixtures/*.json.gz.base64` payloads are the only exception: the prompt receives their path, UTF-8 size and SHA-256 instead of duplicating the encoded archive in both diff and source snapshots; the test suite still decodes and validates the committed fixture. Before inspecting those sources, the loader reads the versioned knowledge vault index, current state and context map at the PR HEAD, then selects notes for the changed paths. Exact local files cited by those notes and same-repository GitHub review evidence with a verifiable review/comment identifier are included as untrusted reference data. Directory references, unsafe paths, malformed maps and unavailable required sources fail closed. Changes are limited to 32 files, dependencies to 64 additional files, and combined source snapshots to 500 KB (500,000 UTF-8 bytes, inclusive). Vault context has its own limit of 160 items and 650 KB. Inside it, the vault's own documents, the context map and the GitHub review evidence are required and still fail closed, naming the document that did not fit. A source file a note merely cites is optional: when its body does not fit, the snapshot carries a marker with its path, UTF-8 size and SHA-256 instead of the content, so the budget costs that citation's body rather than the whole review, and the citation is still verified at the PR HEAD. The budget is allocated by priority, not by arrival order: because the link traversal interleaves cited sources with notes reached by link and the GitHub evidence is read last, a required item that does not fit takes the body of the optional snapshots already admitted, largest first so the fewest citations lose one, until it fits; only then does it fail closed. An optional snapshot whose own marker does not fit reclaims from them too, smallest body first because the need is only the marker, and a body smaller than its marker is never taken, since releasing it would add bytes instead of freeing them. Every refusal names the ceiling that rejected the candidate (`item` or `byte`) and, except for the evidence count projected before any download, the file's path. Demotion frees bytes, never items, so the item ceiling still fails closed on its own. Such a marker never suppresses the same file's changed-source snapshot, so a changed file keeps its full body. Each GitHub response the vault loader reads is limited to 400 KB, which leaves an effective ceiling of about 300 KB of source because `/contents` returns base64. A source already supplied by the vault is not serialized twice; an unchanged `AGENTS.md` snapshot identical to the trusted base policy is likewise omitted, while a changed version remains available for review. The complete final prompt is limited to 2 MB for Claude Code (1M-token window) and 750 KB for the Codex fallback. Exceeding a limit fails closed without truncating sources; the vault's optional cited sources are the single exception, and their bodies are replaced whole by the marker above rather than truncated. Source snapshots are never executed. Both runtimes run from an isolated empty temporary directory (Codex with the Git repository check explicitly skipped), preventing an implicit second load of repository instructions; the trusted base `AGENTS.md` remains present in the prompt. Safe CLI error events are retained for diagnostics without echoing arbitrary model output. The fingerprint ignores checkbox marks and check URLs/timestamps; changes to requirements, code, base SHA, vault context or check outcomes still invalidate evidence. This prevents checklist maintenance and identical check retries from consuming another model round. The injection heuristic scans only PR title, description and newly added diff lines; source, vault and CI snapshots remain untrusted model context but are not scanned by this heuristic.

## Versioned knowledge vault

When `docs/knowledge/README.md` exists, the hosted Agents use the vault as their first context source. `docs/knowledge/current-state.md` is mandatory, while `docs/knowledge/context-map.json` is optional and has this deterministic format:

```json
{
  "version": 1,
  "catalogs": ["docs/knowledge/evidence/source-index.md"],
  "routes": [
    {
      "paths": ["apps/api/src/**"],
      "documents": ["docs/knowledge/domains/backend.md"]
    }
  ]
}
```

Route patterns support `*` inside one path segment and `**` across segments. Documents selected by changed paths must remain under `docs/knowledge/` and use Markdown. The index and current state are always loaded, but links from these navigation roots do not expand other vault notes; the context map and changed vault files select those notes explicitly. References inside selected notes are traversed as a bounded, deduplicated graph so their evidence is verified. Documents declared in `catalogs` are metadata indexes: their own content participates in the fingerprint when selected, but outbound links are navigational and are not hydrated automatically. An Agent must query an original catalog source separately before using it as decision evidence. Single-line inline links (including angle-bracket destinations, balanced parentheses, optional titles and labels formatted as inline code) and links by reference may cite exact repository files or a same-repository GitHub review, inline review comment, or PR conversation comment. Unsupported or malformed inline links and undefined or conflicting reference definitions fail closed. Remote evidence is accepted only after its identifier, canonical URL and PR association match the cited link. The resolver never follows arbitrary web links, never executes vault content and never accepts a directory as source context.

The `GitHub Reviewer` CI job runs `tools/knowledge/validate-vault.ps1` whenever the vault is present. A missing validator or an invalid vault blocks the check. Confirmed Code Review problems must be recorded during the correction round in the appropriate file under `docs/knowledge/learnings/`, with review reference, affected SHA, impact, applied correction and prevention, before requesting a new review. Hypotheses, false positives, inconclusive findings and style preferences are not learnings. The Agent technical owner performs and validates this update; CI and the Code Review Agent do not commit changes automatically.

The gate fetches individual ruleset details: the list endpoint returns summaries without rules. For a single-maintainer repository using App reviews, require the `Merge Readiness` status together with all CI/Sonar checks. That status independently requires the App's formal current-SHA approval plus a structured Coordinator approval, and a structured QA approval when the review track is `full`. GitHub's separate human-review count can be zero in this configuration; the formal App review remains mandatory in the gate. A required gate can make GitHub report `blocked` until the gate itself passes. This aggregate state is ignored only for that self-required, ruleset-only configuration with no human count, code-owner/last-push requirement, designated reviewers or unsupported rule types. All individual evidence checks still apply. Opaque classic-protection blocks and unsupported rules stay blocked. There are no bypass actors and the workflow does not merge.

Claude Code (default) uses the maintainer's Claude subscription and the Codex CLI (fallback) uses the ChatGPT Plus allowance; neither uses API keys. The repository has a persistent Windows self-hosted runner named `cashin-codex-plus-windows`; the runner must be online and the signed-in Windows account must retain its Claude Code authentication (Claude subscription) for the default runtime. Only when `AGENT_RUNTIME=codex` is selected must that account also retain its Codex authentication, keeping one runner/job stream per `CODEX_HOME` so refreshed authentication is not used concurrently. The runner must not execute workflows from fork PRs. App-authored PR comments/reviews are the durable evidence ledger: markers include the full SHA and an input fingerprint; retries reuse valid results, including INCONCLUSIVE and patch existing comments. Direct prompt-injection patterns fail as `INCONCLUSIVE`, but the heuristic cannot prove model immunity. The workflow never merges; final merge readiness and PM approval remain separate. See [`docs/hosted-agent-orchestration.md`](../../docs/hosted-agent-orchestration.md) for remaining validation. DEV-44 is not complete until the workflow runs successfully and its current evidence passes Merge Readiness.

## Verified CI execution context

For API, Web and automation-tools checks, the loader reads `GET /repos/{repository}/actions/jobs/{job_id}` and `/actions/runs/{run_id}` through the existing authenticated client. It accepts only GitHub Actions App `15368` with a repository-local details URL, then verifies job/check IDs, check-suite association, repository, PR association, `.github/workflows/ci.yml`, and exact HEAD SHA in both job and run (never substituting a PR merge SHA). Individual step names, states and conclusions let QA compare real test/no-skip step outcomes with the CI contract, including `Build and test GitHub integration tools` for this package. Missing ownership/link metadata is explicitly unavailable; API errors, mismatches and unsupported sizes/formats stop evaluation. Failed, skipped or missing steps never become successful evidence. The `GitHub Reviewer` check is configured for every PR in the current CI and is required in both the agent prerequisite summary and Merge Readiness: a missing, stale, pending, failed, skipped or incorrectly owned check cannot satisfy that prerequisite. `Automation Tools` is accepted as a rollout-compatible alias.

The CI contract includes four snapshots loaded at that same SHA: the CI workflow and scripts from `apps/api/package.json`, `apps/web/package.json` and `tools/github-reviewer/package.json`. Each snapshot retains the original source SHA-256; environment values are omitted while variable names/presence, PostgreSQL setup, test commands and the no-skip guard remain visible. Only scalar `env` mappings are supported; ambiguous YAML environment formats fail closed. Package dependencies and raw job logs are not sent to the model. The context supports three CI jobs; each configuration file is limited to 32 KB, each new API response to 100 KB with a 15-second timeout, and each job to 40 steps of at most 160 characters per name. An empty step list is re-read up to four times, three seconds apart, because the orchestration starts from the CI `workflow_run` event and `/actions/jobs/{id}` can still answer `steps: []` after the job's conclusion is published; a list still empty once the attempts run out remains a refusal, and an absent or non-array `steps` is refused on the first read as a malformed payload. Absent, empty and excessive step lists each report their own message. These snapshots and step names are untrusted model context and participate in the durable fingerprint, but the injection heuristic is intentionally limited to newly introduced PR content. The fingerprint includes step outcomes and original configuration hashes but omits job/run IDs, links and timestamps, preserving equivalent reruns. QA retains its own decision: metadata and configuration do not establish individual assertions or test counts, and missing evidence can still yield `INCONCLUSIVE`.

Before redaction, the workflow must match the supported block-style subset: simple mapping keys, plain scalar lists, single-line quoted values and indented `|`/`>` scalar blocks. Flow mappings at any depth (including root JSON), complex/quoted keys and multiline quoted values are rejected before any snapshot is returned. Outside scalar blocks, braces are accepted only in single-line GitHub expressions without nested braces. Scripts inside scalar blocks and the current CI expressions remain intact; other valid YAML formats may fail closed deliberately.

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

The formal review command is unchanged and remains responsible only for Code Review decisions. It does not make the review decision. Never submit `APPROVED` when the Code Review agent found a blocking issue or could not complete its analysis. QA remains independent of this command: a formal Code Review approval never covers it. The project workflow requires it when the review track is `full`.

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

The gate verifies current-head CI and Sonar checks, required contexts from branch protection/rulesets, formal Code Review approval, a structured Quality Gate Coordinator report authored by this GitHub App on both tracks plus a structured QA report when the review track is `full`, unresolved review threads, and whether the PR HEAD, base commit, metadata, exact diff, check summary, or `AGENTS.md` instructions changed during evaluation. A GitHub `mergeable_state` of `unstable` is not independently treated as a failure when GitHub confirms `mergeable: true`; the gate evaluates the required check results and formal approvals directly. Failed, missing, pending, or stale required evidence still blocks readiness. Agent evidence must include a marker bound to the full HEAD SHA and the current SHA-256 context fingerprint, in addition to the exact signature, `**Status:** APPROVED`, full 40-character `**Commit:**`, and a non-empty bullet list under `**Verificações de QA:**` (QA) or `**Checks verificados:**` (Quality Gate Coordinator). Any missing or stale evidence fails closed, with one exception that the review track defines: on the `light` track the QA report is not required, and a QA report that is missing, bound to another SHA or context, or unstructured is treated as absent rather than as a blocker. A QA report that does belong to the current SHA and context and is not approved still blocks on either track.

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

It runs after a PR opens, reopens, is edited, is synchronized, or becomes ready for review. It also runs when the `CI` workflow completes, after the GitHub App posts or edits a recognized QA, Quality Gate, PM, or Code Review report, and when a user manually dispatches the workflow with a PR number. New, edited, or dismissed formal reviews run `.github/workflows/pr-review-signal.yml`, which has no secrets, no token permissions, and no checkout; its completion triggers the trusted evaluator through `workflow_run`. The evaluator independently reads the formal review record. The report publisher must use the GitHub App installation token. Events created with `GITHUB_TOKEN` do not start another workflow.

For `workflow_run`, the workflow uses the single PR association included in the event payload, then re-reads the PR from GitHub and confirms it is still open and targets `master`. The evaluator always reads the current PR HEAD and verifies it again after collecting evidence; it does not assume the completed CI or review signal belongs to the latest SHA. Ambiguous associations produce `INCONCLUSIVE`. Events that do not map to an eligible PR are summarized as skipped. API failures produce `INCONCLUSIVE` when a PR SHA is known.

All gate runs for one PR share a concurrency group and are serialized rather than canceling the active run. This prevents an older evaluation from publishing its status after a newer run for the same PR.

The evaluator publishes the `Merge Readiness` commit status directly on the evaluated HEAD SHA. `READY_TO_MERGE` maps to `success`, `BLOCKED` to `failure`, and `INCONCLUSIVE` to `error`. The Actions job succeeds when evaluation and status publication complete; the stable commit status is the only readiness decision and remains fail-closed. This prevents an older failed evaluator job from blocking a HEAD whose canonical status was later updated with complete evidence. Infrastructure or status-publication failures still fail the job. The job summary includes the SHA, evidence, reasons, and limitations. The evaluator excludes its own `Merge Readiness` context from required-check dependencies to avoid a circular check. GitHub prevents merges only if the repository has configured an applicable branch protection rule or ruleset that requires the status.

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

Use an open pull request targeting `master`. Only a successful, complete `CI` run triggers `Codex Agent Orchestration`; `agent-stage-cli.ts` revalidates all required CI/Sonar evidence for the PR HEAD before starting a model. A running orchestration is allowed to finish; repeated events wait and reuse published evidence. Each stage still rejects an obsolete SHA/context. The first job runs on the self-hosted Windows runner labeled `codex-plus`; subsequent jobs publish the formal Code Review and the deterministic Quality Gate Coordinator report through the GitHub App, plus the QA report when the review track is `full`. Code Review and QA update only their own template checkboxes after current-context publication; non-approved results clear the corresponding checkbox, and on the `light` track the QA checkbox stays unmarked because the stage never runs. After resolving an INCONCLUSIVE blocker with unchanged inputs, open **Actions → Codex Agent Orchestration → Run workflow**, select `master`, enter the open PR number, select `retry_inconclusive`, and start the run. Without this explicit option, unchanged INCONCLUSIVE evidence is reused. APPROVED and CHANGES_REQUESTED evidence is not forcibly rerun. The trigger and job sequence are defined in `.github/workflows/agent-orchestration.yml`.

If analysis completed and only publication failed, do not rerun the orchestration. Open **Actions → Recover Agent Report Publication**, provide the original orchestration run ID, PR number and failed publication stage. Before downloading anything, recovery verifies through the Actions API that the run came from `.github/workflows/agent-orchestration.yml` on `master`, correlates each artifact timestamp with the job attempt that produced it, and selects the artifact ID from the latest successful attempt. Ambiguous, expired, empty or unauthenticated artifacts fail closed. The publisher then binds its structured evidence to the requested PR, current HEAD and context fingerprint. Recovery invokes no model call.

## Structured round preflight

Code Review results include every changed file, all six risk areas and typed findings. QA results include every acceptance criterion with status and evidence. Missing coverage fails closed. The same validator can be run before push against a prepared result:

```powershell
$env:AGENT_STAGE = 'codeReview' # or qa / qualityGate
$env:EXPECTED_COMMIT_SHA = '<full 40-character PR HEAD SHA>'
$env:AGENT_RESULT_PATH = 'agent-result.json'
$env:CHANGED_FILES_PATH = 'changed-files.txt'
$env:PR_BODY_PATH = 'pr-body.md'
npm run preflight-result
```

`changed-files.txt` contains one repository-relative path per line. The command validates the complete untrusted JSON envelope, requires a known stage and decision, compares the result with the independently supplied PR HEAD SHA and validates all structured evidence. It does not call a model, publish, approve, merge or modify Jira.

For an end-to-end check, confirm that the workflow run resolves to the intended open PR, then compare the SHA in every agent report with the PR's current HEAD. After the reports are published, inspect the `Merge Readiness` check and its JSON summary for the same SHA. A skipped orchestration, stale SHA, runner failure, or `INCONCLUSIVE` readiness result is a validation failure or an explicit blocker; do not replace it with a manual approval. A missing report is a blocker too, except for the QA report on the `light` track, where its absence is the expected outcome. If the PR head changes, wait for the new CI-triggered run and evaluate the new SHA. Keep a validation PR unmerged until the project owner decides otherwise.

This process validates the hosted workflow and integrations, not the safety of merging arbitrary pull request code on the self-hosted runner. The workflows must continue to execute trusted code from `master` and must not check out or run PR-controlled scripts with access to the runner's local Claude Code or Codex credentials.

## Verify

```powershell
npm test
```

### Execution economy (DEV-70)

Every reader and publisher in one orchestration leaves `ref` unset in `actions/checkout`, so the action uses the trusted event context: the `master` ref plus the immutable workflow-run SHA, or the explicitly selected `master` ref in a manual dispatch. Passing a raw SHA as `ref` is intentionally avoided because it loses the named ref during checkout validation on the Windows runner. The manual guard still rejects dispatches outside `refs/heads/master`, and moving `master` between jobs cannot silently replace the event SHA. The Coordinator runs on GitHub-hosted Ubuntu without model or App credentials and verifies the current structured formal review, CI and Sonar evidence, plus QA when the review track is `full`. It recomputes the track from the same changed-file list rather than reading it from any report. It does not execute behavioral tests or infer QA acceptance from green CI.

Stage outputs and summaries expose `execution_source` (`model`, `reused`, `deterministic`) and `model_calls` (0 or 1); these measure invocations, not token billing. Merge Readiness evaluates after CI, after a formal review changes, after the current Coordinator report, or by manual dispatch. Intermediate Code Review/QA comments and metadata-only validation no longer create equivalent evaluations. Runs before the Coordinator report fail closed without a full evidence scan; final reports and manual dispatch perform full evaluation. A current report candidate never grants approval by itself. If a stage command fails before producing a decision and SHA, a final guard marks that stage job failed after the optional artifact upload, so GitHub can rerun the actual failed job and its dependants.

Local tests use simulated APIs and do not prove hosted rollout. New runtime behavior becomes active after this PR is integrated; this PR itself is reviewed using the existing trusted runtime. No paid API or merge bypass is introduced.
