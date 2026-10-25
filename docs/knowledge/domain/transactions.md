# Movimentações, saldos e metas

**Status:** implementado
**Última revisão:** 25/10/2026

## Entradas

As entradas registram valor, data, descrição e classificação. O tipo de saldo distingue dinheiro, VA/VR e AHO. Benefícios permanecem separados do saldo em dinheiro.

## Despesas

As despesas pertencem a uma carteira e podem usar uma forma de pagamento cadastrada. Categorias e subcategorias classificam a finalidade do gasto; a forma de pagamento descreve o meio usado.

- Débito e Pix afetam o saldo financeiro do período.
- VA/VR e AHO consomem o saldo do benefício correspondente.
- Crédito é associado a cartão e ciclo de fatura; o gasto não é debitado imediatamente como pagamento à vista.

## Metas

Metas de investimento possuem objetivo, progresso e aportes. Um aporte deve alterar o progresso da meta de forma consistente com a movimentação financeira correspondente. Encerramento e exclusão precisam preservar a integridade do histórico.

## Invariantes

- Valores monetários devem manter precisão decimal e moeda consistente.
- A carteira do recurso relacionado deve coincidir com a carteira da movimentação.
- Operações compostas devem ser atômicas.
- Regras de saldo vivem na API; a Web apenas apresenta e envia comandos.

## Fontes verificáveis

- [`apps/api/src/incomes`](../../../apps/api/src/incomes)
- [`apps/api/src/expenses`](../../../apps/api/src/expenses)
- [`apps/api/src/investment-goals`](../../../apps/api/src/investment-goals)
- [`apps/api/src/payment-methods`](../../../apps/api/src/payment-methods)
- [`apps/web/src/incomes`](../../../apps/web/src/incomes)
- [`apps/web/src/expenses`](../../../apps/web/src/expenses)
- [`apps/web/src/goals`](../../../apps/web/src/goals)
