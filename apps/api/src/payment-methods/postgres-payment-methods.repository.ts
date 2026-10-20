import type { Database } from "../database.js";
import type { PaymentMethod, PaymentMethodNature, PaymentMethodRepository } from "./payment-methods.types.js";

interface PaymentMethodRow {
  id: string;
  name: string;
  nature: PaymentMethodNature;
  is_active: boolean;
}

function mapPaymentMethod(row: PaymentMethodRow): PaymentMethod {
  return { id: row.id, name: row.name, nature: row.nature, isActive: row.is_active };
}

export class PostgresPaymentMethodsRepository implements PaymentMethodRepository {
  constructor(private readonly database: Database) {}

  async list(_userId: string, walletId: string): Promise<PaymentMethod[]> {
    const result = await this.database.query<PaymentMethodRow>(
      `SELECT id, name, nature, is_active
       FROM payment_methods
       WHERE wallet_id = $1
       ORDER BY is_active DESC, lower(name), id`,
      [walletId],
    );
    return result.rows.map(mapPaymentMethod);
  }

  async create(_userId: string, walletId: string, name: string, nature: PaymentMethodNature): Promise<PaymentMethod> {
    const result = await this.database.query<PaymentMethodRow>(
      `INSERT INTO payment_methods (wallet_id, name, nature)
       VALUES ($1, $2, $3)
       RETURNING id, name, nature, is_active`,
      [walletId, name, nature],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Payment method insert returned no row");
    return mapPaymentMethod(row);
  }

  async update(
    _userId: string,
    walletId: string,
    paymentMethodId: string,
    changes: { name?: string; nature?: PaymentMethodNature; isActive?: boolean },
  ): Promise<PaymentMethod | null> {
    const result = await this.database.query<PaymentMethodRow>(
      `UPDATE payment_methods
       SET name = COALESCE($3, name),
           nature = COALESCE($4, nature),
           is_active = COALESCE($5, is_active),
           updated_at = now()
       WHERE id = $1 AND wallet_id = $2
       RETURNING id, name, nature, is_active`,
      [paymentMethodId, walletId, changes.name ?? null, changes.nature ?? null, changes.isActive ?? null],
    );
    const row = result.rows[0];
    return row ? mapPaymentMethod(row) : null;
  }
}
