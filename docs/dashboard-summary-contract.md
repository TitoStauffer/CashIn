# Contrato do resumo financeiro do dashboard — DEV-38

`GET /financial-summary` fornece os componentes monetários, categorias e aportes por meta do dashboard de saúde financeira. O cliente usa esse resumo para o período selecionado e consulta separadamente o período anterior para comparar os valores reais. O Top 5 é calculado a partir das categorias do período, sem um novo endpoint.

## Consulta e representação

O endpoint exige sessão autenticada e usa a carteira acessível selecionada pelo cabeçalho `x-wallet-id`, ou a carteira pessoal quando o cabeçalho é omitido. Todas as agregações ficam restritas a essa carteira, inclusive quando o mesmo usuário possui várias carteiras.

Os parâmetros opcionais `from` e `to` aceitam datas `AAAA-MM-DD`, com limites inclusivos. Cada parâmetro também pode ser usado sozinho; sem ambos, a consulta inclui todos os registros da carteira. Datas inválidas e intervalos invertidos retornam `400`. Carteiras inexistentes ou sem acesso retornam `404`, conforme o contrato existente de contexto da carteira.

Valores monetários continuam sendo strings decimais, com precisão de centavos e `"0.00"` em períodos vazios. Os quatro componentes adicionados e cada `contributionsByGoal[].amount` sempre apresentam duas casas decimais; os campos existentes preservam sua representação, que pode ser `"100"` ou `"100.00"` conforme a escala dos registros. As somas e subtrações são executadas com `numeric` no PostgreSQL e retornadas como texto, sem conversão intermediária para ponto flutuante em JavaScript. A formatação usa `trunc(total, 2)`, sem limitar a precisão inteira dos agregados; os valores persistidos já são restritos a centavos.

## Campos adicionados

| Campo | Composição | Data aplicada ao filtro |
| --- | --- | --- |
| `cashIncomeTotal` | Receitas com `balance_type = cash`; exclui benefícios. | Data da receita |
| `cashExpenseTotal` | Despesas com natureza registrada `immediate` ou sem natureza nos registros legados. | Data da despesa |
| `creditPurchaseTotal` | Despesas com natureza registrada `credit_card`, inclusive registros legados sem fatura vinculada. | Data da compra/despesa |
| `cardCreditTotal` | Estornos e reembolsos registrados nas faturas (`credit_card_statement_credits`). | Data do crédito |
| `unlinkedCardCreditTotal` | A parte de `cardCreditTotal` sem compra original conhecida. | Data do crédito |
| `cardPaymentTotal` | Pagamentos registrados nas faturas, incluindo pagamentos parciais de faturas ainda em aberto. | Data de cada pagamento |
| `transferOutTotal` | Transferências entre carteiras que saíram desta carteira. | Data da transferência |
| `transferInTotal` | Transferências entre carteiras que entraram nesta carteira. | Data da transferência |

A classificação usa a natureza registrada na despesa, preservando o histórico mesmo se a forma de pagamento mudar posteriormente.

## Aportes por meta

`contributionsByGoal` é um array de `{ "goalId": "uuid", "amount": "0.30" }`, com a soma dos aportes de cada meta no período e carteira consultados. O agrupamento usa a mesma seleção de registros de `contributionTotal`; a soma dos itens equivale numericamente a esse total.

Os limites de data são inclusivos e se aplicam à data do aporte. O resultado inclui o histórico de metas ativas e encerradas, ordenado por `goalId`. Metas sem aportes no intervalo não geram item; sem aportes na consulta, o valor é `[]`. Aportes de outras carteiras são excluídos mesmo quando pertencem ao mesmo usuário.

O cliente combina os itens pelo identificador com `GET /investment-goals`, que fornece título, alvo (`targetAmount`), acumulado geral (`contributedAmount`), percentual (`progressPercentage`), prazo (`dueDate`) e situação. A ausência de item corresponde a `"0.00"` de aportes no período. O acumulado geral e seu percentual não são recalculados com o período; o restante usa os dados gerais da meta. Esta resposta não calcula previsões.

## Semântica preservada

`incomeTotal` agrega todas as receitas, incluindo benefícios. `expenseTotal` agrega todas as despesas, incluindo compras no crédito e uso de benefícios, **menos os estornos de fatura do período**. Pagamentos de fatura não geram uma nova despesa nesses totais nem em `expenseByCategory`.

`contributionTotal` agrega os aportes pela data do aporte e continua separado das despesas. `incomeByCategory` e `expenseByCategory` mantêm o agrupamento de todas as receitas e despesas pelas categorias da carteira.

A fórmula existente permanece:

```text
cashBalance = cashIncomeTotal - cashExpenseTotal - contributionTotal - cardPaymentTotal
              - transferOutTotal + transferInTotal
availableBalance = cashBalance
```

`cashBalance` representa o fluxo líquido de caixa do período consultado. Ele pode ser negativo e não representa um saldo bancário acumulado nem incorpora um saldo inicial. Sem filtros, representa o fluxo de todos os registros armazenados.

Uma compra no crédito entra em `expenseTotal` e `creditPurchaseTotal` na data da compra. Cada pagamento entra em `cardPaymentTotal` na sua data e reduz o caixa uma única vez, inclusive quando é parcial e a fatura continua em aberto. Não se deve subtrair `creditPurchaseTotal` novamente da fórmula de caixa. Compra e pagamento podem pertencer a períodos diferentes.

Uma transferência entre carteiras não é receita nem despesa: ela não entra em `incomeTotal`, `expenseTotal`, `incomeByCategory` nem `expenseByCategory`. Ela aparece apenas no caixa, reduzindo o da carteira de origem por `transferOutTotal` e aumentando o da carteira de destino por `transferInTotal`. Uma transferência existe assim que um dos dois lados é conciliado, porque o dinheiro já mudou de lugar; conciliar o segundo lado depois não a duplica.

`benefitBalances` continua separando VA/VR unificado (`food_meal_benefit`, somando os tipos legados `food_benefit` e `meal_benefit`) e auxílio home office (`home_office_benefit`). Esses benefícios não compõem os totais de caixa.

## Estornos de fatura

Um estorno ou reembolso devolve o dinheiro, então a compra que ele reverte deixa de ser um gasto. O crédito é subtraído de `expenseTotal` e de `creditPurchaseTotal`, e do item de `expenseByCategory` da **categoria da compra original**. Um estorno integral zera o efeito da compra; um estorno parcial reduz exatamente o valor estornado, em centavos.

O crédito pertence ao período da **sua própria data**, mesmo quando a compra revertida é de outro período — aquele período realmente gastou o dinheiro. Em consequência, `expenseTotal`, `creditPurchaseTotal` e o valor de uma categoria **podem ser negativos**: é o retrato de um período que devolveu mais do que gastou. Uma categoria cujo saldo líquido é zero continua na lista, porque teve movimento.

Um crédito sem compra original conhecida — não casado na importação, ou cuja compra foi excluída depois — reduz os totais, mas nenhuma categoria: não há compra que diga qual. Esse valor é informado em `unlinkedCardCreditTotal`, em vez de ser escondido ou atribuído por suposição. `cardCreditTotal` existe para que o cliente possa explicar a despesa menor.

Créditos não são receita: não entram em `incomeTotal` nem em `incomeByCategory`. Eles também não alteram o caixa, porque `cardPaymentTotal` já é o valor efetivamente pago, líquido dos créditos, e `cashExpenseTotal` só considera despesas imediatas. A fórmula de `cashBalance` permanece inalterada.

## Exemplo

Com receita em dinheiro de `100.00`, despesa imediata de `5.00`, compra no crédito de `10.00`, estorno de `4.00` sobre essa compra, aporte de `20.00` e pagamento de fatura de `6.00` no período, os campos são:

```json
{
  "incomeTotal": "100.00",
  "expenseTotal": "11.00",
  "cashIncomeTotal": "100.00",
  "cashExpenseTotal": "5.00",
  "creditPurchaseTotal": "6.00",
  "cardCreditTotal": "4.00",
  "unlinkedCardCreditTotal": "0.00",
  "cardPaymentTotal": "6.00",
  "transferOutTotal": "0.00",
  "transferInTotal": "0.00",
  "contributionTotal": "20.00",
  "contributionsByGoal": [
    { "goalId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "amount": "20.00" }
  ],
  "cashBalance": "69.00",
  "availableBalance": "69.00"
}
```

Os demais campos da resposta continuam presentes. A ampliação é aditiva e não exige migração, nova dependência nem mudança dos filtros existentes.
