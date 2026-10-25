# Importação financeira OFX e CSV

**Status:** fundação implementada; parsers reais pendentes
**Última revisão:** 25/10/2026

## Fluxo definido

1. Usuário escolhe uma carteira e envia um arquivo permitido.
2. A API valida formato e limites, calcula a identidade do arquivo e cria a importação.
3. O parser converte linhas em itens de prévia normalizados.
4. O usuário revisa, edita, ignora ou classifica os itens.
5. A confirmação grava as movimentações em uma transação atômica.
6. Histórico e desfazer usam o vínculo entre importação e movimentações criadas.

## Idempotência e duplicidade

- O arquivo possui uma impressão digital para evitar reprocessamento acidental.
- Itens importados mantêm referência à origem.
- A confirmação repetida não deve criar novas movimentações.
- Suspeitas de duplicidade precisam ficar visíveis na prévia, sem descarte silencioso.

## Estado atual

A infraestrutura de upload, prévia, confirmação, histórico e desfazer existe. O parser padrão é `UnsupportedFinancialImportParser`; portanto, OFX e CSV reais ainda não são interpretados. Essa limitação deve permanecer explícita na interface e na documentação até os parsers serem entregues.

## Fontes verificáveis

- [`docs/financial-imports-contract.md`](../../financial-imports-contract.md)
- [`apps/api/src/financial-imports`](../../../apps/api/src/financial-imports)
- [`apps/web/src/imports`](../../../apps/web/src/imports)
