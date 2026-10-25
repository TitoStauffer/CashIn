# Runbook — Jira não foi atualizado após o merge

**Última revisão:** 25/10/2026

1. Confirme que o PR foi efetivamente integrado à `master`.
2. Confira se título e branch contêm uma única chave `DEV-n` e se são coerentes.
3. Abra a execução `Jira post-merge` do evento de fechamento.
4. Leia o motivo fail-closed: check ausente, evidência de Agent, conversa aberta, issue inválida, transição indisponível ou falha Jira.
5. Confira as variables `JIRA_BASE_URL`, `CASHIN_APP_BOT_LOGIN` e a existência dos secrets `JIRA_EMAIL`, `JIRA_API_TOKEN`, sem tentar revelar seus valores.
6. Confirme no Jira que a issue não é um épico e que existe transição disponível para o estado final.
7. Corrija a configuração e use **Re-run jobs** na execução original. O processo reconcilia propriedade, status e comentário para evitar duplicidade.
8. Se a transição ocorreu e apenas o comentário falhou, não repita manualmente a transição; reexecute para reconciliar o comentário.

O épico `DEV-25` não deve ser encerrado por essa automação.

## Fontes

- [`automation/jira-dispatcher.md`](../automation/jira-dispatcher.md)
- [`.github/workflows/jira-post-merge.yml`](../../../.github/workflows/jira-post-merge.yml)
- [`tools/jira-dispatcher/src/post-merge/service.ts`](../../../tools/jira-dispatcher/src/post-merge/service.ts)
