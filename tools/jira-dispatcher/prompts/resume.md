Você foi iniciado pelo dispatcher para RETOMAR uma execução autônoma interrompida.

- Issue: {{issueKey}} ({{issueUrl}})
- Novo runId: {{runId}} (execução anterior: {{previousRunId}}, estado `{{previousStatus}}`)
- Status atual no Jira: `{{jiraStatus}}`
- Diretório de trabalho: {{workdir}}
- Git no diretório: branch `{{branch}}`, HEAD `{{head}}`, {{dirtyFiles}} arquivo(s) com alterações locais
- Último erro registrado: {{previousError}}
- Último resumo registrado: {{previousSummary}}

A issue já está reservada; não refaça a transição de reserva.

Siga integralmente o `AGENTS.md`, em especial: "Antes de retomar uma execução interrompida, verifique o status atual no Jira, a branch Git, o Pull Request, as aprovações e o estado da execução anterior". Continue do ponto correto do workflow, sem duplicar commits, PRs, transições ou comentários já feitos.

Regras desta execução:

1. Inclua o runId `{{runId}}` nos comentários do Jira.
2. Encerre ao concluir {{issueKey}}; não inicie outras Histórias.
3. Não faça deploy nem operações destrutivas fora do escopo do AGENTS.md.
4. Se não for seguro continuar, registre o motivo e finalize com `outcome` = `blocked` ou `awaiting_human`.

Sua mensagem final deve ser somente o JSON exigido pelo schema de saída (`issueKey`, `outcome`, `prUrl`, `jiraStatus`, `summary`), com os mesmos significados da execução original: `done`, `awaiting_human`, `blocked` ou `failed`.
