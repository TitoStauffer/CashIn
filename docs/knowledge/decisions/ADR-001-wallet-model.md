# ADR-001 — Dados financeiros pertencem a carteiras

**Status:** aceito
**Data registrada:** 25/10/2026

## Contexto

Um usuário precisa manter finanças pessoais e também participar de contextos compartilhados, como uma carteira familiar.

## Decisão

Entradas, despesas, metas, categorias, formas de pagamento e cartões pertencem a uma carteira. Usuários se relacionam com carteiras por propriedade ou associação. Cada usuário pode ter sua carteira pessoal e acessar carteiras compartilhadas.

## Consequências

- Toda operação precisa validar acesso à carteira.
- O cliente mantém um contexto de carteira ativa.
- Compartilhamento não duplica as movimentações entre usuários.
- Exclusão, saída e transferência de propriedade exigem regras explícitas.

## Fontes

- [`domain/wallets.md`](../domain/wallets.md)
- [`apps/api/src/wallets/wallets.service.ts`](../../../apps/api/src/wallets/wallets.service.ts)
