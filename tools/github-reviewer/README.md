# GitHub App Reviewer

This local tool submits a formal GitHub pull request review as the CashIn Code Reviewer app. It is intentionally limited to `TitoStauffer/CashIn`; it does not merge pull requests, change branch protection, or post general PR comments.

## Requirements

- Node.js 22.12 or newer.
- The `CashIn Code Reviewer` GitHub App installed with **Pull requests: Read and write** access to the `CashIn` repository.
- The App ID, installation ID, and path to its private key.

## Local configuration

Copy `.env.example` to `.env` and set:

```dotenv
GITHUB_APP_ID=your-app-id
GITHUB_APP_INSTALLATION_ID=your-installation-id
GITHUB_APP_PRIVATE_KEY_PATH=C:\Users\your-user\secure-path\github-app.private-key.pem
```

The `.env` file is ignored by Git. Keep the `.pem` outside the repository, do not paste it into chat, and do not include it in logs or commits. The tool reads the private key locally and creates a short-lived installation token when submitting a review.

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

The tool does not make the review decision. Never submit `APPROVED` when the Code Review agent found a blocking issue or could not complete its analysis. QA remains independent and required by the project workflow.

## Verify

```powershell
npm test
```
