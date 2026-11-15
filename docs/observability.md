# Observabilidade local (LGTM)

O `docker compose up --build` sobe, junto com `db`, `api` e `web`, o serviço `observability`, que roda a imagem de desenvolvimento `grafana/otel-lgtm`. Ela traz Grafana, Loki (logs), Tempo (traces) e Prometheus (métricas) num só container. A API envia traces e logs por OTLP pela rede interna do Compose; nada precisa ser configurado à mão.

## Onde abrir

- Grafana: http://localhost:3001

A porta fica ligada só a `127.0.0.1`: o Grafana não é acessível pela rede local. Loki, Tempo, Prometheus e o receptor OTLP não são publicados no host. O Grafana desta imagem entra sem login (acesso anônimo de administrador). Isso é aceitável só por ele estar restrito à própria máquina e ser exclusivo de desenvolvimento. A stack de produção (DEV-133) usa componentes separados e autenticação obrigatória.

Os dados ficam no volume `observability_data` e sobrevivem a `docker compose down`. `docker compose down -v` apaga esse volume junto com os outros.

## Achar uma requisição pelo `X-Request-Id`

Toda resposta da API traz o header `X-Request-Id`, o mesmo valor que aparece como `reqId` nos logs (DEV-130).

1. Copie o `X-Request-Id` da resposta (DevTools do navegador, aba Network, ou `curl -i`).
2. No Grafana, abra **Explore**, escolha **Loki** e rode:

   ```logql
   {service_name="saldocerto-api"} | reqId="COLE-O-ID-AQUI"
   ```

3. Cada linha de log traz o `trace_id`. O campo derivado **Trace** abre o trace completo da requisição no Tempo.

## Do trace aos logs

1. Em **Explore**, escolha **Tempo** e busque por `{resource.service.name="saldocerto-api"}` ou cole um `trace_id`.
2. O trace mostra o span HTTP, os spans do Fastify e os spans do PostgreSQL (`pg-pool.connect`, `pg.query:<comando>`).
3. No painel do trace, **Logs for this span** abre no Loki as linhas daquela requisição, pela consulta `{service_name="saldocerto-api"} | trace_id="…"`.

## Métricas

No Grafana, **Explore** → **Prometheus**. Exemplos:

- requisições por rota: `sum by (http_route) (rate(http_server_request_duration_seconds_count[5m]))`
- latência p95 por rota: `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))`
- conexões do pool: `db_client_connection_count` (rótulo `db_client_connection_state`)
- event loop: `nodejs_eventloop_delay_p99_seconds`

## Painel

O painel **SaldoCerto · API** (Dashboards no Grafana) abre pronto, sem passo manual. Ele tem duas seções:
- **Saúde da API:** requisições por segundo, taxa de erro 5xx, latência p50/p95/p99 por rota, pool do PostgreSQL, event loop e memória.
- **Uso das importações:** confirmadas, desfeitas e com falha; linhas por resultado; linhas ignoradas por duplicidade no período; tamanho do lote.

Os links **Traces no Tempo** e **Logs no Loki**, no topo, abrem o Explore no mesmo período.

**Mudar o painel.** O arquivo versionado é `deploy/observability/grafana/dashboards/saldocerto-api.json`, e o mesmo arquivo é montado na stack local e na de produção. O Grafana carrega o painel como provisionado e **não deixa salvar alterações pela interface** (`allowUiUpdates: false`), para nada divergir em silêncio do repositório. Para mudar:
1. edite o painel no Grafana sem salvar;
2. use **Export → Export as JSON** e substitua o arquivo no repositório;
3. rode `npm test` em `apps/api`, porque `observability-dashboard.test.ts` recusa consulta a métrica que a API não exporta;
4. abra o PR.

O Grafana relê a pasta a cada 30 segundos.

**Checagem automática.** Quando um commit altera `deploy/observability`, o job `API` roda `deploy/observability/smoke/dashboard-check.mjs`. O script sobe a stack de produção, roda a API compilada contra ela e o PostgreSQL do job, faz requisições reais (incluindo um 500 e um 401) e registra eventos de importação pelo adaptador real. Por fim, executa cada consulta do painel e falha se alguma vier vazia. Localmente, depois de `npm run build` em `apps/api`: `DATABASE_URL=postgresql://…@host.docker.internal:<porta>/<banco> node deploy/observability/smoke/dashboard-check.mjs`, com um PostgreSQL descartável.

## O que é enviado

- **Traces:** só os atributos da lista de permissão de `apps/api/src/telemetry.ts`. Sem query string, headers, corpo, valores de SQL nem mensagem de erro. Detalhes em `docs/knowledge/architecture/api.md`, seção Traces.
- **Métricas:** só os rótulos da lista de permissão (`METRIC_ATTRIBUTES` em `apps/api/src/telemetry.ts`): método, rota-modelo, status, estado das conexões do banco, modo de CPU e, nas métricas de importação (`financial_import.*`), formato (`import.format`), tipo (`import.kind`) e resultado da linha (`item.outcome`). Nunca usuário, carteira, e-mail, valor ou URL.
- **Logs:** a mesma linha JSON que a API escreve na saída padrão, depois dos serializers e da redação do pino. O caminho da requisição vai sem query string, e o IP de quem fez a requisição não é registrado. A saída padrão recebe a mesma linha: `docker compose logs api` continua mostrando tudo.

## Desligar

- **Sem telemetria:** defina `OTEL_EXPORTER_OTLP_ENDPOINT=` (valor vazio) no `.env`. A API não inicia o SDK e não exporta nada.
- **Só traces, logs apenas na saída padrão:** defina `OTEL_LOGS_EXPORTER=none`.
- **Sem métricas:** defina `OTEL_METRICS_EXPORTER=none`.
- **Sem a stack:** `docker compose up db api web` sobe só o necessário. A API não depende do serviço `observability` e continua funcionando sem ele; os envios falham em silêncio.

## Roteiro de verificação manual

1. `docker compose up --build` e aguarde `api` ficar `healthy`.
2. Faça login (ou qualquer ação) pela Web em http://localhost:5173 e copie o `X-Request-Id` da resposta.
3. Siga **Achar uma requisição pelo `X-Request-Id`**. As linhas `incoming request` e `request completed` aparecem com o mesmo `reqId`.
4. Pelo campo **Trace** de uma dessas linhas, abra o trace no Tempo e confira os spans HTTP, Fastify e PostgreSQL.
5. Pelo trace, volte aos logs com **Logs for this span**.

## Dependências novas e o volume `node_modules`

O `node_modules` da API fica num volume nomeado, que sobrevive ao rebuild da imagem. O comando do container (`apps/api/scripts/dev-container.sh`) compara o hash do `package-lock.json` com o hash gravado na instalação. Se o lockfile mudou, ele roda `npm ci` antes de subir a API. A primeira subida depois de uma mudança de dependências demora um pouco mais por isso.
