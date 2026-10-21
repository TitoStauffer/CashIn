# CashIn -- DevAgents GitHub Publisher

This local tool publishes agent reports as comments on CashIn pull requests using the `CashIn -- DevAgents` GitHub App. It also retains the existing formal Code Review command. The shared report publisher supports the Quality Gate Coordinator, QA Agent, and PM Agent; their reports appear under the same GitHub App identity with distinct signatures.

It does not merge pull requests or change GitHub App permissions. The existing formal review flow remains separate from report comments.

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

The gate verifies current-head CI and Sonar checks, required contexts from branch protection/rulesets, formal Code Review approval, structured QA and Quality Gate Coordinator reports authored by this GitHub App, unresolved review threads, and whether the PR head changed during evaluation. Its structured reports must include the exact agent signature, `**Status:** APPROVED`, a full 40-character `**Commit:**` SHA, and a non-empty bullet list under `**Verificações de QA:**` (QA) or `**Checks verificados:**` (Quality Gate Coordinator). Any missing or stale evidence fails closed.

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

It runs after a PR opens, reopens, is edited, is synchronized, or becomes ready for review. It also runs when the `CI` workflow completes, after the GitHub App posts or edits a recognized QA, Quality Gate, PM, or Code Review report, and when a user manually dispatches the workflow with a PR number. The formal Code Review Agent's report comment is the re-evaluation signal for its formal review; the evaluator independently reads the formal review record. The report publisher must use the GitHub App installation token. Events created with `GITHUB_TOKEN` do not start another workflow.

For `workflow_run`, the workflow resolves the PR from the CI commit SHA using the GitHub API, then confirms the PR is still open, targets `master`, and points to that SHA. Events that do not map to an eligible PR are summarized as skipped. API failures produce `INCONCLUSIVE` when a PR SHA is known.

The evaluator publishes the `Merge Readiness` commit status directly on the evaluated HEAD SHA. `READY_TO_MERGE` maps to `success`, `BLOCKED` to `failure`, and `INCONCLUSIVE` to `error`. The job summary includes the SHA, evidence, reasons, and limitations. The evaluator excludes its own `Merge Readiness` context from required-check dependencies to avoid a circular check. The status is a readiness report; GitHub prevents merges only if the repository has configured an applicable branch protection rule or ruleset that requires it.

#### GitHub Actions configuration

Set these repository Actions secrets:

| Secret | Value |
| --- | --- |
| `GITHUB_APP_ID` | App ID for `CashIn -- DevAgents` |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID for the CashIn repository |
| `GITHUB_APP_PRIVATE_KEY` | Full PEM private key, stored as a secret (newlines may be escaped as `\\n`) |

The workflow uses the existing repository variable `CASHIN_APP_BOT_LOGIN` to filter evidence comments. The `GITHUB_TOKEN` permissions are limited to repository contents read, pull requests read, and commit statuses write. The GitHub App still needs the read permissions listed above; no permissions or secrets are changed by this implementation.

If the App secrets are missing, the workflow reports `INCONCLUSIVE` instead of treating the gate as approved. If GitHub returns 403 for checks, statuses, branch protection, or rulesets, the workflow also reports `INCONCLUSIVE`. This repository has previously received 403 responses for branch protection and rulesets. Until the App can read these resources and the current private-repository plan exposes the required policy data, `READY_TO_MERGE` cannot be confirmed. No merge is attempted by this workflow.

To run it manually, open **Actions → Merge Readiness → Run workflow**, enter the PR number, and start the run. To validate the real event automation, open a later PR after this workflow is merged into `master`; a workflow added only on its own feature branch cannot serve as the trusted workflow source for `pull_request_target` or `workflow_run`.

## Verify

```powershell
npm test
```
