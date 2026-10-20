import type { Database, QueryExecutor } from "../database.js";
import { CreditCardError } from "./credit-cards.errors.js";
import type { CreditCard, CreditCardPurchase, CreditCardRepository, CreditCardStatement } from "./credit-cards.types.js";

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
  total_amount: string;
  purchases: CreditCardPurchase[] | null;
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
    totalAmount: row.total_amount,
    purchases: row.purchases ?? [],
  };
}

const statementSelect = `
  SELECT statement.id,
         statement.credit_card_id,
         card.alias AS credit_card_name,
         statement.closing_date,
         statement.due_date,
         statement.paid_date,
         statement.paid_amount::text AS paid_amount,
         COALESCE(SUM(expense.amount), 0.00)::text AS total_amount,
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
         ) AS purchases
  FROM credit_card_statements AS statement
  JOIN credit_cards AS card
    ON card.id = statement.credit_card_id
   AND card.wallet_id = statement.wallet_id
  LEFT JOIN expenses AS expense
    ON expense.credit_card_statement_id = statement.id
   AND expense.wallet_id = statement.wallet_id
  LEFT JOIN categories AS category
    ON category.id = expense.category_id
   AND category.wallet_id = expense.wallet_id
  LEFT JOIN subcategories AS subcategory
    ON subcategory.id = expense.subcategory_id
   AND subcategory.wallet_id = expense.wallet_id
   AND subcategory.category_id = expense.category_id`;

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
       GROUP BY statement.id, card.alias
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

      const total = await transaction.query<{ amount: string }>(
        `SELECT COALESCE(SUM(amount), 0.00)::text AS amount
         FROM expenses
         WHERE credit_card_statement_id = $1 AND wallet_id = $2`,
        [statementId, walletId],
      );
      const amount = total.rows[0]?.amount ?? "0.00";
      if (amount === "0.00") throw new CreditCardError("Não é possível pagar uma fatura sem compras.", 409);

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
       WHERE statement.wallet_id = $1 AND statement.credit_card_id = $2 AND statement.id = $3
       GROUP BY statement.id, card.alias`,
      [walletId, creditCardId, statementId],
    );
    const row = result.rows[0];
    return row ? mapStatement(row) : null;
  }
}
