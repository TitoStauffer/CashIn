// Evaluation of the dashboard queries for dashboard-check.mjs (DEV-136), kept pure so its failure modes are
// tested. It fails closed: a query that throws, answers with an error or returns no series counts as empty,
// and a pass only counts once every query has been asked in that same pass.

// Grafana variables replaced by fixed windows. The traffic of drive-api.mjs lasts about 25 seconds; 5 minutes
// keeps it inside every rate window for the whole retry period, so a slow ingestion cannot turn into a false
// "no data" for a query that does have data.
export function concreteQuery(expr) {
  return expr.replaceAll("$__rate_interval", "5m").replaceAll("$__range", "15m");
}

export function dashboardTargets(dashboard) {
  return dashboard.panels.flatMap((panel) => (panel.targets ?? []).map((target) => ({
    label: `${panel.title} · ${target.legendFormat}`,
    expr: target.expr,
  })));
}

// One complete pass over every target. `runQuery(expr)` resolves to the Prometheus API answer.
export async function evaluatePass(targets, runQuery) {
  const empty = [];
  for (const target of targets) {
    try {
      const answer = await runQuery(concreteQuery(target.expr));
      if (answer?.status !== "success" || !(answer.data?.result?.length > 0)) empty.push(target.label);
    } catch {
      empty.push(target.label);
    }
  }
  return { checked: targets.length, empty };
}

// Repeats complete passes until one has no empty query or the deadline passes. The verdict is always the
// last complete pass, never a partial one, and running out of time is a failure.
export async function evaluateUntil(targets, runQuery, { deadlineMs, pauseMs = 3000, now = Date.now, sleep }) {
  let last = await evaluatePass(targets, runQuery);
  while (last.empty.length > 0 && now() < deadlineMs) {
    await sleep(pauseMs);
    last = await evaluatePass(targets, runQuery);
  }
  return { passed: last.checked === targets.length && targets.length > 0 && last.empty.length === 0, ...last };
}
