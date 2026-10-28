# Importação financeira OFX e CSV

**Status:** fundação e parser OFX implementados; CSV pendente
**Última revisão:** 26/10/2026

## Fluxo definido

1. Usuário escolhe uma carteira e envia um arquivo permitido.
2. A API valida formato e limites, calcula a identidade do arquivo e cria a importação.
3. O parser converte as movimentações OFX em itens de prévia normalizados.
4. O usuário revisa, edita, ignora ou classifica os itens.
5. A confirmação grava as movimentações em uma transação atômica.
6. Histórico e desfazer usam o vínculo entre importação e movimentações criadas.

## Idempotência e duplicidade

- O arquivo possui uma impressão digital que identifica seu conteúdo, mas ainda não há consulta nem restrição de unicidade que impeça o mesmo arquivo de iniciar sessões diferentes.
- Itens OFX preservam `FITID` e uma identidade normalizada; a sessão mantém somente uma impressão SHA-256 da conta, sem persistir o identificador bancário bruto.
- A confirmação repetida da mesma sessão não deve criar novas movimentações; a prevenção entre sessões permanece pendente.
- Suspeitas de duplicidade precisam ficar visíveis na prévia, sem descarte silencioso.

## Estado atual

A infraestrutura de upload, prévia, confirmação, histórico e desfazer existe. O parser padrão é `DefaultFinancialImportParser`: extratos bancários OFX 1.x (SGML) e 2.x (XML) em BRL são interpretados em UTF-8, UTF-16, Windows-1252 e ISO-8859-1. Cada arquivo deve conter um único bloco bancário `STMTRS`; múltiplos extratos são recusados antes da prévia para não misturar contas, moedas ou `FITID`. Valores positivos sugerem entrada, negativos sugerem saída e `XFER` permanece pendente de conciliação. Linhas malformadas ficam visíveis com motivo explícito quando podem ser armazenadas com segurança. `NAME` e `MEMO` multilinha são preservados e normalizados na descrição exibida; conteúdo XML `CDATA` permanece literal.

CSV e faturas de cartão em OFX permanecem fora desse fluxo. A prevenção de duplicidade entre sessões também permanece pendente; nesta etapa, o parser identifica apenas `FITID` repetido dentro do mesmo arquivo.

## Fontes verificáveis

- [`docs/financial-imports-contract.md`](../../financial-imports-contract.md)
- [`apps/api/src/financial-imports/financial-imports.service.ts`](../../../apps/api/src/financial-imports/financial-imports.service.ts)
- [`apps/api/src/financial-imports/financial-imports.parser.ts`](../../../apps/api/src/financial-imports/financial-imports.parser.ts)
- [`apps/api/src/financial-imports/financial-imports.parser.test.ts`](../../../apps/api/src/financial-imports/financial-imports.parser.test.ts)
- [`apps/api/src/financial-imports/postgres-financial-imports.repository.ts`](../../../apps/api/src/financial-imports/postgres-financial-imports.repository.ts)
- [`apps/web/src/imports/FinancialImportsPage.tsx`](../../../apps/web/src/imports/FinancialImportsPage.tsx)
