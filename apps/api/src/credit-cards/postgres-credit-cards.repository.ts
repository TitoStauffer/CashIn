import type { Database, QueryExecutor } from "../database.js";
import { CreditCardError } from "./credit-cards.errors.js";
import type {
  CreditCard,
  CreditCardPurchase,
  CreditCardRepository,
  CreditCardStatement,
  CreditCardStatementCredit,
  CreditCardStatementPayment,
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

  purchases_amount: string;
  credits_amount: string;
  total_amount: string;
  payments_amount: string;
  outstanding_amount: string;
  purchases: CreditCardPurchase[] | null;
  credits: CreditCardStatementCredit[] | null;
  payments: CreditCardStatementPayment[] | null;
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
    // The amount paid is the sum of the statement's payments; it only reads as paid once settled.
    paidAmount: dateValue(row.paid_date) === null ? null : row.payments_amount,
    purchasesAmount: row.purchases_amount,
    creditsAmount: row.credits_amount,
    totalAmount: row.total_amount,
    paymentsAmount: row.payments_amount,
    outstandingAmount: row.outstanding_amount,
    purchases: row.purchases ?? [],
    credits: row.credits ?? [],
    payments: row.payments ?? [],
  };
}

// Purchases, credits and payments are aggregated in separate lateral subqueries so none multiplies another.
const statementSelect = `
  SELECT statement.id,
         statement.credit_card_id,
         card.alias AS credit_card_name,
         statement.closing_date,
         statement.due_date,
         statement.paid_date,
         purchase_summary.amount::text AS purchases_amount,
         credit_summary.amount::text AS credits_amount,
         (purchase_summary.amount - credit_summary.amount)::numeric(14, 2)::text AS total_amount,
         payment_summary.amount::text AS payments_amount,
         GREATEST(purchase_summary.amount - credit_summary.amount - payment_summary.amount, 0.00)::numeric(14, 2)::text AS outstanding_amount,
         purchase_summary.items AS purchases,
         credit_summary.items AS credits,
         payment_summary.items AS payments
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
  ) AS credit_summary
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(payment.amount), 0.00)::numeric(14, 2) AS amount,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', payment.id,
                 'amount', payment.amount::text,
                 'date', payment.date::text,
                 'source', payment.source
               ) ORDER BY payment.date, payment.created_at, payment.id
             ) FILTER (WHERE payment.id IS NOT NULL),
             '[]'::json
           ) AS items
    FROM credit_card_statement_payments AS payment
    WHERE payment.credit_card_statement_id = statement.id
      AND payment.wallet_id = statement.wallet_id
  ) AS payment_summary`;

// Shared by manual payments and by payments reconciled from a bank statement, so both follow the
// same rules: no payment on a settled statement, no payment without purchases or without an
// outstanding balance, and settlement only once the payments cover the statement total.
export async function registerStatementPayment(
  executor: QueryExecutor,
  input: {
    walletId: string;
    userId: string;
    statementId: string;
    date: string;
    amount?: string;
    source: "manual" | "bank_statement";
  },
): Promise<{ paymentId: string; settled: boolean }> {
  const balance = await executor.query<{
    outstanding: string;
    has_purchases: boolean;
    is_settled: boolean;
  }>(
    `WITH totals AS (
       SELECT ((SELECT COALESCE(SUM(amount), 0.00) FROM expenses
                WHERE credit_card_statement_id = $1 AND wallet_id = $2)
             - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_credits
                WHERE credit_card_statement_id = $1 AND wallet_id = $2)
             - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_payments
                WHERE credit_card_statement_id = $1 AND wallet_id = $2))::numeric(14, 2) AS outstanding
     )
     SELECT totals.outstanding::text AS outstanding,
            EXISTS (SELECT 1 FROM expenses WHERE credit_card_statement_id = $1 AND wallet_id = $2) AS has_purchases,
            EXISTS (SELECT 1 FROM credit_card_statements
                    WHERE id = $1 AND wallet_id = $2 AND paid_date IS NOT NULL) AS is_settled
     FROM totals`,
    [input.statementId, input.walletId],
  );
  const current = balance.rows[0];
  if (!current) throw new CreditCardError("Fatura não encontrada.", 404);
  if (current.is_settled) throw new CreditCardError("Esta fatura já foi paga.", 409);
  if (!current.has_purchases) throw new CreditCardError("Não é possível pagar uma fatura sem compras.", 409);
  const outstanding = toCents(current.outstanding);
  if (outstanding <= 0n) {
    throw new CreditCardError("Não é possível pagar uma fatura sem saldo devedor: os créditos cobrem as compras.", 409);
  }
  const paid = input.amount === undefined ? outstanding : toCents(input.amount);
  if (paid <= 0n) throw new CreditCardError("O valor do pagamento deve ser maior que zero.", 400);

  const inserted = await executor.query<{ id: string }>(
    `INSERT INTO credit_card_statement_payments (wallet_id, user_id, credit_card_statement_id, amount, date, source)
     VALUES ($1, $2, $3, $4::numeric, $5::date, $6)
     RETURNING id`,
    [input.walletId, input.userId, input.statementId, fromCents(paid), input.date, input.source],
  );
  // A payment that covers the outstanding balance settles the statement; a partial one leaves it open,
  // so the statement keeps accepting purchases.
  const settled = paid >= outstanding;
  if (settled) {
    await executor.query(
      `UPDATE credit_card_statements
       SET paid_date = $3::date, updated_at = now()
       WHERE id = $1 AND wallet_id = $2`,
      [input.statementId, input.walletId, input.date],
    );
  }
  return { paymentId: inserted.rows[0]!.id, settled };
}

// Statement payments are recorded against the wallet owner, like the wallet's seeded data.
export async function walletOwnerUserId(executor: QueryExecutor, walletId: string): Promise<string> {
  const result = await executor.query<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM wallets WHERE id = $1",
    [walletId],
  );
  const ownerUserId = result.rows[0]?.owner_user_id;
  if (!ownerUserId) throw new CreditCardError("Carteira não encontrada.", 404);
  return ownerUserId;
}

// Exact decimal arithmetic for amounts with up to two decimal places.
function toCents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new CreditCardError("O valor do pagamento é inválido.", 400);
  const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

function fromCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

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

  async payStatement(
    walletId: string,
    creditCardId: string,
    statementId: string,
    date: string,
    amount?: string,
  ): Promise<CreditCardStatement | null> {
    return this.database.transaction(async (transaction) => {
      const statement = await transaction.query<{ id: string }>(
        `SELECT id
         FROM credit_card_statements
         WHERE id = $1 AND credit_card_id = $2 AND wallet_id = $3
         FOR UPDATE`,
        [statementId, creditCardId, walletId],
      );
      if (!statement.rows[0]) return null;
      await registerStatementPayment(transaction, {
        walletId,
        userId: await walletOwnerUserId(transaction, walletId),
        statementId,
        date,
        amount,
        source: "manual",
      });
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
