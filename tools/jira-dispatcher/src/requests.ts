import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isValidIssueKey } from "./config.js";
import { atomicWriteJson } from "./state.js";

export type OperatorRequest =
  | { action: "stop"; mode: "drain" | "now" }
  | { action: "resume"; issueKey: string }
  | { action: "clear"; issueKey: string };

let sequence = 0;

/**
 * File-based queue so CLI commands can talk to a running dispatcher on any OS
 * (Windows has no reliable SIGTERM for console processes).
 */
export class RequestQueue {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "requests");
  }

  enqueue(request: OperatorRequest): string {
    mkdirSync(this.dir, { recursive: true });
    // Zero-padded timestamp + per-process sequence keeps lexical order equal to arrival order,
    // even for several requests within the same millisecond.
    sequence += 1;
    const order = `${String(Date.now()).padStart(15, "0")}-${String(sequence).padStart(8, "0")}`;
    const file = join(this.dir, `${order}-${randomUUID()}.json`);
    atomicWriteJson(file, { ...request, requestedAt: new Date().toISOString() });
    return file;
  }

  /** Reads and removes pending requests in arrival order. Invalid files are discarded. */
  drain(): OperatorRequest[] {
    if (!existsSync(this.dir)) return [];
    const requests: OperatorRequest[] = [];
    for (const name of readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort()) {
      const file = join(this.dir, name);
      try {
        const parsed = parseRequest(JSON.parse(readFileSync(file, "utf8")));
        if (parsed) requests.push(parsed);
      } catch {
        /* discard malformed request */
      }
      try {
        unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
    return requests;
  }
}

function parseRequest(value: unknown): OperatorRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.action === "stop" && (v.mode === "drain" || v.mode === "now")) return { action: "stop", mode: v.mode };
  if ((v.action === "resume" || v.action === "clear") && typeof v.issueKey === "string" && isValidIssueKey(v.issueKey)) {
    return { action: v.action, issueKey: v.issueKey };
  }
  return undefined;
}
