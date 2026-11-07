# Cartões de crédito e faturas

**Status:** implementado; estornos desde a DEV-56 e pagamentos parciais desde a DEV-85
**Última revisão:** 07/11/2026

## Modelo

- Cartões pertencem a uma carteira e possuem datas de fechamento e vencimento configuráveis.
- Uma despesa no crédito é vinculada a um cartão e atribuída ao ciclo de fatura calculado pelas datas do cartão.
- A fatura consolida os gastos do ciclo.
- Os pagamentos da fatura ficam em `credit_card_statement_payments`, com origem `manual` ou `bank_statement`. O valor pago é a soma deles, e não uma coluna da fatura: assim um pagamento parcial também reduz o saldo em dinheiro.
- Um pagamento reduz a fatura; a liquidação (`paid_date`) ocorre quando os pagamentos cobrem o total e é ela que bloqueia novas compras, novos pagamentos e o desfazer de importações. A compra individual não reduz o saldo disponível como pagamento à vista.
- Estornos e reembolsos são créditos da fatura (`credit_card_statement_credits`), opcionalmente vinculados à compra original. O total da fatura é compras menos créditos, e a quitação cobra esse saldo líquido. Ela é recusada quando os créditos cobrem as compras. Créditos nunca são receitas.

## Limites atuais

O escopo atual trata fatura, estornos como créditos na fatura, pagamento integral e parcial e conciliação do pagamento com o extrato bancário. Parcelamento, juros e saldo credor transportado para a fatura seguinte exigem decisão e ticket próprios. Estornos ainda não abatem `expenseTotal`, `creditPurchaseTotal` nem o gasto por categoria do dashboard.

## Invariantes

- Cartão, despesa e fatura devem pertencer à mesma carteira.
- Alterar datas do cartão não deve reclassificar silenciosamente histórico já consolidado.
- Pagar uma mesma fatura novamente deve ser impedido ou tratado de forma idempotente.
- Uma fatura com compras, créditos ou pagamentos registrados não é removida. Uma fatura vazia e sem pagamento pode ser removida ao excluir ou desfazer lançamentos. Um pagamento é dinheiro que já saiu da conta: a fatura que o guarda permanece mesmo sem compras, para que o valor pago não desapareça do cartão nem do saldo.

## Fontes verificáveis

- [`apps/api/src/credit-cards/credit-cards.service.ts`](../../../apps/api/src/credit-cards/credit-cards.service.ts)
- [`apps/api/src/expenses/expenses.service.ts`](../../../apps/api/src/expenses/expenses.service.ts)
- [`apps/web/src/creditCards/CreditCardsPage.tsx`](../../../apps/web/src/creditCards/CreditCardsPage.tsx)
- [`apps/web/src/expenses/ExpensesPage.tsx`](../../../apps/web/src/expenses/ExpensesPage.tsx)
- [`apps/api/src/credit-cards/postgres-credit-cards.repository.ts`](../../../apps/api/src/credit-cards/postgres-credit-cards.repository.ts)
- [`apps/api/migrations/018_credit_card_statement_imports.sql`](../../../apps/api/migrations/018_credit_card_statement_imports.sql)
- [`apps/api/src/expenses/postgres-expenses.repository.ts`](../../../apps/api/src/expenses/postgres-expenses.repository.ts)
- [`apps/api/migrations/019_credit_card_statement_payments.sql`](../../../apps/api/migrations/019_credit_card_statement_payments.sql)
