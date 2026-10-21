# Hosted PR quality orchestration

## Current state

`tools/github-reviewer/src/agent-orchestrator.ts` implements the provider-neutral orchestration policy. It requires current-head CI and Sonar evidence, runs Code Review before QA, requires a formal GitHub Code Review decision before QA, and runs the Quality Gate Coordinator only after QA approves. Each agent result must identify the same full commit SHA and include a report. The current HEAD is re-read before and after agent execution, stale evidence is rejected, and failures return `INCONCLUSIVE` without proceeding to dependent stages.

The orchestrator receives infrastructure adapters for GitHub, execution locking, agent execution, and report publication. It does not load a model SDK, contact an AI service, create a GitHub review on its own, or merge a pull request. Tests use adapter fakes and do not represent hosted validation.

**Hosted agent execution is not enabled yet.** The repository currently has no configured agent execution provider or provider credentials. Per the cost decision for DEV-44, no billable model calls or billing setup are permitted. Therefore this code is a tested orchestration core, not proof that GitHub Actions can execute real agents. DEV-44 must remain open until a hosted provider is explicitly selected, configured, and validated end to end.

## Required adapter contracts

A hosted runtime must implement the `AgentOrchestratorDependencies` interface and provide:

- `readHeadSha` and `readPrerequisites` using GitHub evidence for the target PR.
- `claimExecution` and `releaseExecution` with durable per-repository/PR/SHA deduplication, concurrency control, bounded leases, and recovery after a runner is interrupted.
- `executeAgent` for the independently authorized Code Review, QA, and Quality Gate Coordinator roles. It must return a structured decision, exact SHA, and Markdown evidence.
- `submitFormalCodeReview` using a GitHub identity authorized to review and distinct from the PR author. The review body carries the Code Review findings; report comments alone are not formal reviews.
- `publishReport` by reusing the DEV-40 publisher for QA and Quality Gate Coordinator reports; it must re-check the PR head before publishing.

No adapter may receive a credential that is unnecessary for its role. Untrusted PR code must never run in a privileged job. A model/agent adapter should receive only the diff and the read-only context needed for analysis, not execute PR scripts. GitHub App credentials must be isolated to the narrowly scoped action that submits a review or publishes a report.

## Activation checklist

1. Choose a hosted agent runtime and document its account model, cost/billing behavior, data handling, timeouts, and cancellation semantics.
2. Confirm that it can issue three independent roles and that the Code Review identity can create a formal review without approving its own PR.
3. Configure the required repository/workspace credentials and minimum GitHub App permissions outside this code change.
4. Implement the runtime adapters and a trusted GitHub Actions workflow that uses only trusted workflow code, serializes runs per PR, and binds every result to the current SHA.
5. Validate a low-risk test PR end to end, including new-SHA invalidation, duplicate event handling, formal review, report publication, and Merge Readiness re-evaluation.
6. Only then document the workflow as active and close DEV-44. Do not enable merge automation as part of this work.

## Local tests

From `tools/github-reviewer`:

```powershell
npm ci
npm test
```

These tests validate sequencing and fail-closed behavior using fakes. They do not make network requests, publish GitHub reviews/comments, invoke a hosted agent, or incur model costs.
