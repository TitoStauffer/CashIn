# Integração contínua (GitHub Actions)

O workflow `.github/workflows/ci.yml` valida a API e a Web em jobs independentes, em todo Pull Request para `master` e em todo push para `master`.

| Job | Diretório | Passos (comandos já existentes no projeto) |
| --- | --- | --- |
| `API` | `apps/api` | `npm ci` → `npm run typecheck` → espera do PostgreSQL → `npm test` (unitários + integração) → checagem de testes pulados → `npm run build` |
| `Web` | `apps/web` | `npm ci` → `npm run lint` → `npm run build` (o script roda `tsc -b` e depois `vite build`) |

## Decisões

- **Node.js 24.22.0, fixo.** É a mesma major das imagens `node:24-alpine` dos Dockerfiles. Para atualizar, altere `NODE_VERSION` no workflow.
- **Actions fixadas por SHA de commit**, com a versão em comentário: `actions/checkout` v7.0.1 e `actions/setup-node` v7.0.0. Os SHAs foram conferidos com `git ls-remote` nas tags oficiais.
- **Cache do npm** pelo `actions/setup-node`, com chave baseada no `package-lock.json` de cada app.
- **`GITHUB_TOKEN` só com `contents: read`.** O checkout usa `persist-credentials: false`, então o token não fica salvo no repositório clonado.
- **Sem execuções repetidas:** os testes rodam uma única vez, com o banco. Um novo push no mesmo PR cancela a execução anterior. O push em `master` roda novamente para validar o resultado do merge.
- **Nenhum segredo é usado.** O workflow não lê `secrets`.

## PostgreSQL e testes de integração

- Os arquivos `*.integration.test.ts` rodam só quando `TEST_DATABASE_URL` está definida. Sem ela, eles são **pulados em silêncio**.
- No CI, o job `API` sobe `postgres:17-alpine` (a mesma imagem do `compose.yaml`) como serviço, com health check `pg_isready`. Usuário, senha e banco (`saldocerto` / `saldocerto_ci_only` / `saldocerto_test`) existem só dentro do job. Não há dados nem credenciais de produção.
- Antes dos testes, um passo confirma a conexão pelo driver `pg`, o mesmo usado pelos testes.
- Cada teste de integração cria um schema temporário, aplica as migrations com o mecanismo oficial do projeto (`runMigrations`, em `src/database.ts`, que lê `apps/api/migrations/`) e remove o schema ao final. O teste de autenticação aplica as migrations duas vezes, o que valida a idempotência.
- **Proteção contra falso verde:** o passo "Ensure no test was skipped" lê a linha de resumo do `node:test` (`skipped N`, nos formatos TAP e spec) e falha o job se algum teste foi pulado.

## SMTP e dependências externas

- Nenhum e-mail é enviado no CI. O workflow não define `SMTP_*`.
- `email-sender.test.ts` injeta uma função `sendMail` falsa, e os testes de rotas usam um `emailSender` falso. O `SmtpEmailSender` real só é construído, e o `nodemailer` não abre conexão na construção.
- A API não tem outras chamadas de rede externas. As chamadas `fetch` existem só na Web (`*Api.ts`), que não tem testes automatizados.

## Checks obrigatórios a configurar no GitHub

Em *Settings → Rules → Rulesets* (ou *Branches → Branch protection rules*), para a branch `master`:

1. Exigir Pull Request antes do merge.
2. Exigir os status checks **`API`** e **`Web`**. Eles só aparecem para seleção depois da primeira execução do workflow no repositório.
3. Marcar "Require branches to be up to date before merging" (recomendado).
4. Bloquear force push e exclusão da branch (recomendado).

O SonarQube **não** deve entrar como check obrigatório de PR: veja a seção abaixo.

## Validar localmente

Na raiz do repositório, com o PostgreSQL do `docker compose up -d db` (porta 5433):

```bash
cd apps/api
npm ci
npm run typecheck
TEST_DATABASE_URL=postgresql://saldocerto:saldo_dev_only@localhost:5433/saldocerto npm test
npm run build

cd ../web
npm ci
npm run lint
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
- **A Web não tem testes automatizados**, e o typecheck dela acontece dentro do `npm run build`.
- **Imagem do PostgreSQL por tag.** O `zizmor` aponta `postgres:17-alpine` sem digest (`unpinned-images`). A tag foi mantida igual ao `compose.yaml`. Para fixar, rode `docker pull postgres:17-alpine` e `docker inspect --format "{{index .RepoDigests 0}}" postgres:17-alpine`, e use `postgres:17-alpine@sha256:...` no workflow.
- **Atualização das actions:** os SHAs fixos não se atualizam sozinhos. Considere o Dependabot (`package-ecosystem: github-actions`).

## SonarQube (preparação, não ativado)

`sonar-project.properties` já define fontes, testes, exclusões, os `tsconfig` e o caminho da cobertura. Nenhum scanner roda no CI, e nenhum servidor foi instalado ou exposto.

### Compatibilidade do Community Build

| Necessidade | Community Build |
| --- | --- |
| Análise de TypeScript (API e Web) | Suportada |
| Cobertura via LCOV | Suportada (`sonar.javascript.lcov.reportPaths`) |
| Análise de branches além da principal | Não suportada (Developer Edition ou superior) |
| Análise e comentários em Pull Requests | Não suportada (Developer Edition ou superior) |

Com o Community Build, o SonarQube só pode analisar `master` depois do merge, por exemplo num job disparado por push em `master`. Ele não serve como check de qualidade de PR.

### Cobertura da API

O Node gera LCOV nativamente. Validado localmente com 31 testes e 89,47% de linhas no Node 22:

```bash
cd apps/api
mkdir -p coverage
npx tsx --test --experimental-test-coverage --test-coverage-exclude='src/**/*.test.ts' \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination=coverage/lcov.info \
  'src/**/*.test.ts'
sed -i 's#^SF:src/#SF:apps/api/src/#' coverage/lcov.info
```

- O `sed` converte os caminhos para relativos à raiz do repositório, como o SonarQube exige em monorepos.
- Esse comando usa um glob, e não a lista de arquivos do script `test`. Hoje os dois conjuntos são iguais (15 arquivos). Quando o SonarQube for ativado, substitua o passo `npm test` do CI por esse comando (ou por um script `test:coverage`) para não rodar os testes duas vezes.
- A cobertura do `node:test` ainda é marcada como experimental, e algumas linhas de `import` aparecem como não cobertas.

### Para ativar no futuro (requer sua autorização)

1. Provisionar o servidor SonarQube Community Build, fora do escopo atual.
2. Criar o projeto (`sonar.projectKey`) e um token de análise.
3. Cadastrar os secrets `SONAR_TOKEN` e `SONAR_HOST_URL` no GitHub.
4. Adicionar um job de análise só para push em `master`, com a action oficial do SonarQube fixada por SHA, dependente do job `API` e usando o LCOV acima.
