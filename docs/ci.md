# Integração contínua (GitHub Actions)

O workflow `.github/workflows/ci.yml` valida metadados do PR, API, Web, ferramentas de automação e SonarQube em Pull Requests para `master` e em pushes para `master`. A ordem é determinística: `PR title` → `API`/`Web`/`GitHub Reviewer` → `SonarQube`. Somente a conclusão bem-sucedida do workflow completo aciona os agentes.

Edições de título ou corpo executam o workflow confiável e leve `.github/workflows/pr-title.yml`. Ele revalida os metadados sem checkout do código do PR. Quando a edição é humana, solicita a repetição da execução de CI associada ao mesmo HEAD; o job de título do CI consulta os metadados atuais, permitindo recuperar um PR cujo título inicial era inválido. Edições de checklist feitas pelo GitHub App não repetem o CI, não criam checks de API/Web pulados e não cancelam a orquestração ativa.

| Job | Diretório | Passos (comandos já existentes no projeto) |
| --- | --- | --- |
| `PR title` | evento do GitHub | Valida o padrão `[DEV-123] - título`, a chave da branch e a correspondência entre as duas chaves |
| `GitHub Reviewer` | `tools/github-reviewer` | Depende de `PR title`; instala, compila e executa os testes da infraestrutura de publicação, agentes e Merge Readiness. O nome histórico é preservado durante o rollout dos consumidores privilegiados. Testa o executor de mutação e roda os mutantes declarados para `tools/*` (ver **Verificação por mutação**). |
| `API` | `apps/api` | Depende de `PR title`; `npm ci` → `npm run typecheck` → espera do PostgreSQL → `npm run test:coverage` (unitários + integração, uma vez) → checagem de testes pulados → reescrita dos caminhos LCOV → upload do artefato `api-coverage` (7 dias) → `npm run build` → mutantes declarados para `apps/api` |
| `Web` | `apps/web` | Depende de `PR title`; `npm ci` → `npm run lint` → `npm run test:coverage` → reescrita dos caminhos LCOV → upload do artefato `web-coverage` (7 dias) → `npm run build` (o script roda `tsc -b` e depois `vite build`) → mutantes declarados para `apps/web` |
| `SonarQube` | raiz do repositório | Depende de `API`, `Web` e `GitHub Reviewer`; baixa os dois LCOV; instala o SonarScanner CLI no tool cache com assinatura GPG verificada (`.github/scripts/prime-sonar-scanner.sh`); analisa PRs do próprio repositório e pushes em `master`; aguarda o Quality Gate e falha se ele reprovar |

## Decisões

- **Node.js 24.22.0, fixo.** É a mesma major das imagens `node:24-alpine` dos Dockerfiles. Para atualizar, altere `NODE_VERSION` no workflow.
- **Actions fixadas por SHA de commit**, com a versão em comentário: `actions/checkout` v7.0.1 e `actions/setup-node` v7.0.0. Os SHAs foram conferidos com `git ls-remote` nas tags oficiais.
- **Cache do npm** pelo `actions/setup-node`, com chave baseada no `package-lock.json` de cada app.
- **`GITHUB_TOKEN` só com `contents: read`.** O checkout usa `persist-credentials: false`, então o token não fica salvo no repositório clonado.
- **Sem execuções obsoletas:** um novo push no mesmo PR cancela a execução anterior. Edições humanas repetem o CI do HEAD atual; se já houver uma execução ativa, sua conclusão fornece o sinal atualizado. Edições do checklist feitas pelo GitHub App executam apenas a validação de metadados e não reiniciam os agentes. O push em `master` roda novamente para validar o resultado do merge.
- **Scanner instalado antes da action, com assinatura verificada.** A `sonarqube-scan-action` importa a chave da SonarSource com `gpg --recv-keys` em `keyserver.ubuntu.com` sem timeout, e só tenta o keyserver alternativo quando a chamada falha, nunca quando ela trava. Em 11/11/2026 o keyserver não respondeu e o job ficou parado até o timeout de 15 minutos duas vezes (check runs `130519550174` e `130544528864`). O passo anterior à action baixa o scanner e a assinatura com tempo limitado, busca a chave por HTTPS em `keyserver.ubuntu.com` e, se ele não responder, em `keys.openpgp.org` — cada tentativa limitada a 30 segundos, até três tentativas por keyserver, então um keyserver travado custa no máximo cerca de um minuto e meio —, exige exatamente uma chave primária com a fingerprint fixada `679F1EE92B19609DE816FDE81DB198F93525EC1A` e uma assinatura válida por ela, e grava o scanner no tool cache; a action encontra o cache e pula o próprio download. Desligar a verificação (`skipSignatureVerification`) foi descartado. A versão fica em `SONAR_SCANNER_VERSION` no workflow e é passada à action; ao mover o pin da action, atualize as duas juntas.
- **Responsável atribuído automaticamente.** O workflow `.github/workflows/pr-assignee.yml` roda em `pull_request_target` (`opened` e `reopened`) e atribui `TitoStauffer` ao PR, por `.github/scripts/assign-pr-owner.sh` (DEV-66). Ele faz checkout esparso só de `.github/scripts` a partir da branch padrão — nunca do PR —, recebe apenas `contents: read` e `issues: write`, e é idempotente: lê os responsáveis antes e não escreve se o dono já estiver lá. Como a API ignora em silêncio quem não pode ser atribuído, o sucesso é confirmado pela resposta. Falha de API ou permissão vira aviso no log e no resumo do job, sem deixar check vermelho: atribuição é conveniência, não portão de qualidade. Coberto por `tools/github-reviewer/test/pr-assignee.test.mjs`, que roda o script contra um `gh` falso.
- **Segredo limitado ao scanner.** `SONAR_TOKEN` só é exposto ao passo que envia a análise ao SonarQube Cloud; os demais jobs não recebem secrets.

## PostgreSQL e testes de integração

- Os arquivos `*.integration.test.ts` rodam só quando `TEST_DATABASE_URL` está definida. Sem ela, eles são **pulados em silêncio**.
- No CI, o job `API` sobe `postgres:17-alpine` (a mesma imagem do `compose.yaml`) como serviço, com health check `pg_isready`. Usuário, senha e banco (`saldocerto` / `saldocerto_ci_only` / `saldocerto_test`) existem só dentro do job. Não há dados nem credenciais de produção.
- Antes dos testes, um passo confirma a conexão pelo driver `pg`, o mesmo usado pelos testes.
- Cada teste de integração cria um schema temporário, aplica as migrations com o mecanismo oficial do projeto (`runMigrations`, em `src/database.ts`, que lê `apps/api/migrations/`) e remove o schema ao final. O teste de autenticação aplica as migrations duas vezes, o que valida a idempotência.
- **Proteção contra falso verde:** o passo "Ensure no test was skipped" lê a linha de resumo do `node:test` (`skipped N`, nos formatos TAP e spec) e falha o job se algum teste foi pulado.

## SMTP e dependências externas

- Nenhum e-mail é enviado no CI. O workflow não define `SMTP_*`.
- `email-sender.test.ts` injeta uma função `sendMail` falsa, e os testes de rotas usam um `emailSender` falso. O `SmtpEmailSender` real só é construído, e o `nodemailer` não abre conexão na construção.
- A API não tem outras chamadas de rede externas. As chamadas `fetch` existem só na Web (`*Api.ts`); a suite Web atual cobre a navegação e ainda não exercita os clientes HTTP.

## Checks obrigatórios a configurar no GitHub

Em *Settings → Rules → Rulesets* (ou *Branches → Branch protection rules*), para a branch `master`:

1. Exigir Pull Request antes do merge.
2. Exigir os status checks **`PR title`**, **`API`**, **`Web`**, **`GitHub Reviewer`**, **`SonarQube`**, **`SonarCloud Code Analysis`** e **`Merge Readiness`**. Eles só aparecem para seleção depois da primeira execução do workflow no repositório.
3. Marcar "Require branches to be up to date before merging" (recomendado).
4. Bloquear force push e exclusão da branch (recomendado).

O repositório público usa um ruleset ativo para `master`, sem atores de bypass. O contexto estável `Merge Readiness` é a decisão final; o job `Evaluate Merge Readiness` apenas registra que a avaliação e a publicação do contexto foram executadas.

## Validar localmente

Na raiz do repositório, com o PostgreSQL do `docker compose up -d db` (porta 5433):

```bash
cd apps/api
npm ci
npm run typecheck
mkdir -p coverage
TEST_DATABASE_URL=postgresql://saldocerto:saldo_dev_only@localhost:5433/saldocerto npm run test:coverage
npm run build

cd ../web
npm ci
npm run lint
npm run test:coverage
npm run build
```

A URL acima usa os valores padrão do `compose.yaml`; se o seu `.env` define outros `POSTGRES_*`, use-os. Os testes de integração criam e removem schemas próprios. Eles não tocam no schema `public` do banco local. No Windows (PowerShell), defina a variável antes: `$env:TEST_DATABASE_URL="postgresql://..."`.

Sintaxe e segurança do workflow:

```bash
actionlint .github/workflows/ci.yml
zizmor .github/workflows/ci.yml
```

## Verificação por mutação

Toda guarda nova é provada por uma mutação que derruba o teste certo. Para essa prova valer como evidência do SHA avaliado — e não como palavra de quem desenvolveu —, os mutantes são declarados num manifesto versionado e aplicados pelo CI (DEV-126). O executor é `tools/mutation-check/run.mjs`, sem dependências.

**Como declarar.** Um arquivo por entrega, `mutations/<CHAVE>.json`:

```json
{
  "ticket": "DEV-126",
  "mutations": [
    {
      "id": "anchor-must-be-unique",
      "package": "tools/mutation-check",
      "file": "tools/mutation-check/run.mjs",
      "find": "if (occurrences !== 1) {",
      "replace": "if (occurrences === 0) {",
      "command": ["node", "--test", "run.test.mjs"],
      "timeoutSeconds": 600
    }
  ]
}
```

- `package` é o diretório do pacote; `command` roda dentro dele e só pode começar por `node`, `npm` ou `npx`. Prefira o teste mais estreito que derruba o mutante, porque cada mutante é uma rodada do comando.
- `file` fica dentro do pacote; `find` precisa aparecer **exatamente uma vez** no arquivo e é trocado por `replace`. `timeoutSeconds` é opcional (padrão 600).
- Pacotes aceitos: `apps/api` (job `API`, com o PostgreSQL do job disponível), `apps/web` (job `Web`) e `tools/github-reviewer`, `tools/jira-dispatcher` e `tools/mutation-check` (job `GitHub Reviewer`). Um mutante de outro pacote faz o job `GitHub Reviewer` falhar, em vez de ser pulado por todos.

**O que o passo faz.** Em Pull Requests, o último passo de cada job (`Mutation check (declared mutants)`) compara o merge commit com a base (`HEAD^1`; o checkout usa `fetch-depth: 2`) e roda só os manifestos que o PR **adicionou ou alterou**. Manifestos antigos ficam como registro: reexecutá-los para sempre faria o custo crescer com o histórico e quebraria assim que uma entrega posterior reescrevesse uma âncora. Antes dos mutantes, cada comando roda uma vez sem mutação e precisa passar. O passo falha quando:

- o comando não passa sem a mutação (`BASELINE_FAILED`) — senão um erro alheio faria todo mutante parecer morto;
- a âncora está ausente ou repetida (`NOT_APPLICABLE`) — passar por vacuidade não prova nada;
- o comando continua passando com a mutação (`SURVIVED`) — o teste não protege o que a entrega diz proteger;
- o comando não termina normalmente com a mutação, por exemplo por timeout (`INCONCLUSIVE`);
- o arquivo não volta byte a byte ao original, conferido por SHA-256 (`NOT_RESTORED`).

Só `KILLED` em todos os mutantes deixa o passo verde. A tabela de resultados vai para o log e para o resumo do job. O passo é o último do job para que um mutante nunca chegue ao build nem ao relatório de cobertura. Ele executa código do PR, então existe apenas no CI sem credenciais, nunca em job privilegiado.

**Como o QA lê a evidência.** Os agentes recebem, para os jobs `API`, `Web` e `GitHub Reviewer` do SHA, o nome e a conclusão de cada passo. Com `mutations/<CHAVE>.json` no diff, `Mutation check (declared mutants)` concluído com sucesso significa que todos os mutantes daquele manifesto foram mortos no CI deste SHA. Sem manifesto no diff, o passo conclui com sucesso sem rodar nada, e isso não prova mutação alguma.

**Localmente,** depois de commitar o manifesto: `node tools/mutation-check/run.mjs --base master --package <pacote>`.

## Pendências e limitações conhecidas

- **A API não tem lint configurado.** O job `API` não roda lint porque não existe comando para isso. Adicionar um linter exige uma nova dependência de desenvolvimento.
- **A Web tem testes automatizados do menu lateral** com Vitest e Testing Library. O relatório de cobertura é gerado em `apps/web/coverage/lcov.info`; o typecheck ocorre dentro do `npm run build`.
- **Imagem do PostgreSQL por tag.** O `zizmor` aponta `postgres:17-alpine` sem digest (`unpinned-images`). A tag foi mantida igual ao `compose.yaml`. Para fixar, rode `docker pull postgres:17-alpine` e `docker inspect --format "{{index .RepoDigests 0}}" postgres:17-alpine`, e use `postgres:17-alpine@sha256:...` no workflow.
- **Atualização das actions:** os SHAs fixos não se atualizam sozinhos. Considere o Dependabot (`package-ecosystem: github-actions`).

## SonarQube Cloud

O workflow usa a organização `titostauffer` e o projeto `TitoStauffer_CashIn` no plano gratuito. A configuração está em `sonar-project.properties`; o CI executa análise baseada em workflow para PRs do próprio repositório e pushes em `master`.

- **Automatic Analysis deve permanecer desligada.** Se estiver ligada, a execução do scanner pelo CI falha.
- O token só é fornecido ao passo do scanner pelo secret `SONAR_TOKEN`; nunca o coloque no repositório ou em logs.
- PRs de forks pulam a análise porque não recebem secrets.
- A cobertura da API e da Web vem do LCOV gerado na execução de `npm run test:coverage` de cada job; o workflow reescreve `SF:src/...` para caminhos relativos à raiz (`SF:apps/api/src/...` e `SF:apps/web/src/...`) antes de enviar os artefatos `api-coverage` e `web-coverage`.
- Os testes `*.test.ts` e `*.test.tsx` são excluídos da análise de código de produção e classificados como testes no SonarQube. O mesmo vale para `*-test-fixture.ts`, que contém apenas fakes e helpers dos testes: medi-los como produção diluiria o sinal de cobertura com código que só existe para exercitar outro código. Esses arquivos também saem da cobertura da API pelo `--test-coverage-exclude`.
- A análise CI-based aguarda o Quality Gate. O job `SonarQube` aparece no PR como verificação e falha se o Quality Gate reprovar. Quando o projeto está vinculado ao repositório GitHub, a decoração do SonarQube Cloud também pode exibir detalhes e o resultado da análise no PR.
- O plano gratuito permite análise de PRs direcionada à branch principal e possui limite de linhas para projetos privados. O projeto precisa estar dentro desse limite e ter `master` configurada como branch principal.
