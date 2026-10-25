# Runbook — Orquestração de Agents falhou

**Última revisão:** 25/10/2026

1. Confirme que o workflow `CI` terminou com sucesso para o HEAD atual.
2. Verifique se o runner `self-hosted`, `Windows`, `X64`, `codex-plus` está online.
3. Confirme no runner que o Codex CLI está instalado e autenticado, sem imprimir credenciais.
4. Identifique a etapa: Code Review, publicação, QA ou Quality Gate Coordinator.
5. Para erro de publicação, confira presença dos secrets `CASHIN_APP_*`, a variable `CASHIN_APP_BOT_LOGIN`, instalação do App e permissões.
6. Para `INCONCLUSIVE`, leia a limitação do relatório e corrija a evidência ou acesso ausente.
7. Reexecute a rodada no mesmo HEAD. A automação deve reutilizar evidências aprovadas válidas e atualizar relatórios, sem duplicá-los.
8. Se o HEAD mudou, execute uma rodada completa para o novo SHA.

Nunca publique aprovação fictícia nem transforme falha de infraestrutura em aprovação.

## Fontes

- [`automation/github-app.md`](../automation/github-app.md)
- [`docs/hosted-agent-orchestration.md`](../../hosted-agent-orchestration.md)
- [`.github/workflows/agent-orchestration.yml`](../../../.github/workflows/agent-orchestration.yml)
