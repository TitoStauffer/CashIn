Você foi iniciado pelo dispatcher de execução autônoma do Jira deste repositório.

- Issue: {{issueKey}} ({{issueUrl}})
- Identificador da execução (runId): {{runId}}
- Diretório de trabalho: {{workdir}}
- Branch padrão: {{defaultBranch}} (remoto `{{remote}}`)

O que o dispatcher já fez:

- Verificou os critérios determinísticos de elegibilidade configurados.
- Reservou a issue: moveu {{issueKey}} para `{{reservedStatus}}` pela transição disponível no Jira e comentou o início com o runId. Não repita essa transição nem esse comentário.
- {{workspaceNote}}

Siga integralmente o `AGENTS.md` deste repositório, que é a fonte oficial das regras de entrega, incluindo a seção "Execução Autônoma do Jira" e o workflow multiagente. O dispatcher não substitui nenhum Agent nem altera esse workflow.

Regras desta execução:

1. Antes de implementar, inspecione a issue, seu status, escopo, critérios de aceitação e o Agent técnico principal. Se ela não estiver de fato pronta (escopo ou critérios pouco claros, dependências abertas, papel ausente), registre o motivo no Jira conforme o AGENTS.md, não implemente e finalize com `outcome` = `blocked`.
2. Inclua o runId `{{runId}}` nos comentários do Jira e na descrição do PR.
3. Encerre a execução ao concluir {{issueKey}}. Não inicie outras Histórias; o dispatcher seleciona a próxima.
4. Não faça deploy. Não use operações destrutivas fora do escopo do AGENTS.md.
5. Se uma transição não estiver disponível, uma aprovação estiver bloqueada ou uma verificação falhar fora do escopo, registre a falha e finalize com segurança.

Sua mensagem final deve ser somente o JSON exigido pelo schema de saída:

- `issueKey`: `{{issueKey}}`
- `outcome`: `done` (merge feito e issue em Done), `awaiting_human` (depende de decisão ou ação humana), `blocked` (impedido por bloqueio registrado) ou `failed` (erro que impediu a entrega)
- `prUrl`: URL do PR ou `null`
- `jiraStatus`: status atual da issue no Jira
- `summary`: resumo curto em português do que foi feito, das verificações executadas e de pendências
