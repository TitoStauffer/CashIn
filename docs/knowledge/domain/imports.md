# Importação financeira OFX e CSV

**Status:** importação OFX e CSV com regras por carteira (DEV-55), faturas de cartão (DEV-56), conciliação do pagamento da fatura na API (DEV-85) e na tela (DEV-57) e transferências entre carteiras na API (DEV-88) e na tela (DEV-58)
**Última revisão:** 07/11/2026

## Fluxo definido

1. Usuário escolhe uma carteira e envia um arquivo permitido.
2. A API valida formato e limites, calcula a identidade do arquivo e cria a importação.
3. O parser converte as movimentações OFX ou CSV em itens de prévia normalizados.
4. O usuário revisa, edita, ignora ou classifica os itens.
5. A confirmação grava as movimentações em uma transação atômica.
6. Histórico e desfazer usam o vínculo entre importação e movimentações criadas.

## Idempotência e duplicidade

- Itens usam impressão digital de data, valor assinado, tipo e descrição normalizada para detectar repetição entre OFX, CSV e importações anteriores da mesma carteira.
- FITID já importado da mesma conta OFX é duplicidade confirmada e fica bloqueado; coincidência apenas pela impressão digital aparece como possível duplicidade, com justificativa para revisão.
- Possíveis duplicidades só são importadas após decisão explícita do usuário, persistida para o fingerprint revisado; mudar a identidade invalida essa decisão. A confirmação revalida duplicidades históricas e entre itens editados da sessão; ao encontrar novas, devolve a prévia sem importar parcialmente. Confirmações concorrentes são serializadas por carteira e revalidadas antes de gravar.
- O identificador bruto da conta não é persistido; a sessão conserva somente seu hash.

## Classificação e regras por carteira

- Itens sem categoria ficam visíveis como "Não categorizada" e não são importados até receberem uma categoria.
- Regras associam tipo (`income`/`expense`) e descrição normalizada a categoria e subcategoria; há no máximo uma por carteira, tipo e descrição normalizada, sem prioridade entre regras porque a correspondência é exata.
- Uma regra só nasce de ação explícita: gestão de regras ou confirmação a partir de um item salvo com categoria manual. Nada é aprendido silenciosamente.
- Regras ativas classificam, ao gerar a prévia, apenas itens sem categoria, válidos e não duplicados; a origem fica em `import_items.categorization_source` (`rule`/`manual`). A escolha do usuário sempre prevalece.
- Regras são compartilhadas pelos membros da carteira e isoladas de outras carteiras.
- A regra não tem FK para categoria: se a categoria ou subcategoria for removida, ela fica `isStale`, deixa de classificar e exige reclassificação.

## Estado atual

A infraestrutura de upload, prévia, confirmação, histórico e desfazer existe. O parser padrão é `DefaultFinancialImportParser`: extratos bancários OFX 1.x (SGML) e 2.x (XML) em BRL são interpretados em UTF-8, UTF-16, Windows-1252 e ISO-8859-1. Cada arquivo deve conter um único bloco bancário `STMTRS`; múltiplos extratos são recusados antes da prévia para não misturar contas, moedas ou `FITID`. Valores positivos sugerem entrada, negativos sugerem saída e `XFER` permanece pendente de conciliação. Linhas malformadas ficam visíveis com motivo explícito quando podem ser armazenadas com segurança. `NAME` e `MEMO` multilinha são preservados e normalizados na descrição exibida; conteúdo XML `CDATA` permanece literal, e tags aparentes dentro de `CDATA` ou comentários não participam da estrutura do extrato.

CSV aceita vírgula ou ponto e vírgula, UTF-8, Windows-1252 e ISO-8859-1, datas brasileiras, norte-americanas ou ISO e valores `pt-BR` ou `en-US`, sempre normalizados como texto decimal. O usuário inspeciona uma amostra, pode repetir a inspeção com os cinco campos de formato corrigidos, confirma o mapeamento e pode salvar ou editar modelos reutilizáveis, sempre isolados por carteira. Linhas inválidas permanecem na prévia com número físico e motivo, mas recebem sequência ordinal independente das linhas vazias ou multilinha. Caractere nulo e sintaxe de aspas malformada são rejeitados estruturalmente, sem sanitização ou concatenação silenciosa. A configuração exige exatamente `amount` com crédito/débito nulos ou `amount` nulo com o par crédito/débito; no modo separado, vazio e zero são ausência, enquanto conteúdo monetário inválido bloqueia a linha mesmo que a outra coluna seja válida.

Sessões desfeitas não bloqueiam uma importação futura, pois somente itens ainda marcados como importados participam da detecção.

## Faturas de cartão (DEV-56)

- **Seleção do cartão:** a sessão de fatura (`kind = credit_card_statement`) exige um cartão ativo da carteira, gravado em `import_sessions.credit_card_id` com FK composta pela carteira.
- **Formatos:** o OFX deve ter um único `CCSTMTRS`; o CSV informa o sinal das compras (`x-card-amount-sign`).
- **Sinais:** são normalizados para compra negativa (`expense`) e crédito positivo (`card_credit`), o que mantém a impressão digital igual entre OFX e CSV.
- **Pagamento da fatura anterior:** a linha positiva com `PAYMENT` ou "pagamento" vira `transfer` e não é importada, porque quem registra o pagamento é a conciliação feita no extrato bancário.
- **Fatura de destino:** `import_items.statement_closing_date` é calculado pelo fechamento do cartão e pode ser movido para a fatura anterior ou a seguinte. Item em fatura paga fica inválido e reparável, e a confirmação revalida.
- **Confirmação:**
  - Compras viram despesas de natureza `credit_card` na fatura do item e só saem do saldo no pagamento.
  - Créditos viram linhas de `credit_card_statement_credits`, que abatem a fatura e nunca são receitas.
  - O vínculo com a compra original exige uma única correspondência inequívoca (mesmo cartão, descrição sem prefixo de estorno, data anterior ou igual e saldo estornável suficiente).
- **Duplicidade:** é procurada só entre sessões do mesmo cartão. Bancárias só se comparam com bancárias.
- **Desfazer:** remove compras, créditos e faturas que ficarem vazias. É bloqueado se algo foi alterado ou se uma fatura afetada foi paga.

## Conciliação do pagamento da fatura (DEV-85)

- **Onde acontece:** na prévia de um **extrato bancário**, onde o pagamento do cartão aparece como débito comum.
- **Sugestão:** só para débito cuja descrição aponte cartão ou fatura, nunca para qualquer "pagamento". As candidatas são faturas da carteira não liquidadas, com saldo devedor e vencimento até 15 dias da data do pagamento.
- **Correspondência única** (uma candidata com saldo devedor igual ao valor) vira `transfer` conciliado e `valid`. **Ambígua** vira `transfer` sem fatura, com as candidatas expostas para o usuário escolher; nada é confirmado sozinho.
- **Confirmação:** cria o pagamento em `credit_card_statement_payments` e não lança a compra de novo, então a fatura não é contada duas vezes. `transfer` sem fatura continua bloqueando a confirmação.
- **Desfazer:** remove os pagamentos e reabre a fatura que eles tinham liquidado. Uma fatura que ainda tenha pagamento registrado nunca é removida.
- **Na tela (DEV-57):** o item apresentado como pagamento traz um seletor com as faturas candidatas, cada uma com cartão, vencimento e saldo devedor; a escolha é salva no próprio item e desfeita ao mudar o tipo. Sem candidata, a prévia explica que não há fatura em aberto a liquidar em vez de oferecer uma lista vazia. A tela do cartão lista os pagamentos com sua origem, mostra o que falta pagar e aceita pagamento parcial.

## Transferências entre carteiras (DEV-88)

- **O que é:** dinheiro que sai de uma carteira e entra em outra não é receita nem despesa. A transferência é registrada uma vez em `wallet_transfers` (origem, destino, valor, data) e cada lado é uma linha do extrato da carteira correspondente.
- **Lados independentes:** os dois lados podem ser importados em qualquer ordem, ou só um deles existir. O lado que uma linha representa é a própria carteira dela: saída quando é `from_wallet_id`, entrada quando é `to_wallet_id`. Um índice único garante uma linha importada por lado.
- **Sugestão:** linha marcada como transferência pelo arquivo (`XFER`) aguarda a carteira do outro lado. Saída ou entrada comum vira transferência apenas quando existe transferência pendente com o mesmo valor e data até três dias de distância — é o que reconhece o segundo lado em extratos que não marcam transferência. Mais de uma candidata fica pendente de escolha.
- **Dois destinos do mesmo tipo:** um item `transfer` liquida uma fatura (DEV-85) **ou** espelha outra carteira, nunca as duas; o banco e a API recusam a combinação. Linha cuja descrição aponta pagamento de cartão fica com a conciliação de fatura, que tem a sugestão mais específica.
- **Isolamento:** só as carteiras que a pessoa autenticada acessa são oferecidas, e uma transferência só aparece para as duas carteiras que são os seus extremos.
- **Caixa:** `transferOutTotal` e `transferInTotal` entram apenas no `cashBalance`, reduzindo a origem e aumentando o destino. Nenhuma receita ou despesa é criada.
- **Desfazer:** libera o lado da importação desfeita. A transferência permanece se o outro lado continuar conciliado e volta a ser oferecida como candidata; sem nenhum lado, é removida.
- **Na tela (DEV-58):** as duas conciliações de um `transfer` — a fatura que ele paga e a carteira do outro lado — aparecem como um único campo "Conciliar com", agrupado em fatura paga, transferência já registrada e carteira de destino ou origem. Escolher uma limpa a outra, que é o que a API exige. A carteira é nomeada pela direção da linha ("para Poupança", "de Família"). Sem fatura em aberto e sem outra carteira, a prévia explica em vez de oferecer uma lista vazia. No dashboard, o enviado entra na saída de dinheiro e o recebido na entrada, com as duas linhas nomeadas à parte e a nota de que transferência não é receita nem despesa.

## Fontes verificáveis

- [`docs/financial-imports-contract.md`](../../financial-imports-contract.md)
- [`apps/api/src/financial-imports/financial-imports.service.ts`](../../../apps/api/src/financial-imports/financial-imports.service.ts)
- [`apps/api/src/financial-imports/financial-imports.parser.ts`](../../../apps/api/src/financial-imports/financial-imports.parser.ts)
- [`apps/api/src/financial-imports/financial-imports.csv.ts`](../../../apps/api/src/financial-imports/financial-imports.csv.ts)
- [`apps/api/src/financial-imports/financial-imports.parser.test.ts`](../../../apps/api/src/financial-imports/financial-imports.parser.test.ts)
- [`apps/api/src/financial-imports/postgres-financial-imports.repository.ts`](../../../apps/api/src/financial-imports/postgres-financial-imports.repository.ts)
- [`apps/api/src/financial-imports/postgres-wallet-transfer-reconciliation.ts`](../../../apps/api/src/financial-imports/postgres-wallet-transfer-reconciliation.ts)
- [`apps/api/migrations/020_wallet_transfers.sql`](../../../apps/api/migrations/020_wallet_transfers.sql)
- [`apps/api/src/financial-imports/financial-categorization-rules.service.ts`](../../../apps/api/src/financial-imports/financial-categorization-rules.service.ts)
- [`apps/api/src/financial-imports/postgres-financial-categorization-rules.repository.ts`](../../../apps/api/src/financial-imports/postgres-financial-categorization-rules.repository.ts)
- [`apps/web/src/imports/FinancialImportsPage.tsx`](../../../apps/web/src/imports/FinancialImportsPage.tsx)
- [`apps/web/src/imports/ImportPreview.tsx`](../../../apps/web/src/imports/ImportPreview.tsx)
- [`apps/web/src/dashboard/dashboardMetrics.ts`](../../../apps/web/src/dashboard/dashboardMetrics.ts)
- [`apps/api/migrations/018_credit_card_statement_imports.sql`](../../../apps/api/migrations/018_credit_card_statement_imports.sql)
- [`apps/api/src/financial-imports/postgres-card-statement-imports.ts`](../../../apps/api/src/financial-imports/postgres-card-statement-imports.ts)
- [`apps/api/src/financial-imports/postgres-bank-payment-reconciliation.ts`](../../../apps/api/src/financial-imports/postgres-bank-payment-reconciliation.ts)
- [`apps/api/migrations/019_credit_card_statement_payments.sql`](../../../apps/api/migrations/019_credit_card_statement_payments.sql)
- [`apps/api/src/financial-imports/postgres-credit-card-statement-imports.integration.test.ts`](../../../apps/api/src/financial-imports/postgres-credit-card-statement-imports.integration.test.ts)
