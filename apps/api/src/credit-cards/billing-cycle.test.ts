import assert from "node:assert/strict";
import test from "node:test";
import { calculateBillingCycle } from "./billing-cycle.js";

test("billing cycle includes purchases on the configured closing date", () => {
  assert.deepEqual(calculateBillingCycle("2026-10-10", 10, 20), {
    closingDate: "2026-10-10",
    dueDate: "2026-10-20",
  });
});

test("billing cycle moves purchases after closing to the next invoice", () => {
  assert.deepEqual(calculateBillingCycle("2026-10-11", 10, 20), {
    closingDate: "2026-11-10",
    dueDate: "2026-11-20",
  });
});

test("due date rolls to the following month when its configured day is not after closing", () => {
  assert.deepEqual(calculateBillingCycle("2026-10-10", 10, 5), {
    closingDate: "2026-10-10",
    dueDate: "2026-11-05",
  });
});

test("billing cycle clamps closing and due days to shorter months", () => {
  assert.deepEqual(calculateBillingCycle("2027-02-28", 31, 5), {
    closingDate: "2027-02-28",
    dueDate: "2027-03-05",
  });
});

test("billing cycle handles year boundaries", () => {
  assert.deepEqual(calculateBillingCycle("2026-12-31", 31, 5), {
    closingDate: "2026-12-31",
    dueDate: "2027-01-05",
  });
});
