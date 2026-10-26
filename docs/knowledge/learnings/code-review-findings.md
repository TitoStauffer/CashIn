# Aprendizados de Code Review

**Status:** bootstrap da DEV-64
**Última revisão:** 26/10/2026

Este arquivo registra os achados confirmados durante a correção que precisa chegar à `master` antes da publicação do vault completo pelo PR #44. O conteúdo deve ser consolidado no catálogo principal da DEV-64 após a integração.

## Limites devem medir o risco, não o canal de contexto

- **Evidência:** [PR #46, revisão `5658565787`](https://github.com/TitoStauffer/CashIn/pull/46#pullrequestreview-5658565787), SHA afetado `25427340afb0d8a0f356c2ebcb081a6f96c3742c`.
- **Problema:** a primeira deduplicação retirava da contagem qualquer arquivo já carregado pelo vault, inclusive código TypeScript.
- **Impacto:** uma nota poderia referenciar mais de 32 fontes alteradas e contornar o limite fechado do contexto de código.
- **Correção:** somente Markdown do vault e seu mapa deixam de ser duplicados; código alterado continua sujeito ao limite próprio.
- **Prevenção:** testar mais de 32 fontes alteradas e referenciadas pelo vault, exigindo bloqueio antes da revisão.

## Deduplicação não pode eliminar análise complementar

- **Evidência:** [PR #46, revisão `5658565787`](https://github.com/TitoStauffer/CashIn/pull/46#pullrequestreview-5658565787), SHA afetado `25427340afb0d8a0f356c2ebcb081a6f96c3742c`.
- **Problema:** um TypeScript alterado já presente no vault era removido do carregador genérico, que é o responsável por descobrir imports locais diretos.
- **Impacto:** dependências relevantes deixavam de compor o contexto e a garantia de revisão completa ficava incorreta.
- **Correção:** fontes de código permanecem no carregador genérico mesmo quando também servem de evidência do vault.
- **Prevenção:** testar uma fonte alterada citada pelo vault que importa uma dependência local inalterada e exigir os dois snapshots.
