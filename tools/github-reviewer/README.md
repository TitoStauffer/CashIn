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

## Verify

```powershell
npm test
```
