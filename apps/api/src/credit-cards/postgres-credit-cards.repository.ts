import type { Database, QueryExecutor } from "../database.js";
import { CreditCardError } from "./credit-cards.errors.js";
import type {
  CreditCard,
  CreditCardPurchase,
  CreditCardRepository,
  CreditCardStatement,
  CreditCardStatementCredit,
} from "./credit-cards.types.js";

interface CreditCardRow {
  id: string;
  alias: string;
  closing_day: number;
  due_day: number;
  is_active: boolean;
}

interface StatementRow {
  id: string;
  credit_card_id: string;
  credit_card_name: string;
  closing_date: string | Date;
  due_date: string | Date;
  paid_date: string | Date | null;
  paid_amount: string | null;
  purchases_amount: string;
  credits_amount: string;
  total_amount: string;
  purchases: CreditCardPurchase[] | null;
  credits: CreditCardStatementCredit[] | null;
}

function dateValue(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function mapCard(row: CreditCardRow): CreditCard {
  return {
    id: row.id,
    nickname: row.alias,
    closingDay: row.closing_day,
    dueDay: row.due_day,
    isActive: row.is_active,
  };
}

function mapStatement(row: StatementRow): CreditCardStatement {
  return {
    id: row.id,
    creditCardId: row.credit_card_id,
    creditCardName: row.credit_card_name,
    closingDate: dateValue(row.closing_date)!,
    dueDate: dateValue(row.due_date)!,
    paidDate: dateValue(row.paid_date),
    paidAmount: row.paid_amount,
    purchasesAmount: row.purchases_amount,
    creditsAmount: row.credits_amount,
    totalAmount: row.total_amount,
    purchases: row.purchases ?? [],
    credits: row.credits ?? [],
  };
}

// Purchases and credits are aggregated in separate lateral subqueries so neither multiplies the other.
const statementSelect = `
  SELECT statement.id,
         statement.credit_card_id,
         card.alias AS credit_card_name,
         statement.closing_date,
         statement.due_date,
         statement.paid_date,
         statement.paid_amount::text AS paid_amount,
         purchase_summary.amount::text AS purchases_amount,
         credit_summary.amount::text AS credits_amount,
         (purchase_summary.amount - credit_summary.amount)::numeric(14, 2)::text AS total_amount,
         purchase_summary.items AS purchases,
         credit_summary.items AS credits
  FROM credit_card_statements AS statement
  JOIN credit_cards AS card
    ON card.id = statement.credit_card_id
   AND card.wallet_id = statement.wallet_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(expense.amount), 0.00)::numeric(14, 2) AS amount,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', expense.id,
                 'amount', expense.amount::text,
                 'date', expense.date::text,
                 'description', expense.description,
                 'categoryName', category.name,
                 'subcategoryName', subcategory.name
               ) ORDER BY expense.date, expense.created_at, expense.id
             ) FILTER (WHERE expense.id IS NOT NULL),
             '[]'::json
           ) AS items
    FROM expenses AS expense
    LEFT JOIN categories AS category
      ON category.id = expense.category_id
     AND category.wallet_id = expense.wallet_id
    LEFT JOIN subcategories AS subcategory
      ON subcategory.id = expense.subcategory_id
     AND subcategory.wallet_id = expense.wallet_id
     AND subcategory.category_id = expense.category_id
    WHERE expense.credit_card_statement_id = statement.id
      AND expense.wallet_id = statement.wallet_id
  ) AS purchase_summary
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(credit.amount), 0.00)::numeric(14, 2) AS amount,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', credit.id,
                 'amount', credit.amount::text,
                 'date', credit.date::text,
                 'description', credit.description,
                 'originalExpenseId', credit.original_expense_id
               ) ORDER BY credit.date, credit.created_at, credit.id
             ) FILTER (WHERE credit.id IS NOT NULL),
             '[]'::json
           ) AS items
    FROM credit_card_statement_credits AS credit
    WHERE credit.credit_card_statement_id = statement.id
      AND credit.wallet_id = statement.wallet_id
  ) AS credit_summary`;

export class PostgresCreditCardsRepository implements CreditCardRepository {
  constructor(private readonly database: Database) {}

  async list(walletId: string): Promise<CreditCard[]> {
    const result = await this.database.query<CreditCardRow>(
      `SELECT id, alias, closing_day, due_day, is_active
       FROM credit_cards
       WHERE wallet_id = $1
       ORDER BY is_active DESC, lower(alias), id`,
      [walletId],
    );
    return result.rows.map(mapCard);
  }

  async create(walletId: string, input: { nickname: string; closingDay: number; dueDay: number }): Promise<CreditCard> {
    const result = await this.database.query<CreditCardRow>(
      `INSERT INTO credit_cards (wallet_id, alias, closing_day, due_day)
       VALUES ($1, $2, $3, $4)
       RETURNING id, alias, closing_day, due_day, is_active`,
      [walletId, input.nickname, input.closingDay, input.dueDay],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Credit card insert returned no row");
    return mapCard(row);
  }

  async update(
    walletId: string,
    creditCardId: string,
    changes: { nickname?: string; closingDay?: number; dueDay?: number; isActive?: boolean },
  ): Promise<CreditCard | null> {
    const result = await this.database.query<CreditCardRow>(
      `UPDATE credit_cards
       SET alias = COALESCE($3, alias),
           closing_day = COALESCE($4, closing_day),
           due_day = COALESCE($5, due_day),
           is_active = COALESCE($6, is_active),
           updated_at = now()
       WHERE id = $1 AND wallet_id = $2
       RETURNING id, alias, closing_day, due_day, is_active`,
      [creditCardId, walletId, changes.nickname ?? null, changes.closingDay ?? null, changes.dueDay ?? null, changes.isActive ?? null],
    );
    const row = result.rows[0];
    return row ? mapCard(row) : null;
  }

  async listStatements(walletId: string, creditCardId: string, from?: string, to?: string): Promise<CreditCardStatement[] | null> {
    const card = await this.database.query<{ id: string }>(
      "SELECT id FROM credit_cards WHERE id = $1 AND wallet_id = $2",
      [creditCardId, walletId],
    );
    if (!card.rows[0]) return null;
    const result = await this.database.query<StatementRow>(
      `${statementSelect}
       WHERE statement.wallet_id = $1
         AND statement.credit_card_id = $2
         AND ($3::date IS NULL OR statement.closing_date >= $3::date)
         AND ($4::date IS NULL OR statement.closing_date <= $4::date)
       ORDER BY statement.closing_date DESC, statement.id DESC`,
      [walletId, creditCardId, from ?? null, to ?? null],
    );
    return result.rows.map(mapStatement);
  }

  async payStatement(walletId: string, creditCardId: string, statementId: string, date: string): Promise<CreditCardStatement | null> {
    return this.database.transaction(async (transaction) => {
      const statement = await transaction.query<{ id: string; paid_date: string | Date | null }>(
        `SELECT id, paid_date
         FROM credit_card_statements
         WHERE id = $1 AND credit_card_id = $2 AND wallet_id = $3
         FOR UPDATE`,
        [statementId, creditCardId, walletId],
      );
      const current = statement.rows[0];
      if (!current) return null;
      if (current.paid_date !== null) throw new CreditCardError("Esta fatura já foi paga.", 409);

      // The amount paid is the net statement balance: purchases minus refunds and chargebacks.
      const total = await transaction.query<{ amount: string; has_purchases: boolean; is_positive: boolean }>(
        `WITH balance AS (
           SELECT ((SELECT COALESCE(SUM(amount), 0.00) FROM expenses
                    WHERE credit_card_statement_id = $1 AND wallet_id = $2)
                 - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_credits
                    WHERE credit_card_statement_id = $1 AND wallet_id = $2))::numeric(14, 2) AS amount
         )
         SELECT balance.amount::text AS amount,
                balance.amount > 0 AS is_positive,
                EXISTS (SELECT 1 FROM expenses WHERE credit_card_statement_id = $1 AND wallet_id = $2) AS has_purchases
         FROM balance`,
        [statementId, walletId],
      );
      const balance = total.rows[0];
      if (!balance?.has_purchases) throw new CreditCardError("Não é possível pagar uma fatura sem compras.", 409);
      if (!balance.is_positive) {
        throw new CreditCardError("Não é possível pagar uma fatura sem saldo devedor: os créditos cobrem as compras.", 409);
      }
      const amount = balance.amount;

      await transaction.query(
        `UPDATE credit_card_statements
         SET paid_date = $3::date, paid_amount = $4::numeric, updated_at = now()
         WHERE id = $1 AND wallet_id = $2`,
        [statementId, walletId, date, amount],
      );
      return this.findStatement(transaction, walletId, creditCardId, statementId);
    });
  }

  private async findStatement(
    executor: QueryExecutor,
    walletId: string,
    creditCardId: string,
    statementId: string,
  ): Promise<CreditCardStatement | null> {
    const result = await executor.query<StatementRow>(
      `${statementSelect}
       WHERE statement.wallet_id = $1 AND statement.credit_card_id = $2 AND statement.id = $3`,
      [walletId, creditCardId, statementId],
    );
    const row = result.rows[0];
    return row ? mapStatement(row) : null;
  }
}
