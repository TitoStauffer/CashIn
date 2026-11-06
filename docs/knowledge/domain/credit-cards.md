# Cartões de crédito e faturas

**Status:** implementado; estornos na fatura desde a DEV-56
**Última revisão:** 06/11/2026

## Modelo

- Cartões pertencem a uma carteira e possuem datas de fechamento e vencimento configuráveis.
- Uma despesa no crédito é vinculada a um cartão e atribuída ao ciclo de fatura calculado pelas datas do cartão.
- A fatura consolida os gastos do ciclo.
- A quitação integral da fatura representa a saída financeira na data informada na quitação; a compra individual não reduz o saldo disponível como pagamento à vista.
- Estornos e reembolsos são créditos da fatura (`credit_card_statement_credits`), opcionalmente vinculados à compra original. O total da fatura é compras menos créditos, e a quitação cobra esse saldo líquido. Ela é recusada quando os créditos cobrem as compras. Créditos nunca são receitas.

## Limites atuais

O escopo atual trata fatura, estornos como créditos na fatura e quitação integral. Parcelamento, pagamento parcial, juros, saldo credor transportado para a fatura seguinte e conciliação bancária avançada exigem decisão e ticket próprios. Estornos ainda não abatem `expenseTotal`, `creditPurchaseTotal` nem o gasto por categoria do dashboard.

## Invariantes

- Cartão, despesa e fatura devem pertencer à mesma carteira.
- Alterar datas do cartão não deve reclassificar silenciosamente histórico já consolidado.
- Pagar uma mesma fatura novamente deve ser impedido ou tratado de forma idempotente.
- Uma fatura com compras ou créditos não é removida. Uma fatura vazia e não paga pode ser removida ao excluir ou desfazer lançamentos.

## Fontes verificáveis

- [`apps/api/src/credit-cards/credit-cards.service.ts`](../../../apps/api/src/credit-cards/credit-cards.service.ts)
- [`apps/api/src/expenses/expenses.service.ts`](../../../apps/api/src/expenses/expenses.service.ts)
- [`apps/web/src/creditCards/CreditCardsPage.tsx`](../../../apps/web/src/creditCards/CreditCardsPage.tsx)
- [`apps/web/src/expenses/ExpensesPage.tsx`](../../../apps/web/src/expenses/ExpensesPage.tsx)
- [`apps/api/src/credit-cards/postgres-credit-cards.repository.ts`](../../../apps/api/src/credit-cards/postgres-credit-cards.repository.ts)
- [`apps/api/migrations/018_credit_card_statement_imports.sql`](../../../apps/api/migrations/018_credit_card_statement_imports.sql)
