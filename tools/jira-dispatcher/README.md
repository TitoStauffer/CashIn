# Jira Dispatcher

Infraestrutura de execução autônoma de tickets do Jira para o Codex CLI.

O dispatcher **não implementa funcionalidades e não substitui nenhum Agent**. Conforme a seção "Execução Autônoma do Jira" do `AGENTS.md`, ele apenas:

1. consulta o Jira periodicamente com uma JQL configurada;
2. aplica checagens determinísticas de elegibilidade (campos, papel do Agent, dependências);
3. reserva o ticket pela transição disponível no Jira e registra o comentário de início com o `runId`;
4. prepara uma worktree Git dedicada e inicia `codex exec`, que segue o `AGENTS.md`;
5. acompanha a execução, persiste o estado e registra logs e resultados por ticket.

O julgamento semântico (escopo claro, critérios de aceitação suficientes) continua com o workflow do Codex. Se a História não estiver pronta, o Codex finaliza com `blocked` sem implementar.

## Requisitos

- Node.js 22.12 ou superior (o projeto usa Node 24).
- Git, com acesso ao remoto `origin`.
- Codex CLI instalado e autenticado (`codex login`), com acesso ao Jira configurado **no próprio Codex**, por exemplo via MCP, como já acontece hoje. O dispatcher não repassa as credenciais dele ao Codex.
- Um token de API do Jira para o dispatcher: https://id.atlassian.com/manage-profile/security/api-tokens

## Instalação

```bash
cd tools/jira-dispatcher
npm ci
npm run build
npm test
```

O pacote não tem dependências de produção. `tsx`, `typescript` e `@types/node` são usados só para build e testes, nas mesmas versões de `apps/api`.

## Configuração

### 1. Credenciais (`tools/jira-dispatcher/.env`, fora do Git)

```bash
cp .env.example .env
```

Preencha `JIRA_EMAIL` e `JIRA_API_TOKEN` com a conta Jira usada pela integração, que é a do usuário, conforme o `AGENTS.md`. Variáveis já definidas no ambiente têm precedência sobre o arquivo.

### 2. Arquivo de configuração (`dispatcher.config.json`, fora do Git)

```bash
cp dispatcher.config.example.json dispatcher.config.json
```

O dispatcher **não presume** nomes de campos, labels, status ou transições. Todo valor marcado com `PREENCHA` é obrigatório, e o dispatcher se recusa a iniciar enquanto restar algum.

Use o comando `discover` numa História real para obter ids e nomes exatos:

```bash
node dist/cli.js discover DEV-10
```

Ele lista os campos preenchidos (id, nome e amostra), as transições disponíveis agora (id, nome, status de destino), os tipos de link e os links da issue. Nenhuma credencial é exibida.

| Chave | O que preencher |
| --- | --- |
| `jira.eligibilityJql` | JQL que traduz os critérios do `AGENTS.md`. Termine com `ORDER BY Rank ASC` para respeitar a priorização do quadro. Veja abaixo. |
| `jira.requiredFields` | Campos que precisam estar preenchidos. Cada item aceita `mustContain` (textos obrigatórios), `pattern` (regex) e `allowedValues` (valores aceitos). Use isso para o **papel do Agent técnico principal** e para objetivo, escopo e critérios de aceitação. |
| `jira.blockingLinks` | Tipo de link de dependência (ex.: o nome exato de "Blocks") e o lado (`inward`/`outward`) onde fica a issue que bloqueia. A issue bloqueadora precisa estar em categoria *done*. |
| `jira.reservableStatuses` | Status, por id ou nome, em que a issue precisa estar no momento da reserva (o "To Do"). |
| `jira.reservationTargetStatus` | Status de destino da reserva (o "In Progress"). A transição é escolhida entre as **disponíveis** naquele momento. Se houver mais de uma, preencha `reservationTransitionId`. |
| `jira.resumableStatuses` | Status em que uma execução interrompida pode ser retomada (ex.: In Progress e In Review). |
| `jira.doneStatuses` | Status que confirmam a entrega (o "Done"). |
| `jira.runPropertyKey` | Propriedade de entidade da issue onde o `runId` é registrado. Use `""` para desativar. |

Ids de status são mais estáveis que nomes, já que o Jira exibe nomes traduzidos como `Tarefas pendentes` e `Em andamento`.

#### Configurar a elegibilidade

Os critérios do `AGENTS.md` para o MVP 1 são: História, em `To Do`, na sprint ativa, associada ao épico `DEV-6`, com objetivo, escopo e critérios de aceitação claros, dependências resolvidas e papel do Agent técnico principal registrado. Um ponto de partida para a JQL, **a confirmar no seu Jira** (o tipo, o status e o vínculo com o épico podem ter outros nomes):

```
project = DEV AND issuetype = "História" AND status = "To Do" AND sprint in openSprints() AND parent = DEV-6 ORDER BY Rank ASC
```

Se quiser um sinal explícito de "pronto para execução autônoma", como uma label, inclua-o na JQL. O dispatcher não cria nem presume essa label.

Valide sem alterar nada no Jira:

```bash
node dist/cli.js check
node dist/cli.js once --dry-run
```

### 3. Codex CLI

Padrões e o que fica a seu critério:

- `codex.args` é `["exec", "--json", "--sandbox", "workspace-write"]`. O dispatcher acrescenta `--cd <worktree>`, `--add-dir <.git do repositório>` (necessário para commits em worktree), `--output-schema`, `--output-last-message` e `-`, que envia o prompt por stdin.
- **Bloqueados no código:** `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `danger-full-access` e `--full-auto`. A configuração é rejeitada se eles aparecerem.
- **Rede no sandbox:** o workflow do `AGENTS.md` precisa de rede para `git push`, abertura de PR e `npm install`. No `workspace-write`, a rede costuma vir desabilitada. Avalie e, se aceitar, habilite explicitamente, por exemplo adicionando `"-c", "sandbox_workspace_write.network_access=true"` a `codex.args` ou ajustando o `~/.codex/config.toml`. Isso não desativa o sandbox nem as aprovações.
- **Windows:** com o `codex` instalado via npm (`codex.cmd`), o dispatcher usa o shell apenas para o shim e recusa argumentos com caracteres que o `cmd.exe` reinterpretaria. Confirme o comportamento do sandbox do Codex no seu ambiente (Windows nativo ou WSL). Rode o dispatcher no mesmo ambiente em que o `codex` funciona.
- `codex.timeoutMinutes` vale 240 por padrão. Ao estourar, o processo e seus filhos são encerrados.

Os prompts ficam em `prompts/run.md` e `prompts/resume.md`. Eles apenas apontam para o `AGENTS.md`, sem duplicar regras. O formato do resultado final está em `prompts/result.schema.json`.

## Execução

```bash
node dist/cli.js once --dry-run   # só lista elegíveis e motivos de exclusão
node dist/cli.js once             # um ciclo: reserva, roda e aguarda terminar
node dist/cli.js run              # loop contínuo (pollIntervalSeconds, padrão 300 s)
node dist/cli.js status [DEV-10]  # estado das execuções
```

Use `--config <arquivo>` e `--env-file <arquivo>` para caminhos diferentes do padrão.

### Fluxo de cada execução

1. Gera um `runId` (UUID) e registra a execução como `reserving`.
2. Relê a issue e revalida a elegibilidade. Se mudou, cancela sem tocar no Jira.
3. Busca as transições disponíveis e escolhe a que leva a `reservationTargetStatus`. Se não houver ou se houver ambiguidade, a execução falha **sem transicionar**.
4. Faz a transição **uma única vez**, sem retry automático, e confere o novo status.
5. Comenta `Iniciado em DD/MM/AAAA HH:mm (America/Sao_Paulo). … runId: <id>.` Se o comentário falhar, **só o comentário** é repetido.
6. Grava o `runId` na propriedade da issue.
7. Cria a worktree em HEAD destacado na versão atual de `origin/<defaultBranch>`. A branch da issue é criada pelo Agent de Product Manager, como manda o `AGENTS.md`.
8. Inicia `codex exec` e guarda pid, `thread_id`, eventos e resultado.
9. Ao final, cruza o resultado do Codex com o status real no Jira.

### Estados de uma execução

| Estado | Significado | Bloqueia nova seleção da issue? |
| --- | --- | --- |
| `reserving` / `running` | Execução ativa | Sim |
| `completed` | Codex informou `done` e o Jira está num `doneStatuses` | Não |
| `needs_attention` | Codex terminou com `blocked`/`awaiting_human`, resultado inválido ou inconsistente com o Jira | Sim, até `resume` ou `clear` |
| `failed` | Erro na reserva, comentário, worktree, Codex (código ≠ 0, timeout) ou falha relatada | Sim, até `resume` ou `clear` |
| `interrupted` | O dispatcher ou o Codex parou antes do fim | Sim, até `resume` ou `clear` |
| `cancelled` | Cancelada antes da reserva, ou limpa pelo operador | Não |

Quando uma falha acontece depois da reserva, o dispatcher comenta na issue a fase e o motivo, sem fazer nenhuma transição adicional.

## Concorrência

- **Um dispatcher por diretório de estado:** o arquivo `dispatcher.lock` com o pid impede duas instâncias. Recuperações de locks de processos mortos no mesmo host ou de locks inválidos são serializadas pelo marcador exclusivo `dispatcher.lock.recovery`. Um lock inválido só é recuperado após estar estável por pelo menos 30 segundos; locks recentes não são removidos, pois podem estar sendo inicializados. Se o processo cair durante a recuperação e deixar o marcador, confirme que não há dispatcher ativo e remova manualmente o marcador antes de tentar novamente. Um lock de outro host nunca é tomado. Rode **apenas um dispatcher por projeto Jira**.
- **Uma execução ativa por issue:** checada no estado local antes de reservar.
- **Revalidação no Jira imediatamente antes da transição**, e a transição só é feita se estiver disponível no status atual.
- `maxConcurrentRuns` vale 1 por padrão. Cada execução usa uma worktree própria, mas todas compartilham o banco local do Docker Compose usado nos testes de integração. Avalie isso antes de aumentar o valor.

## Logs e resultados

Tudo fica em `.dispatcher/` na raiz do repositório, ignorado pelo Git:

```
.dispatcher/
  state.json                         estado de todas as execuções (escrita atômica)
  dispatcher.lock                    lock da instância em execução
  dispatcher.lock.recovery           claim temporário de recuperação de lock inválido
  logs/dispatcher.jsonl              log estruturado (JSON Lines) com issueKey e runId
  runs/<ISSUE>/<runId>/
    prompt.md                        prompt enviado ao Codex
    codex-events.jsonl               eventos do `codex exec --json`
    codex-stderr.log                 progresso/erros do Codex
    result.json                      mensagem final (issueKey, outcome, prUrl, jiraStatus, summary)
```

Antes de gravar, todo conteúdo passa por redação: valores de variáveis de ambiente com nomes sensíveis (`*TOKEN*`, `*PASSWORD*`, `*SECRET*`…), cabeçalhos `Basic`/`Bearer`, tokens Atlassian, GitHub e OpenAI, credenciais em URLs e pares `password=`/`"token":`. `JIRA_EMAIL` e `JIRA_API_TOKEN` são removidos do ambiente do Codex (`codex.stripEnv`).

## Falhas e recuperação

Ao iniciar, o dispatcher verifica execuções que ficaram como ativas:

- se o processo do Codex ainda está vivo (por exemplo, o dispatcher caiu), a execução continua bloqueando a issue até o Codex terminar;
- caso contrário, ela vira `interrupted`.

Para continuar:

```bash
node dist/cli.js resume DEV-10
```

O `resume` exige que a issue esteja num `resumableStatuses`. Ele cria uma nova execução ligada à anterior (`previousRunId`), **não repete a transição de reserva**, comenta a retomada (ou posta o comentário de início que faltou) e reaproveita a worktree anterior. O prompt de retomada orienta o Codex a verificar o status no Jira, a branch, o PR e as aprovações antes de continuar, como pede o `AGENTS.md`.

Para descartar uma execução bloqueante sem retomar:

```bash
node dist/cli.js clear DEV-10
```

O `clear` **não altera o Jira**. Se a issue ficou em In Progress, ajuste-a manualmente antes que a JQL a selecione de novo.

Com um dispatcher rodando em loop, `resume` e `clear` são enviados a ele por uma fila de pedidos em `.dispatcher/requests/` e processados em sequência com os polls.

## Encerramento seguro

| Ação | Efeito |
| --- | --- |
| `node dist/cli.js stop` ou o primeiro Ctrl+C/SIGTERM | Para de selecionar tickets e **aguarda** as execuções ativas terminarem normalmente. |
| `node dist/cli.js stop --now` ou o segundo Ctrl+C | Encerra a árvore de processos do Codex (SIGTERM e depois SIGKILL; `taskkill /T /F` no Windows). As execuções ficam `interrupted` e podem ser retomadas com `resume`. |

O Codex roda em grupo de processos próprio, então o primeiro Ctrl+C no terminal do dispatcher não o interrompe no meio de um passo. No Windows, `stop` é a forma recomendada, porque não depende de sinais.

As worktrees **não são apagadas** automaticamente. Depois de conferir que o trabalho foi integrado, remova-as manualmente com `git worktree remove <caminho>`.

## Testes

```bash
npm test          # 69 testes (node:test via tsx)
npm run typecheck
```

Os 71 testes cobrem elegibilidade, concorrência (lock de processo, recuperação de lock incompleto, execução ativa por issue, mudança de status concorrente, transição indisponível ou ambígua), reserva (comentário no formato do `AGENTS.md`, retry só do comentário), recuperação (`interrupted`, Codex órfão vivo, `resume`, `clear`, persistência), falhas do Codex com um processo real simulado (código ≠ 0, timeout, resultado inválido, issue errada, comando inexistente, parada forçada), redação de segredos, worktree com Git real, cliente HTTP do Jira e o loop com encerramento gracioso.

## O que ainda exige configuração ou verificação manual

1. Criar o token de API e o `.env`.
2. Rodar `discover` numa História e preencher todos os `PREENCHA` do `dispatcher.config.json`.
3. Validar a JQL e os critérios com `check` e `once --dry-run`.
4. Decidir sobre o acesso à rede no sandbox do Codex (veja "Codex CLI").
5. Confirmar que o Codex acessa o Jira e o GitHub (`gh`) sozinho, sem as credenciais do dispatcher.
6. Fazer a primeira execução real com `once` numa História de baixo risco e acompanhar `status` e os logs.
