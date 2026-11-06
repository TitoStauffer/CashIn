import type { Database } from "../database.js";
import type {
  FinancialCategorizationRule,
  FinancialCategorizationRuleInput,
  FinancialCategorizationRulesRepository,
} from "./financial-imports.types.js";

interface RuleRow {
  id: string;
  movement_type: "income" | "expense";
  description: string;
  category_id: string;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  is_active: boolean;
  is_stale: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const ruleSelect = `
  SELECT rule.id,
         rule.movement_type,
         rule.description,
         rule.category_id,
         category.name AS category_name,
         rule.subcategory_id,
         subcategory.name AS subcategory_name,
         rule.is_active,
         (category.id IS NULL OR (rule.subcategory_id IS NOT NULL AND subcategory.id IS NULL)) AS is_stale,
         rule.created_at,
         rule.updated_at
  FROM financial_import_categorization_rules AS rule
  LEFT JOIN categories AS category
    ON category.id = rule.category_id
   AND category.wallet_id = rule.wallet_id
   AND category.nature = rule.movement_type
  LEFT JOIN subcategories AS subcategory
    ON subcategory.id = rule.subcategory_id
   AND subcategory.category_id = category.id
   AND subcategory.wallet_id = rule.wallet_id
`;

export class PostgresFinancialCategorizationRulesRepository implements FinancialCategorizationRulesRepository {
  constructor(private readonly database: Database) {}

  async listRules(walletId: string): Promise<FinancialCategorizationRule[]> {
    const result = await this.database.query<RuleRow>(
      `${ruleSelect} WHERE rule.wallet_id = $1 ORDER BY rule.is_active DESC, rule.movement_type, rule.description, rule.id`,
      [walletId],
    );
    return result.rows.map(mapRule);
  }

  async createRule(
    userId: string,
    walletId: string,
    input: FinancialCategorizationRuleInput & { normalizedDescription: string },
  ): Promise<FinancialCategorizationRule | null> {
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO financial_import_categorization_rules
         (wallet_id, created_by_user_id, movement_type, description, normalized_description, category_id, subcategory_id, is_active)
       SELECT $1, $2, $3, $4, $5, category.id, $7, $8
       FROM categories AS category
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = $7
        AND subcategory.category_id = category.id
        AND subcategory.wallet_id = $1
       WHERE category.id = $6
         AND category.wallet_id = $1
         AND category.nature = $3
         AND ($7::uuid IS NULL OR subcategory.id IS NOT NULL)
       RETURNING id`,
      [walletId, userId, input.type, input.description, input.normalizedDescription, input.categoryId, input.subcategoryId ?? null, input.isActive ?? true],
    );
    const id = result.rows[0]?.id;
    if (!id) return null;
    return this.getRule(walletId, id);
  }

  async updateRule(
    walletId: string,
    ruleId: string,
    input: FinancialCategorizationRuleInput & { normalizedDescription: string },
  ): Promise<FinancialCategorizationRule | null> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE financial_import_categorization_rules AS rule
       SET movement_type = $3,
           description = $4,
           normalized_description = $5,
           category_id = category.id,
           subcategory_id = $7,
           is_active = $8,
           updated_at = now()
       FROM categories AS category
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = $7
        AND subcategory.category_id = category.id
        AND subcategory.wallet_id = $2
       WHERE rule.id = $1
         AND rule.wallet_id = $2
         AND category.id = $6
         AND category.wallet_id = $2
         AND category.nature = $3
         AND ($7::uuid IS NULL OR subcategory.id IS NOT NULL)
       RETURNING rule.id`,
      [ruleId, walletId, input.type, input.description, input.normalizedDescription, input.categoryId, input.subcategoryId ?? null, input.isActive ?? true],
    );
    const id = result.rows[0]?.id;
    return id ? this.getRule(walletId, id) : null;
  }

  async deleteRule(walletId: string, ruleId: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM financial_import_categorization_rules WHERE id = $1 AND wallet_id = $2",
      [ruleId, walletId],
    );
    return result.rowCount === 1;
  }

  private async getRule(walletId: string, ruleId: string): Promise<FinancialCategorizationRule | null> {
    const result = await this.database.query<RuleRow>(`${ruleSelect} WHERE rule.wallet_id = $1 AND rule.id = $2`, [walletId, ruleId]);
    const row = result.rows[0];
    return row ? mapRule(row) : null;
  }
}

function mapRule(row: RuleRow): FinancialCategorizationRule {
  return {
    id: row.id,
    type: row.movement_type,
    description: row.description,
    categoryId: row.category_id,
    categoryName: row.category_name,
    subcategoryId: row.subcategory_id,
    subcategoryName: row.subcategory_name,
    isActive: row.is_active,
    isStale: row.is_stale,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
