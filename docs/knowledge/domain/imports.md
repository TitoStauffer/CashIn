# Importação financeira OFX e CSV

**Status:** importação OFX e CSV com regras de categorização por carteira (DEV-55) e faturas de cartão (DEV-56)
**Última revisão:** 06/11/2026

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
- **Pagamento da fatura anterior:** a linha positiva com `PAYMENT` ou "pagamento" vira `transfer` e não é importada; a conciliação com o extrato fica para a DEV-57.
- **Fatura de destino:** `import_items.statement_closing_date` é calculado pelo fechamento do cartão e pode ser movido para a fatura anterior ou a seguinte. Item em fatura paga fica inválido e reparável, e a confirmação revalida.
- **Confirmação:**
  - Compras viram despesas de natureza `credit_card` na fatura do item e só saem do saldo no pagamento.
  - Créditos viram linhas de `credit_card_statement_credits`, que abatem a fatura e nunca são receitas.
  - O vínculo com a compra original exige uma única correspondência inequívoca (mesmo cartão, descrição sem prefixo de estorno, data anterior ou igual e saldo estornável suficiente).
- **Duplicidade:** é procurada só entre sessões do mesmo cartão. Bancárias só se comparam com bancárias.
- **Desfazer:** remove compras, créditos e faturas que ficarem vazias. É bloqueado se algo foi alterado ou se uma fatura afetada foi paga.

## Fontes verificáveis

- [`docs/financial-imports-contract.md`](../../financial-imports-contract.md)
- [`apps/api/src/financial-imports/financial-imports.service.ts`](../../../apps/api/src/financial-imports/financial-imports.service.ts)
- [`apps/api/src/financial-imports/financial-imports.parser.ts`](../../../apps/api/src/financial-imports/financial-imports.parser.ts)
- [`apps/api/src/financial-imports/financial-imports.csv.ts`](../../../apps/api/src/financial-imports/financial-imports.csv.ts)
- [`apps/api/src/financial-imports/financial-imports.parser.test.ts`](../../../apps/api/src/financial-imports/financial-imports.parser.test.ts)
- [`apps/api/src/financial-imports/postgres-financial-imports.repository.ts`](../../../apps/api/src/financial-imports/postgres-financial-imports.repository.ts)
- [`apps/api/src/financial-imports/financial-categorization-rules.service.ts`](../../../apps/api/src/financial-imports/financial-categorization-rules.service.ts)
- [`apps/api/src/financial-imports/postgres-financial-categorization-rules.repository.ts`](../../../apps/api/src/financial-imports/postgres-financial-categorization-rules.repository.ts)
- [`apps/web/src/imports/FinancialImportsPage.tsx`](../../../apps/web/src/imports/FinancialImportsPage.tsx)
- [`apps/api/migrations/018_credit_card_statement_imports.sql`](../../../apps/api/migrations/018_credit_card_statement_imports.sql)
- [`apps/api/src/financial-imports/postgres-credit-card-statement-imports.integration.test.ts`](../../../apps/api/src/financial-imports/postgres-credit-card-statement-imports.integration.test.ts)
