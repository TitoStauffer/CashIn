import assert from "node:assert/strict";
import test from "node:test";
import { FinancialCategorizationRulesService } from "./financial-categorization-rules.service.js";
import type {
  FinancialCategorizationRule,
  FinancialCategorizationRuleInput,
  FinancialCategorizationRulesRepository,
} from "./financial-imports.types.js";

const rule: FinancialCategorizationRule = {
  id: "rule-1",
  type: "expense",
  description: "Mercado do Bairro",
  categoryId: "category-1",
  categoryName: "Alimentação",
  subcategoryId: "subcategory-1",
  subcategoryName: "Mercado",
  isActive: true,
  isStale: false,
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
};

class MemoryRulesRepository implements FinancialCategorizationRulesRepository {
  rules = [rule];

  async listRules(): Promise<FinancialCategorizationRule[]> { return this.rules; }
  async createRule(_userId: string, _walletId: string, input: FinancialCategorizationRuleInput & { normalizedDescription: string }): Promise<FinancialCategorizationRule | null> {
    return { ...rule, ...input, id: "created" };
  }
  async updateRule(_walletId: string, _ruleId: string, input: FinancialCategorizationRuleInput & { normalizedDescription: string }): Promise<FinancialCategorizationRule | null> {
    return { ...rule, ...input };
  }
  async deleteRule(): Promise<boolean> { return true; }
}

test("applies only active exact-description rules for the same movement type", async () => {
  const repository = new MemoryRulesRepository();
  repository.rules = [
    rule,
    { ...rule, id: "inactive", description: "Inactive", isActive: false },
    { ...rule, id: "stale", description: "Stale", isStale: true },
  ];
  const service = new FinancialCategorizationRulesService(repository);

  const result = await service.applyRules("wallet-a", [
    { sequence: 1, date: "2026-11-01", description: "  MERCADO   DO BAIRRO ", signedAmount: "-12.00", type: "expense", validationStatus: "uncategorized" },
    { sequence: 2, date: "2026-11-01", description: "Mercado do Bairro", signedAmount: "12.00", type: "income", validationStatus: "uncategorized" },
    { sequence: 3, date: "2026-11-01", description: "Inactive", signedAmount: "-1.00", type: "expense", validationStatus: "uncategorized" },
    { sequence: 4, date: "2026-11-01", description: "Stale", signedAmount: "-1.00", type: "expense", validationStatus: "uncategorized" },
  ]);

  assert.equal(result[0]?.categoryId, "category-1");
  assert.equal(result[0]?.subcategoryId, "subcategory-1");
  assert.equal(result[0]?.validationStatus, "valid");
  assert.equal(result[0]?.categorizationSource, "rule");
  assert.equal(result[1]?.categoryId, undefined);
  assert.equal(result[2]?.categoryId, undefined);
  assert.equal(result[3]?.categoryId, undefined);
});

test("does not override an existing category and validates rule input", async () => {
  const service = new FinancialCategorizationRulesService(new MemoryRulesRepository());
  const [result] = await service.applyRules("wallet-a", [{
    sequence: 1,
    date: "2026-11-01",
    description: "Mercado do Bairro",
    signedAmount: "-12.00",
    type: "expense",
    categoryId: "chosen-category",
    validationStatus: "valid",
  }]);
  assert.equal(result?.categoryId, "chosen-category");

  await assert.rejects(
    () => service.createRule("user-1", "wallet-a", { type: "expense", description: "  ", categoryId: "00000000-0000-4000-8000-000000000001" }),
    { statusCode: 400 },
  );
});
