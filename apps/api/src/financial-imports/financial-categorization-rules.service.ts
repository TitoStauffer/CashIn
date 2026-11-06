import { FinancialImportError } from "./financial-imports.errors.js";
import { normalizeFinancialImportDescription } from "./financial-imports.fingerprint.js";
import type {
  FinancialCategorizationRule,
  FinancialCategorizationRuleInput,
  FinancialCategorizationRuleType,
  FinancialCategorizationRulesRepository,
  ParsedFinancialImportItem,
} from "./financial-imports.types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RULE_DESCRIPTION_BYTES = 512;

export class FinancialCategorizationRulesService {
  constructor(private readonly repository: FinancialCategorizationRulesRepository) {}

  listRules(walletId: string): Promise<FinancialCategorizationRule[]> {
    return this.repository.listRules(walletId);
  }

  async createRule(userId: string, walletId: string, input: FinancialCategorizationRuleInput): Promise<FinancialCategorizationRule> {
    const normalized = normalizeInput(input);
    const rule = await mapUniqueViolation(() => this.repository.createRule(userId, walletId, normalized));
    if (!rule) throw new FinancialImportError("A categoria ou subcategoria não existe nesta carteira.", 404);
    return rule;
  }

  async updateRule(walletId: string, ruleId: string, input: FinancialCategorizationRuleInput): Promise<FinancialCategorizationRule> {
    if (!UUID_PATTERN.test(ruleId)) throw new FinancialImportError("A regra de categorização não foi encontrada.", 404);
    const normalized = normalizeInput(input);
    // Editing type or description can collide with another rule of the same wallet.
    const rule = await mapUniqueViolation(() => this.repository.updateRule(walletId, ruleId, normalized));
    if (!rule) throw new FinancialImportError("A regra ou categoria não foi encontrada nesta carteira.", 404);
    return rule;
  }

  async deleteRule(walletId: string, ruleId: string): Promise<void> {
    if (!UUID_PATTERN.test(ruleId)) throw new FinancialImportError("A regra de categorização não foi encontrada.", 404);
    if (!await this.repository.deleteRule(walletId, ruleId)) {
      throw new FinancialImportError("A regra de categorização não foi encontrada.", 404);
    }
  }

  async applyRules(walletId: string, items: ParsedFinancialImportItem[]): Promise<ParsedFinancialImportItem[]> {
    const rules = await this.repository.listRules(walletId);
    const rulesByKey = new Map<string, FinancialCategorizationRule>();
    for (const rule of rules) {
      if (!rule.isActive || rule.isStale || !rule.categoryId) continue;
      rulesByKey.set(makeRuleKey(rule.type, normalizeFinancialImportDescription(rule.description)), rule);
    }

    return items.map((item) => {
      if (
        item.categoryId
        || item.type === "transfer"
        || item.type === "card_credit"
        || item.validationStatus === "invalid"
        || item.validationStatus === "duplicate"
      ) return item;

      const rule = rulesByKey.get(makeRuleKey(item.type, normalizeFinancialImportDescription(item.description)));
      if (!rule) return item;
      return {
        ...item,
        categoryId: rule.categoryId,
        subcategoryId: rule.subcategoryId,
        validationStatus: "valid",
        errorMessage: null,
        categorizationSource: "rule",
      };
    });
  }
}

export function makeRuleKey(type: FinancialCategorizationRuleType, normalizedDescription: string): string {
  return JSON.stringify([type, normalizedDescription]);
}

function normalizeInput(input: FinancialCategorizationRuleInput): FinancialCategorizationRuleInput & { normalizedDescription: string } {
  if (input?.type !== "income" && input?.type !== "expense") {
    throw new FinancialImportError("O tipo da regra deve ser entrada ou saída.", 400);
  }
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const normalizedDescription = normalizeFinancialImportDescription(description);
  if (
    !description
    || !normalizedDescription
    || Buffer.byteLength(description, "utf8") > MAX_RULE_DESCRIPTION_BYTES
    || Buffer.byteLength(normalizedDescription, "utf8") > MAX_RULE_DESCRIPTION_BYTES
  ) {
    throw new FinancialImportError("A descrição da regra deve ter entre 1 e 512 bytes.", 400);
  }
  if (!UUID_PATTERN.test(input.categoryId)) throw new FinancialImportError("Selecione uma categoria válida.", 400);
  const subcategoryId = input.subcategoryId ?? null;
  if (subcategoryId !== null && !UUID_PATTERN.test(subcategoryId)) {
    throw new FinancialImportError("Selecione uma subcategoria válida.", 400);
  }
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") {
    throw new FinancialImportError("O estado da regra é inválido.", 400);
  }
  return { type: input.type, description, normalizedDescription, categoryId: input.categoryId, subcategoryId, isActive: input.isActive ?? true };
}

async function mapUniqueViolation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error)) throw new FinancialImportError("Já existe uma regra para esta descrição e tipo nesta carteira.", 409);
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
