import assert from "node:assert/strict";
import test from "node:test";
import { isPositiveMoneyAmount } from "./money.js";

test("money validation accepts positive decimal strings within numeric(14,2)", () => {
  for (const value of ["0.01", "1", "1.2", "1.20", "999999999999.99"]) {
    assert.equal(isPositiveMoneyAmount(value), true, value);
  }
});

test("money validation rejects zero, excess precision, and values outside numeric(14,2)", () => {
  for (const value of ["0", "0.0", "0.00", "0.001", "1.001", "999999999999.999", "1000000000000", "01", "1,20", "1e2"]) {
    assert.equal(isPositiveMoneyAmount(value), false, value);
  }
});
