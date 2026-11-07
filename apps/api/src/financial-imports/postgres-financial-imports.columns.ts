// The read side of an import session: the column lists that every query selects. They are long and
// purely declarative, and the session-state expressions among them hold the subtlest rule of the
// module — whether an import can still be undone, which depends on every kind of result an item may
// have produced. Keeping them here makes the repository readable and gives this rule one home.

export const sessionColumns = `
  session.id,
  session.format,
  session.kind,
  session.credit_card_id,
  (SELECT session_card.alias FROM credit_cards AS session_card
   WHERE session_card.id = session.credit_card_id AND session_card.wallet_id = session.wallet_id) AS credit_card_name,
  (SELECT session_card.closing_day FROM credit_cards AS session_card
   WHERE session_card.id = session.credit_card_id AND session_card.wallet_id = session.wallet_id) AS credit_card_closing_day,
  (SELECT session_card.due_day FROM credit_cards AS session_card
   WHERE session_card.id = session.credit_card_id AND session_card.wallet_id = session.wallet_id) AS credit_card_due_day,
  session.original_filename,
  session.file_size_bytes,
  session.file_hash,
  session.status,
  session.item_count,
  session.valid_count,
  session.duplicate_count,
  session.invalid_count,
  session.uncategorized_count,
  session.imported_count,
  session.failure_message,
  session.confirmed_at,
  session.completed_at,
  session.failed_at,
  session.undone_at,
  session.created_at,
  session.updated_at,
  -- An imported item results in an income, an expense, a statement credit or a statement payment,
  -- and every one of them has to be checked here: the undo refuses to run when any of them changed,
  -- so a type left out would announce an undo the endpoint then refuses.
  (
    session.status = 'completed'
    AND session.imported_count > 0
    AND NOT EXISTS (
      SELECT 1
      FROM import_items AS checked_item
      LEFT JOIN incomes AS checked_income
        ON checked_income.id = checked_item.resulting_income_id
       AND checked_income.wallet_id = checked_item.wallet_id
      LEFT JOIN expenses AS checked_expense
        ON checked_expense.id = checked_item.resulting_expense_id
       AND checked_expense.wallet_id = checked_item.wallet_id
      LEFT JOIN credit_card_statement_credits AS checked_credit
        ON checked_credit.id = checked_item.resulting_card_credit_id
       AND checked_credit.wallet_id = checked_item.wallet_id
      LEFT JOIN credit_card_statement_payments AS checked_payment
        ON checked_payment.id = checked_item.resulting_statement_payment_id
       AND checked_payment.wallet_id = checked_item.wallet_id
      LEFT JOIN wallet_transfers AS checked_transfer
        ON checked_transfer.id = checked_item.resulting_wallet_transfer_id
       AND (checked_transfer.from_wallet_id = checked_item.wallet_id
         OR checked_transfer.to_wallet_id = checked_item.wallet_id)
      WHERE checked_item.import_session_id = session.id
        AND checked_item.validation_status = 'imported'
        AND (
          (checked_item.type = 'income' AND (
            checked_income.id IS NULL OR checked_income.updated_at IS DISTINCT FROM checked_item.resulting_updated_at
          ))
          OR
          (checked_item.type = 'expense' AND (
            checked_expense.id IS NULL OR checked_expense.updated_at IS DISTINCT FROM checked_item.resulting_updated_at
          ))
          OR
          (checked_item.type = 'card_credit' AND (
            checked_credit.id IS NULL OR checked_credit.updated_at IS DISTINCT FROM checked_item.resulting_updated_at
          ))
          OR
          (checked_item.type = 'transfer' AND checked_item.resulting_wallet_transfer_id IS NULL AND (
            checked_payment.id IS NULL OR checked_payment.updated_at IS DISTINCT FROM checked_item.resulting_updated_at
          ))
          OR
          (checked_item.type = 'transfer' AND checked_item.resulting_wallet_transfer_id IS NOT NULL AND (
            checked_transfer.id IS NULL OR checked_transfer.updated_at IS DISTINCT FROM checked_item.resulting_updated_at
          ))
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM import_items AS paid_item
      JOIN credit_card_statements AS paid_statement
        ON paid_statement.wallet_id = paid_item.wallet_id
       AND paid_statement.credit_card_id = session.credit_card_id
       AND paid_statement.closing_date = paid_item.statement_closing_date
      WHERE paid_item.import_session_id = session.id
        AND paid_item.validation_status = 'imported'
        AND paid_statement.paid_date IS NOT NULL
    )
  ) AS can_undo,
  CASE
    WHEN session.status <> 'completed' THEN 'Somente importações concluídas podem ser desfeitas.'
    WHEN session.imported_count = 0 THEN 'A importação não possui lançamentos para desfazer.'
    WHEN EXISTS (
      SELECT 1
      FROM import_items AS blocked_item
      LEFT JOIN incomes AS blocked_income
        ON blocked_income.id = blocked_item.resulting_income_id
       AND blocked_income.wallet_id = blocked_item.wallet_id
      LEFT JOIN expenses AS blocked_expense
        ON blocked_expense.id = blocked_item.resulting_expense_id
       AND blocked_expense.wallet_id = blocked_item.wallet_id
      LEFT JOIN credit_card_statement_credits AS blocked_credit
        ON blocked_credit.id = blocked_item.resulting_card_credit_id
       AND blocked_credit.wallet_id = blocked_item.wallet_id
      LEFT JOIN credit_card_statement_payments AS blocked_payment
        ON blocked_payment.id = blocked_item.resulting_statement_payment_id
       AND blocked_payment.wallet_id = blocked_item.wallet_id
      LEFT JOIN wallet_transfers AS blocked_transfer
        ON blocked_transfer.id = blocked_item.resulting_wallet_transfer_id
       AND (blocked_transfer.from_wallet_id = blocked_item.wallet_id
         OR blocked_transfer.to_wallet_id = blocked_item.wallet_id)
      WHERE blocked_item.import_session_id = session.id
        AND blocked_item.validation_status = 'imported'
        AND (
          (blocked_item.type = 'income' AND (
            blocked_income.id IS NULL OR blocked_income.updated_at IS DISTINCT FROM blocked_item.resulting_updated_at
          ))
          OR
          (blocked_item.type = 'expense' AND (
            blocked_expense.id IS NULL OR blocked_expense.updated_at IS DISTINCT FROM blocked_item.resulting_updated_at
          ))
          OR
          (blocked_item.type = 'card_credit' AND (
            blocked_credit.id IS NULL OR blocked_credit.updated_at IS DISTINCT FROM blocked_item.resulting_updated_at
          ))
          OR
          (blocked_item.type = 'transfer' AND blocked_item.resulting_wallet_transfer_id IS NULL AND (
            blocked_payment.id IS NULL OR blocked_payment.updated_at IS DISTINCT FROM blocked_item.resulting_updated_at
          ))
          OR
          (blocked_item.type = 'transfer' AND blocked_item.resulting_wallet_transfer_id IS NOT NULL AND (
            blocked_transfer.id IS NULL OR blocked_transfer.updated_at IS DISTINCT FROM blocked_item.resulting_updated_at
          ))
        )
    ) THEN 'Um ou mais lançamentos importados foram alterados ou removidos.'
    WHEN EXISTS (
      SELECT 1
      FROM import_items AS paid_item
      JOIN credit_card_statements AS paid_statement
        ON paid_statement.wallet_id = paid_item.wallet_id
       AND paid_statement.credit_card_id = session.credit_card_id
       AND paid_statement.closing_date = paid_item.statement_closing_date
      WHERE paid_item.import_session_id = session.id
        AND paid_item.validation_status = 'imported'
        AND paid_statement.paid_date IS NOT NULL
    ) THEN 'Uma fatura com lançamentos desta importação já foi paga.'
    ELSE NULL
  END AS undo_blocked_reason`;

export const itemColumns = `
  item.id,
  item.sequence,
  item.transaction_date,
  item.description,
  abs(item.signed_amount)::text AS amount,
  item.type,
  item.category_id,
  item.subcategory_id,
  item.categorization_source,
  item.validation_status,
  item.error_message,
  item.is_repairable,
  item.duplicate_override_allowed,
  item.statement_closing_date,
  item.credit_card_statement_id,
  item.transfer_counterpart_wallet_id,
  COALESCE(item.wallet_transfer_id, item.resulting_wallet_transfer_id) AS wallet_transfer_id,
  item.created_at,
  item.updated_at`;
