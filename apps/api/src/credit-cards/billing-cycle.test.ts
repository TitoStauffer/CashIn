import assert from "node:assert/strict";
import test from "node:test";
import { adjacentClosingDates, calculateBillingCycle, calculateDueDate } from "./billing-cycle.js";

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

test("due date is derived from the closing date in the same or the following month", () => {
  assert.equal(calculateDueDate("2026-10-10", 10, 20), "2026-10-20");
  assert.equal(calculateDueDate("2026-12-31", 31, 8), "2027-01-08");
  assert.equal(calculateDueDate("2026-01-31", 31, 30), "2026-02-28");
});

test("a purchase may be moved only to the previous, calculated or next statement", () => {
  assert.deepEqual(adjacentClosingDates("2026-10-11", 10, 20), ["2026-10-10", "2026-11-10", "2026-12-10"]);
  // Month-end closing follows short and leap months across a year boundary.
  assert.deepEqual(adjacentClosingDates("2028-01-15", 31, 8), ["2027-12-31", "2028-01-31", "2028-02-29"]);
  assert.deepEqual(adjacentClosingDates("2026-03-01", 31, 8), ["2026-02-28", "2026-03-31", "2026-04-30"]);
});
