# Merge Readiness

**Status:** ativo e fail-closed
**Última revisão:** 25/10/2026

## Resultado

O gate retorna somente:

- `READY_TO_MERGE`: todas as evidências exigidas foram confirmadas para o HEAD atual.
- `BLOCKED`: existe falha ou reprovação comprovada.
- `INCONCLUSIVE`: falta evidência ou uma API/configuração necessária não pôde ser confirmada.

## Evidências avaliadas

- Estado e HEAD do PR.
- Checks configurados de CI e SonarQube.
- Revisão formal de Code Review, considerando revisões posteriores.
- Relatórios estruturados de QA e Quality Gate Coordinator.
- Conversas de revisão abertas, quando acessíveis.
- Branch protection e rulesets aplicáveis.

O gate exclui o próprio status da lista de dependências para evitar ciclo. Ele publica `Merge Readiness` no SHA avaliado, mas não executa merge.

## Diagnóstico rápido

`INCONCLUSIVE` deve ser resolvido pela limitação indicada: permissão do App, evidência ausente, SHA desatualizado, proteção inacessível ou falha de API. Nunca transformar limitação em aprovação.

## Fontes verificáveis

- [`tools/github-reviewer/src/merge-readiness.ts`](../../../tools/github-reviewer/src/merge-readiness.ts)
- [`tools/github-reviewer/src/workflow-readiness-cli.ts`](../../../tools/github-reviewer/src/workflow-readiness-cli.ts)
- [`.github/workflows/merge-readiness.yml`](../../../.github/workflows/merge-readiness.yml)
