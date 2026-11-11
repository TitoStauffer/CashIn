import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { describe, it } from "node:test";
import { declaresLightTrack, type PostMergeEvidence } from "../src/post-merge/service.js";

// DEV-122: the line that declares the review track is written by one package and read by another, and the
// two have no dependency on each other. The dispatcher's own tests build the Coordinator body by hand, so
// they only ever proved the regex against text the test itself wrote. Here the body comes from the
// producer's real code — `evaluateDeterministicQualityGate` and `formatPullRequestReport` — so changing the
// format on either side without the other fails this file. If the light track stopped being recognised,
// every light-track delivery would stop closing in Jira, silently.
//
// The producer is loaded from its compiled output, which CI builds in the same job before this suite runs.
// The import is dynamic because that output ships no type declarations.
const producerDist = new URL("../../github-reviewer/dist/", import.meta.url);

type Producer = {
  evaluateDeterministicQualityGate: (input: Record<string, unknown>) => {
    decision: string; reviewTrack: string; reportMarkdown: string; evidence: unknown;
  };
  formatPullRequestReport: (report: Record<string, unknown>) => string;
  formatFormalReviewEvidence: (result: Record<string, unknown>) => string;
  REVIEW_RISK_AREAS: string[];
};

async function loadProducer(): Promise<Producer> {
  const modules = ["agent-stage-policy.js", "github-report-publisher.js", "agent-evidence.js", "agent-result-validation.js"];
  for (const name of modules) {
    try {
      await access(new URL(name, producerDist));
    } catch {
      throw new Error(`tools/github-reviewer/dist/${name} não existe: rode "npm run build" em tools/github-reviewer antes desta suíte.`);
    }
  }
  const [policy, publisher, evidence, validation] = await Promise.all(modules.map((name) => import(new URL(name, producerDist).href)));
  return {
    evaluateDeterministicQualityGate: policy.evaluateDeterministicQualityGate,
    formatPullRequestReport: publisher.formatPullRequestReport,
    formatFormalReviewEvidence: evidence.formatFormalReviewEvidence,
    REVIEW_RISK_AREAS: validation.REVIEW_RISK_AREAS,
  };
}

const BOT_LOGIN = "cashin-devagents[bot]";
const SHA = "a".repeat(40);
const CONTEXT_HASH = "b".repeat(64);

/** The Coordinator comment exactly as the publisher writes it, for a round whose changed files are `changedFiles`. */
async function coordinatorComment(changedFiles: string[]): Promise<{ track: string; comment: { user: { login: string }; created_at: string; body: string } }> {
  const producer = await loadProducer();
  const context = { commitSha: SHA, contextHash: CONTEXT_HASH, botLogin: "cashin-devagents", changedFiles, acceptanceCriteria: ["Preservar contrato"] };
  const stageResult = (stage: "codeReview" | "qa") => ({
    stage, decision: "APPROVED", commitSha: SHA, contextHash: CONTEXT_HASH,
    reportMarkdown: stage === "qa" ? "**Verificações de QA:**\n- Contrato validado." : "### Code Review — APPROVED\nAnálise completa.",
    evidence: {
      reviewComplete: true, changedFilesReviewed: changedFiles,
      riskAreas: producer.REVIEW_RISK_AREAS.map((area) => ({ area, status: "REVIEWED", evidence: "Analisado no diff." })),
      findings: [],
      acceptanceCriteria: stage === "qa" ? [{ criterion: "Preservar contrato", status: "PASSED", evidence: "Teste de contrato." }] : [],
    },
  });
  const codeReview = stageResult("codeReview");
  const qa = stageResult("qa");
  const qaComment = {
    user: { login: BOT_LOGIN }, updated_at: "2026-11-01T10:00:00Z",
    body: producer.formatPullRequestReport({ agentName: "qa", pullRequestNumber: 1, commitSha: SHA, contextHash: CONTEXT_HASH, status: "APPROVED", reportMarkdown: qa.reportMarkdown, evidence: qa.evidence }),
  };
  const outcome = producer.evaluateDeterministicQualityGate({
    ...context,
    checks: { api: "PASSED", web: "PASSED", githubReviewer: "PASSED", sonarQube: "PASSED", sonarCloud: "PASSED" },
    priorResults: [codeReview, qa],
    reviews: [{ user: { login: BOT_LOGIN }, commit_id: SHA, state: "APPROVED", submitted_at: "2026-11-01T09:00:00Z", body: producer.formatFormalReviewEvidence(codeReview) }],
    comments: [qaComment],
  });
  // Without an approval the parser refuses for the wrong reason, and the contract below would pass vacuously.
  assert.equal(outcome.decision, "APPROVED", `the producer fixture must yield an approved Coordinator report: ${outcome.reportMarkdown}`);
  const body = producer.formatPullRequestReport({
    agentName: "qualityGate", pullRequestNumber: 1, commitSha: SHA, contextHash: CONTEXT_HASH,
    status: outcome.decision, reportMarkdown: outcome.reportMarkdown, evidence: outcome.evidence,
  });
  return { track: outcome.reviewTrack, comment: { user: { login: BOT_LOGIN }, created_at: "2026-11-01T11:00:00Z", body } };
}

describe("review track contract between the Coordinator report and the post-merge parser", () => {
  it("recognises the light track in the report the publisher actually writes", async () => {
    const { track, comment } = await coordinatorComment(["docs/knowledge/automation/delivery-flow.md"]);
    assert.equal(track, "light");
    assert.equal(declaresLightTrack([comment], BOT_LOGIN, SHA), true);
  });

  it("does not read a full-track report as light, so QA stays required", async () => {
    const { track, comment } = await coordinatorComment(["apps/api/src/change.ts"]);
    assert.equal(track, "full");
    assert.equal(declaresLightTrack([comment], BOT_LOGIN, SHA), false);
  });

  // The mutation check, run by CI instead of on a developer machine so the evidence is auditable from this
  // job: each variant is the real light-track report with one change a producer edit could plausibly make.
  // The parser has to refuse every one; if it accepted any, the contract above could pass while the two
  // sides had drifted apart.
  it("refuses every drifted form of the light-track line, so the contract test is sensitive to format changes", async () => {
    const { comment } = await coordinatorComment(["docs/knowledge/automation/delivery-flow.md"]);
    const lightLine = "**Trilho de revisão:** leve.";
    assert.ok(comment.body.includes(lightLine), "the real report must carry the line the variants mutate");
    const drifts: Array<[string, string]> = [
      ["label renamed", "**Trilho:** leve."],
      ["value translated", "**Trilho de revisão:** light."],
      ["bold markers dropped", "Trilho de revisão: leve."],
      ["line indented as a list item", "- **Trilho de revisão:** leve."],
      ["status line inside the value", "**Trilho de revisão:** completo."],
    ];
    for (const [drift, replacement] of drifts) {
      const mutated = { ...comment, body: comment.body.replace(lightLine, replacement) };
      assert.notEqual(mutated.body, comment.body, `${drift}: the variant must differ from the real report`);
      assert.equal(declaresLightTrack([mutated], BOT_LOGIN, SHA), false, `${drift} must not be read as the light track`);
    }
  });
});

// The directives below only guard anything if the typecheck compiles this file. That is a fact about
// tsconfig.test.json and the package's typecheck script, so it is asserted here, in a test CI runs, instead
// of being taken on trust: if either stopped covering this file, the type guard would vanish silently.
describe("the compile-time half of the contract is actually compiled", () => {
  it("tsconfig.test.json includes this test file and the typecheck script runs it", async () => {
    const { readFile } = await import("node:fs/promises");
    const packageRoot = new URL("../", import.meta.url);
    const tsconfig = JSON.parse(await readFile(new URL("tsconfig.test.json", packageRoot), "utf8")) as { include?: string[]; exclude?: string[] };
    const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8")) as { scripts?: Record<string, string> };

    assert.ok(tsconfig.include?.includes("test/**/*.ts"), `tsconfig.test.json must include test/**/*.ts, got ${JSON.stringify(tsconfig.include)}`);
    assert.ok(!(tsconfig.exclude ?? []).some((pattern) => /review-track-contract|test\//.test(pattern)), "tsconfig.test.json must not exclude this file");
    assert.match(manifest.scripts?.typecheck ?? "", /tsc --noEmit -p tsconfig\.test\.json/, "the typecheck script must compile tsconfig.test.json");
    assert.match(manifest.scripts?.verify ?? "", /npm run typecheck/, "the verify script CI runs must include the typecheck");
  });
});

// Compile-time half of DEV-122, checked by `npm run typecheck` (tsconfig.test.json): an evidence result
// without the review track, or with both a reason and a track, must not type-check. If the union is loosened,
// these directives become unused and the typecheck fails.
// @ts-expect-error — neither a reason nor a review track.
export const evidenceWithoutTrack: PostMergeEvidence = {};
// @ts-expect-error — a blocking reason and a review track together.
export const evidenceWithBoth: PostMergeEvidence = { reason: "bloqueado", reviewTrack: "full" };
