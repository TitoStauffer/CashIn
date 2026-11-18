# Runbook — Deploy da stack de produção na VPS

**Status:** preparado na DEV-159 e validado localmente pelo smoke test. **Ainda não executado numa VPS.** A execução é a DEV-151 e exige pedido explícito do Tito.
**Última revisão:** 18/11/2026

Configuração em `deploy/production/`. A stack de observabilidade fica em `deploy/observability/` e tem runbook próprio ([observability-vps.md](observability-vps.md)).

## Desenho

| Serviço | Imagem | Redes | Porta publicada |
| --- | --- | --- | --- |
| `proxy` (Caddy 2.11.9) | `apps/web/Dockerfile.production`: build estático da Web servido pelo Caddy | `edge` (IP fixo `172.30.10.2`) | 80, 443 e 443/udp |
| `api` | `apps/api/Dockerfile.production`: JavaScript compilado, só dependências de produção, usuário `node` | `edge`, `data`, `saldocerto-observability` | nenhuma |
| `db` (PostgreSQL 17) | `postgres:17-alpine`, fixada por digest | `data` (interna) | nenhuma |

- **Um domínio só.** `https://<domínio>/` serve a Web e `https://<domínio>/api/*` chega à API sem o prefixo, como o proxy do Vite no desenvolvimento. O app usa `https://<domínio>/api` como `EXPO_PUBLIC_API_URL`. Como Web e API têm a mesma origem, não há CORS a configurar. O app nativo também não passa por CORS.
- **HTTPS.** O Caddy emite e renova o certificado de `SITE_ADDRESS` sozinho (Let's Encrypt). A porta 80 só responde ao desafio ACME e redireciona para HTTPS. Os cabeçalhos enviados são HSTS, `nosniff`, `X-Frame-Options: DENY` e `Referrer-Policy`, e o `Server` é removido.
- **Cookie.** `NODE_ENV=production` liga o atributo `Secure` no cookie de sessão da Web. O app usa token `Bearer`.
- **IP do cliente.** A API só acredita no `X-Forwarded-For` quando a conexão vem do IP fixo do Caddy (`TRUSTED_PROXIES=172.30.10.2`). O Caddy troca qualquer `X-Forwarded-For` enviado pelo cliente pelo endereço real. Assim, os limites de tentativa de cadastro, login e pedido de acesso valem por cliente, e um cabeçalho forjado não escapa deles.
- **Migrations.** A API aplica as migrations pendentes ao iniciar (`runMigrations`, com lock para mais de uma réplica). As migrations são só para frente, e cada entrega preserva compatibilidade com a versão anterior do código.
- **Uploads.** O Caddy aceita corpo de até 11 MB. Até 10 MB a API responde com a mensagem em português; acima de 11 MB o Caddy recusa com `413`.
- **Logs.** Os logs dos containers giram em 3 arquivos de 10 MB. A API também envia logs, traces e métricas ao coletor da observabilidade.

| Serviço | CPU | Memória |
| --- | --- | --- |
| proxy | 0,5 | 256 MB |
| api | 1,0 | 512 MB |
| db | 1,0 | 1 GB |

Somando o teto da observabilidade (2,5 CPUs e cerca de 2,2 GB), a VPS precisa de **pelo menos 4 GB de RAM e 2 vCPUs**. Recomendo 8 GB, para o PostgreSQL ter cache e para os builds das imagens, que rodam na própria VPS. Os limites são tetos, não reservas.

`check-compose.mjs` verifica essas regras na configuração que o Compose resolve:
- só o `proxy` publica porta, e só 80 e 443;
- o banco fica só em rede interna;
- imagens e bases dos Dockerfiles fixadas por digest;
- limites de CPU e memória definidos;
- `no-new-privileges` ligado;
- política de restart definida;
- volumes nomeados;
- `NODE_ENV=production`;
- `TRUSTED_PROXIES` igual ao IP do Caddy;
- API sem rodar como root.

## Pré-requisitos (decisões e custos do Tito)

1. **VPS** com Ubuntu LTS, no tamanho acima, e acesso SSH por chave.
2. **Domínio**, com um registro `A` (e `AAAA`, se houver IPv6) apontando para a VPS antes do primeiro deploy, senão o Caddy não consegue o certificado.
3. **Conta SMTP** para os e-mails de confirmação, convite e acesso. Sem ela, ninguém confirma o cadastro.
4. **Para os builds:** conta Expo (EAS). A conta Google Play é necessária para publicar na loja. Para o iOS fora do Expo Go, é preciso a conta Apple Developer.

## Preparar a VPS (uma vez)

1. Atualize o sistema e crie um usuário sem root com sudo e chave SSH. Desligue o login por senha e o login de root no `sshd`.
2. Instale o Docker Engine e o plugin Compose pelo repositório oficial da Docker.
3. Firewall (`ufw`): permita 22/tcp, 80/tcp, 443/tcp e 443/udp, e negue o resto. As portas publicadas pelo Docker passam por fora do `ufw`. Por isso a regra que garante "nada além de 80 e 443" é o `check-compose.mjs`, e a conferência é o `ss` da verificação.
4. Clone o repositório (leitura) em `/opt/saldocerto` e faça checkout do commit da `master` que vai para produção.

## Primeiro deploy

1. **Observabilidade primeiro.** Siga [observability-vps.md](observability-vps.md) até o passo 4. É ela que cria a rede `saldocerto-observability`, que a API usa, e sem essa rede o Compose de produção não sobe. As variáveis `OTEL_*` da API já estão no `compose.yaml` de produção.
2. **Segredos.** `cp deploy/production/.env.example deploy/production/.env`, `chmod 600 deploy/production/.env`. Preencha:
   - `SITE_ADDRESS`, o domínio sem `https://`;
   - `ACME_EMAIL`;
   - `POSTGRES_PASSWORD`, gerada com `openssl rand -base64 32 | tr -d '/+='`;
   - as variáveis `SMTP_*`.

   O `.env` nunca vai para o Git, e a senha do banco nunca aparece em log ou ticket.
3. **Valide antes de subir:**

   ```bash
   docker compose -f deploy/production/compose.yaml config --format json | node deploy/production/check-compose.mjs
   ```

4. **Suba:** `docker compose -f deploy/production/compose.yaml up -d --build --wait`.
5. Faça a **verificação pós-deploy** (abaixo) e registre as evidências na DEV-151.

## Verificação pós-deploy

1. `curl -sS https://<domínio>/api/health` responde `{"status":"ok","database":"ok"}`, com certificado válido (sem `-k`).
2. `curl -sI http://<domínio>/` responde `308` para `https://<domínio>/`.
3. `https://<domínio>/` abre a Web. Crie uma conta e confirme que o e-mail de confirmação chegou e que o link abre a Web.
4. `ss -tlnup` na VPS lista em interface pública só 22, 80 e 443. O Grafana aparece só em `127.0.0.1:3001`, e 5432, 3000, 3100, 3200, 4318 e 9090 não aparecem em interface pública.
5. De fora da VPS, `nc -zv <domínio> 5432` e `nc -zv <domínio> 3000` falham.
6. `docker compose -f deploy/production/compose.yaml ps` mostra os três serviços `healthy` ou `running`, e `logs api --tail 50` não tem erro.
7. No Grafana, pelo túnel SSH, as requisições da verificação aparecem no painel `saldocerto-api`.
8. Com o app gerado contra a URL de produção: entre na conta num aparelho fora da rede local e lance uma despesa. Este é o critério da DEV-151.

## Atualizar para uma nova versão

1. Anote o commit atual (`git rev-parse HEAD`). Ele é o ponto de rollback.
2. Faça o **backup** do banco (seção abaixo) e confira que o arquivo não está vazio.
3. `git fetch && git checkout <commit novo da master>`.
4. Rode a validação do passo 3 do primeiro deploy e depois `docker compose -f deploy/production/compose.yaml up -d --build --wait`.
5. Faça a verificação pós-deploy, passos 1, 3 (só a abertura), 6 e 7.

## Rollback

- **Código, sem migration nova no intervalo:**

  ```bash
  git checkout <commit anterior>
  docker compose -f deploy/production/compose.yaml up -d --build --wait
  ```

  As migrations são compatíveis com a versão anterior, então o código antigo roda sobre o banco novo.
- **Migration incompatível ou dado corrompido:**
  1. Pare a API e o proxy: `docker compose -f deploy/production/compose.yaml stop api proxy`. Daqui até o passo 4, **não suba a API**: a imagem atual roda `runMigrations` ao iniciar e reaplicaria a migration sobre o banco restaurado, ou o código defeituoso voltaria a escrever nele.
  2. Restaure o backup tirado antes da atualização (comando da seção abaixo). A API continua parada.
  3. Volte o código para o commit anotado antes da atualização: `git checkout <commit anterior>`.
  4. Só agora suba a stack, que reconstrói a API com o código compatível com o backup: `docker compose -f deploy/production/compose.yaml up -d --build --wait`.
  5. Faça a verificação pós-deploy (passos 1, 3, 6 e 7).

  Tudo o que foi gravado depois do backup se perde. Registre o incidente.
- **Certificado:** o volume `caddy_data` guarda certificado e conta ACME. Nunca o apague sem necessidade: a Let's Encrypt limita as emissões por domínio.

## Backup e restauração do banco

Backup (rode antes de cada atualização e diariamente pelo `cron` do host, guardando 14 dias):

```bash
install -d -m 700 /var/backups/saldocerto
docker compose -f deploy/production/compose.yaml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /var/backups/saldocerto/saldocerto-$(date +%Y%m%d-%H%M).dump
find /var/backups/saldocerto -name '*.dump' -mtime +14 -delete
```

Restauração, com a API e o proxy parados (`stop api proxy`):

```bash
docker compose -f deploy/production/compose.yaml exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < /var/backups/saldocerto/<arquivo>.dump
```

Este comando **não** religa a API. A API só volta depois que o código no checkout for o da época do backup, com `up -d --build --wait`, como no rollback acima. Um `start api` logo depois da restauração subiria a imagem atual, que aplica as migrations ao iniciar.

O backup fica na própria VPS. Uma cópia fora dela (outro provedor ou armazenamento de objetos) é decisão do Tito e deve ser feita antes de haver dados reais.

## Builds do app (EAS)

O `apps/mobile/eas.json` tem dois perfis:
- `preview`: distribuição interna, APK no Android;
- `production`: loja, com o número de build incrementado pelo EAS.

Os dois leem `EXPO_PUBLIC_API_URL` do ambiente EAS de mesmo nome, guardado no expo.dev, nunca no repositório. O app recusa uma URL sem HTTPS fora do desenvolvimento (`src/config/apiUrl.ts`). Não há perfil `development`, porque ele exigiria o `expo-dev-client`, que não está instalado. No desenvolvimento, use o Expo Go.

Na DEV-151, depois da verificação pós-deploy:
1. Em `apps/mobile`, rode `npx eas-cli login` e `npx eas-cli init`. O `init` grava o `projectId` no `app.json`.
2. Defina no `app.json` o `android.package` e o `ios.bundleIdentifier` (por exemplo, o domínio invertido). **Não mudam depois da primeira publicação.**
3. `npx eas-cli env:create --environment preview --name EXPO_PUBLIC_API_URL --value https://<domínio>/api --visibility plaintext`, e o mesmo com `--environment production`.
4. `npx eas-cli build --profile preview --platform android`, e instale o APK pelo link do EAS. Para o iOS: `--platform ios`, com a conta Apple.
5. Faça a verificação pós-deploy, passo 8.

## Validação local (sem VPS)

Na raiz do repositório, com as portas 80 e 443 livres (ou com outras em `HTTP_PORT` e `HTTPS_PORT`), `node deploy/production/smoke/smoke-test.mjs` constrói e sobe a stack com `SITE_ADDRESS=localhost`. Nesse modo, o Caddy usa a autoridade local dele, e o teste confia só nela. Ele verifica, por HTTPS de verdade:
- `/api/health`;
- a Web e o fallback de rotas;
- o redirecionamento de HTTP;
- os cabeçalhos de segurança;
- o cookie `Secure` e `HttpOnly`;
- que um `X-Forwarded-For` forjado não escapa do limite de login;
- que só o Caddy publica porta, e só 80 e 443.

O teste sempre desmonta a stack com os volumes. O passo "Smoke test production stack" do job `API` roda o mesmo script quando o commit altera `deploy/production` ou os `Dockerfile.production`.

## Fontes

- [`deploy/production/compose.yaml`](../../../deploy/production/compose.yaml)
- [`deploy/production/Caddyfile`](../../../deploy/production/Caddyfile)
- [`deploy/production/.env.example`](../../../deploy/production/.env.example)
- [`deploy/production/check-compose.mjs`](../../../deploy/production/check-compose.mjs)
- [`deploy/production/smoke/smoke-test.mjs`](../../../deploy/production/smoke/smoke-test.mjs)
- [`apps/api/Dockerfile.production`](../../../apps/api/Dockerfile.production)
- [`apps/web/Dockerfile.production`](../../../apps/web/Dockerfile.production)
- [`apps/api/src/app.ts`](../../../apps/api/src/app.ts)
- [`apps/mobile/eas.json`](../../../apps/mobile/eas.json)
- [`apps/mobile/src/config/apiUrl.ts`](../../../apps/mobile/src/config/apiUrl.ts)
