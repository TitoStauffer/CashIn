# Dispatcher e integração Jira

**Status:** implementado; depende da configuração local
**Última revisão:** 25/10/2026

## Dispatcher

O dispatcher seleciona issues elegíveis, reserva uma issue pela transição para `In Progress`, registra um `runId`, cria uma worktree e inicia o Codex. Ele não implementa funcionalidades e não escolhe outra issue ao final de uma execução iniciada por ele.

Estados locais evitam duas execuções da mesma issue. Retomadas reaproveitam a execução anterior sem repetir a transição de reserva.

## Pós-merge

O workflow pós-merge:

1. aceita somente PR efetivamente integrado à `master`;
2. extrai uma única chave `DEV-n` coerente do título/branch;
3. revalida merge, HEAD e evidências de entrega;
4. rejeita épicos e issues fora do projeto `DEV`;
5. transiciona a issue para o estado final e publica o comentário uma única vez.

O épico `DEV-25` permanece aberto por regra explícita do projeto.

## Configuração sensível

O GitHub Actions usa `JIRA_EMAIL` e `JIRA_API_TOKEN` como secrets e `JIRA_BASE_URL` como variable. O dispatcher local usa arquivo `.env` ignorado. Nunca copiar valores para o vault.

## Fontes verificáveis

- [`tools/jira-dispatcher/README.md`](../../../tools/jira-dispatcher/README.md)
- [`tools/jira-dispatcher/src/post-merge/service.ts`](../../../tools/jira-dispatcher/src/post-merge/service.ts)
- [`.github/workflows/jira-post-merge.yml`](../../../.github/workflows/jira-post-merge.yml)
- [`AGENTS.md`](../../../AGENTS.md)
