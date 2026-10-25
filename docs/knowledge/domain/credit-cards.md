# Cartões de crédito e faturas

**Status:** implementado
**Última revisão:** 25/10/2026

## Modelo

- Cartões pertencem a uma carteira e possuem datas de fechamento e vencimento configuráveis.
- Uma despesa no crédito é vinculada a um cartão e atribuída ao ciclo de fatura calculado pelas datas do cartão.
- A fatura consolida os gastos do ciclo.
- A quitação integral da fatura representa a saída financeira no vencimento; a compra individual não reduz o saldo disponível como pagamento à vista.

## Limites atuais

O escopo atual trata fatura e quitação integral. Parcelamento, pagamento parcial, juros, estorno entre ciclos e conciliação bancária avançada exigem decisão e ticket próprios.

## Invariantes

- Cartão, despesa e fatura devem pertencer à mesma carteira.
- Alterar datas do cartão não deve reclassificar silenciosamente histórico já consolidado.
- Pagar uma mesma fatura novamente deve ser impedido ou tratado de forma idempotente.

## Fontes verificáveis

- [`apps/api/src/credit-cards`](../../../apps/api/src/credit-cards)
- [`apps/api/src/expenses`](../../../apps/api/src/expenses)
- [`apps/web/src/creditCards`](../../../apps/web/src/creditCards)
- [`apps/web/src/expenses`](../../../apps/web/src/expenses)
