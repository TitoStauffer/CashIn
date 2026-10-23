# Web do CashIn

Frontend React, TypeScript e Vite. Requer Node.js e npm nas versões adotadas pelo projeto. Instale com `npm ci`; execute `npm run dev` no ambiente local descrito no README da raiz.

## Dashboard de saúde financeira — DEV-38

Após a autenticação, `/dashboard` mostra os registros da carteira ativa no mês selecionado. O seletor de mês/ano permanece disponível durante carregamento e erro. Uma falha em qualquer consulta exibe uma mensagem com tentativa novamente; dados de outra carteira ou período nunca permanecem visíveis enquanto a nova consulta está pendente. Respostas de consultas canceladas são ignoradas.

Cada carregamento faz três consultas, independentemente da quantidade de metas: resumo do mês selecionado, resumo do mês anterior completo e metadados das metas. Veja o [contrato da API](../../docs/dashboard-summary-contract.md).

- **Entradas totais:** dinheiro e benefícios registrados no mês.
- **Despesas registradas:** todas as despesas do mês, incluindo benefícios e compras no crédito. Pagamentos de faturas não são somados novamente.
- **Aportes:** valores destinados às metas no período, incluindo metas encerradas.
- **Fluxo restante em dinheiro:** entradas em dinheiro menos despesas em dinheiro, faturas pagas e aportes. Pode ser negativo e representa o movimento do período, sem saldo inicial bancário. A composição e os valores da fórmula ficam visíveis no painel.
- **Benefícios:** VA, VR, VA/VR e AHO são exibidos conforme os tipos retornados pela API, separados do dinheiro. A API atual unifica os tipos legados de VA/VR.
- **Crédito:** compras são consideradas na data da compra; pagamentos de faturas reduzem o dinheiro uma vez, na data do pagamento. O link para cartões é uma consulta geral, pois essa tela possui seu próprio filtro por fechamento.
- **Categorias:** Top 5 de entradas e Top 5 de despesas, ordenados pelo valor total decrescente; empates usam o nome em português. Os totais não incluem novamente pagamentos de faturas.
- **Comparação:** mês selecionado versus mês anterior completo, incluindo mudança de ano. Mostra os valores dos dois períodos, diferenças absolutas e até cinco maiores variações por categoria de entradas e despesas. Quando algum mês não possui movimentações, informa a indisponibilidade da comparação. Não faz projeções ou recomendações financeiras.
- **Metas:** acumulado de todo o histórico, alvo, percentual, restante (mínimo zero), prazo cadastrado e aportes do período. A barra visual termina em 100%, enquanto o percentual informado preserva eventual superação do alvo. Aparecem metas ativas e metas encerradas com aportes no mês.

Somas, diferenças e ordenações monetárias usam `BigInt` em centavos. Somente percentuais de barras limitados entre 0 e 100 são convertidos em `Number`. A apresentação da moeda mantém centavos de totais agregados acima do limite de um lançamento; o limite de entrada de valores permanece em 12 dígitos inteiros.

## Links para os registros

- `/dashboard?month=AAAA-MM` abre o período indicado.
- `/incomes?month=AAAA-MM&categoryId=...` e `/expenses?month=AAAA-MM&categoryId=...` preservam mês e categoria dos indicadores. O filtro de categoria é visível e pode ser alterado ou removido; lista e total usam os mesmos registros. A troca de carteira limpa a categoria da carteira anterior.
- `/goals?month=AAAA-MM` inclui metas ativas e encerradas e filtra os aportes ao expandir cada meta. O progresso continua representando todo o histórico.
- `/goals?month=AAAA-MM&goalId=...` abre a meta vinculada e seus aportes do período. Somente essa meta gera a consulta adicional de aportes. O usuário pode remover os filtros e voltar ao histórico completo.
- Mês ausente ou inválido utiliza o mês atual nas páginas mensais. Em metas, um mês inválido mantém a visão histórica normal.

Todos os links usam a carteira ativa já armazenada pela aplicação. Categorias e metas são consultadas dentro dessa carteira; identificadores de links não alteram o contexto de autorização.

## Validação

```sh
npm run lint
npm run build
npm run test:coverage
npm audit
```

`build` inclui a validação TypeScript. A cobertura do código do dashboard exige pelo menos 80% em linhas, instruções, funções e ramificações. A suíte cobre composição do caixa/crédito/benefícios, centavos grandes, Top 5, meses completos, metas, filtros de destino, erros, repetição e cancelamento de respostas antigas. O CI executa lint, testes com cobertura e build; o SonarQube Cloud avalia qualidade e segurança no fluxo do repositório.
