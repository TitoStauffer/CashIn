# Integração contínua (GitHub Actions)

O workflow `.github/workflows/ci.yml` valida a API e a Web em jobs independentes, em todo Pull Request para `master` e em todo push para `master`.

| Job | Diretório | Passos (comandos já existentes no projeto) |
| --- | --- | --- |
| `API` | `apps/api` | `npm ci` → `npm run typecheck` → espera do PostgreSQL → `npm run test:coverage` (unitários + integração, uma vez) → checagem de testes pulados → reescrita dos caminhos LCOV → upload do artefato `api-coverage` (7 dias) → `npm run build` |
| `Web` | `apps/web` | `npm ci` → `npm run lint` → `npm run test:coverage` → reescrita dos caminhos LCOV → upload do artefato `web-coverage` (7 dias) → `npm run build` (o script roda `tsc -b` e depois `vite build`) |
| `SonarQube` | raiz do repositório | Depende de `API` e `Web`; baixa os dois LCOV; analisa PRs do próprio repositório e pushes em `master`; aguarda o Quality Gate e falha se ele reprovar |

## Decisões

- **Node.js 24.22.0, fixo.** É a mesma major das imagens `node:24-alpine` dos Dockerfiles. Para atualizar, altere `NODE_VERSION` no workflow.
- **Actions fixadas por SHA de commit**, com a versão em comentário: `actions/checkout` v7.0.1 e `actions/setup-node` v7.0.0. Os SHAs foram conferidos com `git ls-remote` nas tags oficiais.
- **Cache do npm** pelo `actions/setup-node`, com chave baseada no `package-lock.json` de cada app.
- **`GITHUB_TOKEN` só com `contents: read`.** O checkout usa `persist-credentials: false`, então o token não fica salvo no repositório clonado.
- **Sem execuções repetidas:** os testes rodam uma única vez, com o banco. Um novo push no mesmo PR cancela a execução anterior. O push em `master` roda novamente para validar o resultado do merge.
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
2. Exigir os status checks **`API`**, **`Web`** e, quando quiser aplicar o Quality Gate, **`SonarQube`**. Eles só aparecem para seleção depois da primeira execução do workflow no repositório.
3. Marcar "Require branches to be up to date before merging" (recomendado).
4. Bloquear force push e exclusão da branch (recomendado).

O repositório privado está em uma conta GitHub Free, cujo ruleset de branch não está aplicado atualmente. O check `SonarQube` pode ser marcado como obrigatório quando houver proteção de branch disponível.

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
- Os testes `*.test.ts` e `*.test.tsx` são excluídos da análise de código de produção e classificados como testes no SonarQube.
- A análise CI-based aguarda o Quality Gate. O job `SonarQube` aparece no PR como verificação e falha se o Quality Gate reprovar. Quando o projeto está vinculado ao repositório GitHub, a decoração do SonarQube Cloud também pode exibir detalhes e o resultado da análise no PR.
- O plano gratuito permite análise de PRs direcionada à branch principal e possui limite de linhas para projetos privados. O projeto precisa estar dentro desse limite e ter `master` configurada como branch principal.
