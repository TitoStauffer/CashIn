#!/usr/bin/env node
// Stand-in for `codex exec` used by tests. Behaviour is selected with FAKE_CODEX_MODE.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputFile = args[args.indexOf("--output-last-message") + 1];
const mode = process.env.FAKE_CODEX_MODE ?? "done";
const issueKey = process.env.FAKE_CODEX_ISSUE ?? "DEV-10";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", main);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function writeResult(result) {
  writeFileSync(outputFile, JSON.stringify(result));
}

function main() {
  if (process.env.FAKE_CODEX_RECORD) {
    writeFileSync(
      process.env.FAKE_CODEX_RECORD,
      JSON.stringify({ args, cwd: process.cwd(), prompt, hasJiraToken: "JIRA_API_TOKEN" in process.env })
    );
  }
  emit({ type: "thread.started", thread_id: "thread-123" });
  emit({ type: "turn.started" });

  switch (mode) {
    case "done":
      emit({ type: "item.completed", item: { type: "agent_message", text: "ok" } });
      writeResult({ issueKey, outcome: "done", prUrl: "https://github.com/x/y/pull/1", jiraStatus: "Concluído", summary: "Entregue." });
      emit({ type: "turn.completed" });
      process.exit(0);
    case "blocked":
      writeResult({ issueKey, outcome: "blocked", prUrl: null, jiraStatus: "Em andamento", summary: "Critérios ambíguos." });
      process.exit(0);
    case "reported-failure":
      writeResult({ issueKey, outcome: "failed", prUrl: null, jiraStatus: "Em andamento", summary: "Build quebrado." });
      process.exit(0);
    case "wrong-issue":
      writeResult({ issueKey: "DEV-999", outcome: "done", prUrl: null, jiraStatus: "Concluído", summary: "x" });
      process.exit(0);
    case "invalid":
      writeFileSync(outputFile, "Terminei! (sem JSON)");
      process.exit(0);
    case "leak":
      emit({ type: "item.completed", item: { type: "command_execution", output: `token ${process.env.LEAK_VALUE}` } });
      process.stderr.write(`stderr ${process.env.LEAK_VALUE}\n`);
      writeResult({ issueKey, outcome: "done", prUrl: null, jiraStatus: "Concluído", summary: `vazou ${process.env.LEAK_VALUE}` });
      process.exit(0);
    case "crash":
      emit({ type: "turn.failed", error: { message: "model overloaded" } });
      process.exit(3);
    case "hang":
      setInterval(() => {}, 1000);
      break;
  }
}
