# Runbook — CI falhou

**Última revisão:** 25/10/2026

1. Confirme o PR e o HEAD SHA da execução.
2. Identifique o primeiro job que falhou na ordem: `PR title`, `API`/`Web`/`GitHub Reviewer`, `SonarQube`.
3. Abra o passo com falha e use a mensagem concreta; não corrija jobs posteriores antes da dependência.
4. Reproduza somente o pacote afetado:
   - API: `cd apps/api; npm ci; npm run typecheck; npm run test:coverage; npm run build`
   - Web: `cd apps/web; npm ci; npm run lint; npm run test:coverage; npm run build`
   - Automação: `cd tools/github-reviewer; npm ci; npm test`
5. Para Sonar, confira LCOV, análise do PR e condição exata do Quality Gate.
6. Corrija a causa, revise todo o diff alterado e envie um novo commit.
7. Confirme que a nova execução pertence ao novo HEAD; não reutilize evidência anterior.

Não marque checklists manualmente para compensar uma falha de check.

## Fontes

- [`automation/delivery-flow.md`](../automation/delivery-flow.md)
- [`docs/ci.md`](../../ci.md)
