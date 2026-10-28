# Dispatcher e integração Jira

**Status:** implementado; depende da configuração local
**Última revisão:** 28/10/2026

## Dispatcher

O dispatcher seleciona issues elegíveis, reserva uma issue pela transição para `In Progress`, registra um `runId`, cria uma worktree e inicia o Codex. Ele não implementa funcionalidades e não escolhe outra issue ao final de uma execução iniciada por ele.

Estados locais evitam duas execuções da mesma issue. Retomadas reaproveitam a execução anterior sem repetir a transição de reserva.

## Elegibilidade por épico

A execução autônoma usa duas barreiras alinhadas: a JQL limita a busca a Histórias na sprint ativa e preserva `ORDER BY Rank ASC`; `jira.allowedEpicKeys` autoriza explicitamente os épicos. O dispatcher consulta o campo `parent` e repete a validação da allowlist imediatamente antes da reserva, portanto uma issue que mudou para um épico não autorizado não é transicionada.

Os épicos de produto inicialmente autorizados são `DEV-6` e `DEV-50`. O épico permanente `DEV-25` e qualquer outro épico permanecem fora da execução autônoma até serem incluídos explicitamente. Autorizar ou revogar um épico exige alinhar a allowlist e a cláusula `parent` da JQL, validar a configuração e executar `once --dry-run`; não exige alteração de código.

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
- [`tools/jira-dispatcher/src/config.ts`](../../../tools/jira-dispatcher/src/config.ts)
- [`tools/jira-dispatcher/src/eligibility.ts`](../../../tools/jira-dispatcher/src/eligibility.ts)
- [`tools/jira-dispatcher/src/post-merge/service.ts`](../../../tools/jira-dispatcher/src/post-merge/service.ts)
- [`.github/workflows/jira-post-merge.yml`](../../../.github/workflows/jira-post-merge.yml)
- [`AGENTS.md`](../../../AGENTS.md)
