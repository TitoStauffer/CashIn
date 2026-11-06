# Runner self-hosted local (Code Review e QA dos Agents)

Os jobs de Code Review e QA do workflow `agent-orchestration.yml` rodam no runner self-hosted `cashin-codex-plus-windows` (labels `self-hosted, Windows, X64, codex-plus`), porque os CLIs dos modelos usam as assinaturas já autenticadas nesta máquina: o Claude Code por padrão e o Codex como alternativa (`AGENT_RUNTIME=codex`). Sem esse runner online, a orquestração fica na fila e o `Merge Readiness` permanece `INCONCLUSIVE`. Veja [`docs/hosted-agent-orchestration.md`](../../docs/hosted-agent-orchestration.md).

Estes scripts tornam a instalação reproduzível e não exigem administrador. Tudo fica em `%LOCALAPPDATA%\CashInGithubRunner`:

| Pasta | Conteúdo |
|---|---|
| `runner/` | `actions/runner` oficial, registro e `_work` dos jobs |
| `pwsh/` | PowerShell 7 portátil, exigido pelos jobs (`shell: pwsh`) |
| `scripts/` | Cópias instaladas de `runner-common.ps1`, `start-runner.ps1` e `ensure-runner.ps1`, executadas pelo atalho de inicialização e pelo hook |
| `logs/runner.log` | Saída do runner; ao passar de 5 MB, vira `runner.log.1` no próximo início (só um arquivo anterior é mantido) |

## Pré-requisitos

- Windows x64 com o Claude Code CLI instalado e logado (`claude` no `PATH`).
- Opcional: app Codex instalado e logado, usado apenas com `AGENT_RUNTIME=codex` (o CLI fica em `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`).
- GitHub CLI autenticado (`gh auth status`) com uma conta administradora do repositório.

## Instalar ou reparar

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/github-runner/install-runner.ps1
```

Rode o instalador apenas a partir de um checkout atualizado da `master`: os scripts que ele copia para `scripts/` são os que o hook e o atalho executam.

O script baixa o runner e o PowerShell das releases oficiais e confere o SHA-256 fixado em `runner-common.ps1`. Depois ele registra o runner com `--replace` (assume um registro offline de mesmo nome), copia os scripts para `scripts/`, cria o atalho `CashIn GitHub Runner.lnk` na pasta Inicializar do Windows e inicia o runner. Use `-Reregister` para forçar novo registro e `-NoStart` para não iniciar ao final.

- **Reparação:** depois de extrair um pacote por completo, o instalador grava em `.cashin-archive-sha256` o SHA-256 do pacote fixado. Execuções seguintes mantêm a pasta só se o executável marcador e esse SHA conferirem. Extração interrompida, pasta sem marcador ou troca da versão fixada levam a uma nova extração, que exige o runner parado. O registro (`.runner`, credenciais) é preservado.
- **Token de registro:** é obtido pelo `gh` na hora e entregue ao `config.cmd` pela variável `ACTIONS_RUNNER_INPUT_TOKEN`, só no processo do instalador, removida logo depois. Ele nunca aparece na linha de comando, visível na lista de processos, nem é gravado em arquivo.

## Início automático

- **Login no Windows:** o atalho de inicialização executa `scripts/start-runner.ps1`.
- **Sessões do Claude Code:** o hook `SessionStart` em `.claude/settings.json` executa a cópia **instalada** em `scripts/ensure-runner.ps1`, nunca a da árvore de trabalho. Assim, abrir uma sessão numa branch não confiável não executa os scripts dela na máquina que guarda as credenciais dos agentes. O script inicia o runner se estiver parado, nunca baixa nem registra nada, sempre termina com sucesso e só escreve algo quando o runner precisa de atenção.
  - Sem a cópia instalada, o hook só orienta a instalação.
  - Fora do Windows, sem `powershell`, o hook termina em silêncio.
- **Outro listener:** se houver um `Runner.Listener` de outra instalação em execução, ou com caminho ilegível, o início é recusado (`foreign-listener`) para não subir um segundo listener.

A cada início, o processo que inicia o runner recebe um `PATH` com o PowerShell portátil à frente e, se o app Codex existir, `CODEX_EXECUTABLE` apontando para o `codex.exe` de maior versão de arquivo (com a data de gravação como desempate). Os jobs herdam esse ambiente. O runner no Windows não aplica um arquivo `.path` aos jobs, por isso o ambiente do processo é o mecanismo usado. Assim, atualizações do app Codex não quebram o runner.

## Verificação automatizada

`tools/github-runner/test-runner-scripts.ps1` roda no job `GitHub Reviewer` do CI e localmente. Ele roda sem baixar, registrar ou iniciar nada e valida:
- sintaxe e codificação dos scripts;
- que o hook aponta só para a cópia instalada;
- que o instalador não passa `--token`;
- o comando real do hook, executado pelo `bash` com um `powershell` falso que registra a chamada: sem cópia instalada, com cópia instalada e sem `powershell`;
- os helpers numa pasta temporária: escolha do Codex por versão, detecção de outro listener, rotação do log e marcador de reparação.

A instalação real, a reparação e o hook religando o runner parado são verificações operacionais na máquina do runner, registradas nos PRs da DEV-74 e da DEV-77.

## Atualizar versões

1. Consulte a release desejada: `gh api repos/actions/runner/releases/latest` e `gh api repos/PowerShell/PowerShell/releases/latest` (campo `digest` do asset `win-x64`).
2. Atualize versão e SHA-256 em `runner-common.ps1`.
3. Com o runner parado, rode o instalador novamente. O SHA-256 diferente do marcador faz a pasta ser reextraída.

O runner também se autoatualiza quando o GitHub exige uma versão mais nova.

## Remover

Com o runner parado, rode `runner\config.cmd remove --token <token>` (token de `gh api -X POST repos/TitoStauffer/CashIn/actions/runners/remove-token --jq .token`), apague `%LOCALAPPDATA%\CashInGithubRunner` e o atalho `CashIn GitHub Runner.lnk` da pasta Inicializar.
