# Arquitetura da API

**Status:** confirmado
**Última revisão:** 17/11/2026

## Organização

A API usa módulos por domínio. O padrão predominante é:

- `*.routes.ts`: contrato HTTP, autenticação e códigos de resposta.
- `*.service.ts`: casos de uso e regras de negócio.
- `*.types.ts`: interfaces e estruturas compartilhadas pelo módulo.
- `postgres-*.repository.ts`: SQL e persistência.
- `*.test.ts`: testes de rota/unidade.
- `*.integration.test.ts`: persistência real quando `TEST_DATABASE_URL` está definida.

`createApp` em `src/app.ts` aceita repositórios e serviços substituíveis, permitindo testes sem acoplar as regras ao Fastify. `server.ts` cria o banco, aplica migrations e inicia o servidor.

## Módulos registrados

Autenticação, carteiras, convites, solicitações de acesso, categorias, formas de pagamento, cartões, entradas, despesas, metas, resumo financeiro e importações.

## Convenções relevantes

- Erros exibidos ao cliente são escritos em português.
- O contexto de carteira é resolvido após autenticação e responde `404` para recurso inexistente ou inacessível.
- Dinheiro é validado e serializado como decimal, evitando ponto flutuante no contrato.
- Testes de integração criam schemas temporários e aplicam as migrations oficiais.
- Upload financeiro usa limite próprio e não persiste o arquivo bruto.
- **IP do cliente atrás do proxy (DEV-159).** Os limitadores por IP (cadastro, login e pedido de acesso) usam `request.ip`. Sem `TRUSTED_PROXIES` (`src/trusted-proxies.ts`, opção `trustedProxies` de `createApp`), esse IP é o do socket, como sempre foi. Com a variável, que em produção é só o IP fixo do Caddy, uma conexão vinda desse endereço é atribuída ao endereço que o proxy acrescentou ao `X-Forwarded-For`; o que o cliente escreveu antes é ignorado, e um cliente que chega direto nunca é acreditado. Não há contagem de saltos: o Fastify 5.12 a recusa. Um endereço inválido impede a API de subir. Testes em `src/auth/auth.routes.test.ts` e `src/trusted-proxies.test.ts`; stack e runbook em [`runbooks/production-vps.md`](../runbooks/production-vps.md).

## Autenticação (DEV-140)

Implementada em `src/auth/auth.routes.ts`. A sessão é um token opaco com hash em `auth_sessions`, e `app.authenticate` o lê de um de dois lugares: o cookie `HttpOnly` da Web ou o header `Authorization: Bearer` dos clientes nativos (o app mobile).

- **Precedência:** header presente é a única fonte considerada, mesmo malformado; não há recuo para o cookie. O formato do token é validado antes de qualquer consulta ao banco. Pela mesma regra, o logout com header age só sobre a sessão do bearer: `204` quando ela existia, `401` quando o token não resolve sessão nenhuma, e o cookie nunca é limpo nesse caminho.
- **Emissão:** `POST /auth/login` define só o cookie; `POST /auth/token` devolve o token no corpo, com `Cache-Control: no-store` e sem cookie. As duas rotas usam o mesmo limitador por IP.
- **Redação:** o header `Authorization` é coberto pela redação de `req.headers` nos logs (teste sobre a linha emitida em `src/app.test.ts`) e fica fora da lista de permissão dos traces (segredo `authorization` em `src/telemetry.test.ts`).
- **Testes:** rotas em `src/auth/auth.routes.test.ts`; sessão real, escopo de `X-Wallet-Id` e logout em `src/auth/postgres-auth.integration.test.ts`. Contrato em [`docs/api.md`](../../api.md#sessão-cookie-na-web-token-nos-clientes-nativos).

## Logs

Regra de aplicação inteira, implementada em `requestLoggerOptions` do `src/app.ts`. Ela morava na nota de importações, onde foi criada, e foi trazida para cá porque quem altera a montagem da aplicação é roteado para esta nota (DEV-113).

- O logger serializa de cada requisição apenas método e caminho (sem query string e sem o IP de origem, desde a DEV-132: o IP é dado pessoal e os traces já o descartam), e de cada resposta apenas o código; `req.headers`, `res.headers` e `req.body` estão na redação do pino. Nenhum log carrega cookie de sessão, conteúdo de arquivo ou valor financeiro — afirmação verificada na **linha realmente emitida** pelo pino, com destino injetado no teste, e não apenas no objeto de configuração. A redação é a segunda trava, também verificada: uma regressão monta a configuração com um serializer que vaza os cabeçalhos de propósito e afirma que a linha continua sem o cookie.
- Quem mudar o logger, os serializers ou a redação em `src/app.ts` mantém essas duas travas e os testes que leem a linha emitida.
- **ID de correlação (DEV-130).** Cada requisição tem um `reqId`, que aparece em todas as linhas de log dela e volta ao cliente no header `X-Request-Id` de toda resposta, inclusive 404, 400 do parser e 500 do error handler. O header é gravado num hook `onRequest`, e o Fastify preserva headers já definidos quando o error handler responde. O id vem de `resolveRequestId` (`src/shared/request-id.ts`). Ele reaproveita o `X-Request-Id` do cliente quando é um valor único de 1 a 128 caracteres em `[A-Za-z0-9._-]`. Qualquer outro valor é descartado em silêncio e trocado por um `randomUUID()`. O alfabeto curto existe porque o valor vai literal para o log e para um header de resposta: sem espaço, aspas nem quebra de linha, um id do cliente não consegue forjar uma linha de log nem quebrar um header. A opção `requestIdHeader` do Fastify fica desligada de propósito, porque ela aceitaria o header sem validar.

## Traces (DEV-131)

A API usa o OpenTelemetry, configurado em `src/telemetry.ts` e carregado por `src/instrumentation.ts` com `node --import`, nos scripts `start` e `dev`. O carregamento antecipado é obrigatório, porque as instrumentações só conseguem modificar Fastify, pino, `http` e `pg` se forem registradas antes desses módulos serem importados.

- **Opcional.** O SDK só inicia quando `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` ou `OTEL_EXPORTER_OTLP_ENDPOINT` têm valor. Sem elas, nada é instrumentado nem exportado, e a API funciona como antes. O exportador é o OTLP/HTTP, que lê o endpoint dessas mesmas variáveis. O nome do serviço vem de `OTEL_SERVICE_NAME` e, sem ela, é `saldocerto-api`. Só traces são configurados: o SDK recebe listas vazias de processadores de log e de leitores de métrica, para não montar exportadores sozinho a partir do ambiente. A detecção de recursos fica desligada, para não exportar linha de comando nem dados da máquina.
- **Spans.** Cada requisição gera um trace com o span HTTP do servidor, os spans do Fastify (`@fastify/otel` com `registerOnInitialization`, sem mudança em `app.ts`) e os spans do `pg` (`pg-pool.connect`, `pg.connect`, `pg.query:<comando>`). O `/health` não é rastreado, porque o container o consulta a cada poucos segundos.
- **Log correlacionado.** A instrumentação do pino grava `traceId`, `spanId` e `traceFlags` em toda linha emitida dentro de um span, ao lado do `reqId` da DEV-130. Os logs continuam indo para a saída padrão em JSON (`disableLogSending`).
- **Duas travas contra dado sensível.** A primeira: o `pg` nunca anexa parâmetros de consulta ao span (`enhancedDatabaseReporting: false` em `pgInstrumentationConfig`). O texto do SQL é exportado, mas com `$1`, `$2` no lugar dos valores. A segunda: o `RedactingSpanExporter` filtra o span no momento da exportação, o último ponto antes do dado sair do processo, por **lista de permissão** (regra 21 de `learnings/code-review-findings.md`). Só saem os atributos listados em `EXPORTED_ATTRIBUTES`: método, rota, status, caminho, servidor, nomes dos hooks do Fastify e sistema, banco e texto do SQL. Qualquer outro atributo é descartado, inclusive headers, corpo, `url.query`, `url.full`, endereço e user agent do cliente, usuário e connection string do banco e atributos que uma instrumentação futura inventar. `url.path` e `http.target` saem sem query string, porque o `@fastify/otel` grava a URL bruta em `url.path`. O evento de exceção guarda só `exception.type`, sem mensagem nem stack, e o status guarda só o código, porque uma mensagem de erro do PostgreSQL pode repetir o valor recusado. Cada trava tem teste próprio, porque um teste das duas juntas passaria com uma delas quebrada.
- **Contexto do cliente ignorado.** O SDK roda sem propagador (`textMapPropagator: null`). Um `traceparent` enviado pelo cliente não escolhe o `traceId` que vai para os logs nem decide se a requisição é amostrada. A API não chama outro serviço rastreado, então também não há o que propagar adiante.
- **Testes.** `src/telemetry.test.ts` inicia o SDK com um exportador em memória antes de importar `app.js` e `pg` e serve requisições reais por socket. Ele afirma os spans, o `traceId` do log igual ao do trace, a ausência dos segredos (query string, cookie, `authorization`, corpo, valor de SQL e mensagem de erro) em atributos, eventos, status e recurso, o `traceparent` do cliente ignorado e a ausência de span do `/health`. O span do `pg` é obtido sem banco: um `Client` encerrado antes de conectar rejeita a consulta logo depois de a instrumentação abrir o span. A lista de permissão tem teste unitário com um atributo desconhecido.
- **Logs por OTLP (DEV-132).** Com `OTEL_LOGS_EXPORTER=otlp`, além do endpoint, a instrumentação do pino entrega ao exportador OTLP de logs do SDK a mesma linha que vai para a saída padrão. Essa linha já passou pelos serializers e pela redação de `requestLoggerOptions`, e o registro leva o contexto nativo do span (`trace_id`/`span_id`), que é o que liga Tempo e Loki no Grafana. O serializer `req` passou a gravar o caminho sem query string e deixou de gravar o IP de origem, porque essas linhas agora saem do processo. O teste de sensibilidade da telemetria pegou o token da query no log exportado, e o Code Review apontou o IP. A escolha de `logRecordProcessors` fica em `logRecordProcessorsFor`, testada nos três ramos: `undefined` é o caminho de produção (o SDK monta o exportador pelo ambiente), e trocá-lo por `[]` desligaria os logs em silêncio. Testado com um processador de logs em memória (`logProcessor`), que afirma o contexto do trace, o `reqId` e a ausência dos segredos. Sem `OTEL_LOGS_EXPORTER=otlp`, os logs continuam só na saída padrão. Uso local em [`docs/observability.md`](../../observability.md).

## Métricas (DEV-134)

- **Opcional, como os logs.** Com `OTEL_METRICS_EXPORTER=otlp`, além do endpoint, `metricReadersFor` deixa `metricReaders` indefinido e o SDK monta o exportador OTLP de métricas pelo ambiente. Sem a variável, a lista vazia mantém as métricas desligadas. A lista vazia é necessária: o SDK assume `otlp` quando `OTEL_METRICS_EXPORTER` está vazio. As métricas são enviadas ao coletor, e a API **não expõe `/metrics`**, então nada delas é alcançável pela porta pública.
- **O que é medido.**
  - HTTP: `http.server.request.duration` (histograma, com contagem) por `http.route` (o modelo da rota, nunca o ID), método e status. Vem da instrumentação HTTP.
  - Pool do `pg`: `db.client.connection.count` por estado (`used`/`idle`), `db.client.connection.pending_requests`, `db.client.connection.max` e `db.client.operation.duration`. Vem da instrumentação do `pg`, que só registra dentro de um span (`requireParentSpan`), ou seja, nas consultas feitas por requisições.
  - Processo (`src/process-metrics.ts`, sobre a API do OpenTelemetry e sem dependência nova): atraso do event loop (p50, p99 e máximo do intervalo), memória residente, heap, CPU por modo e uptime. Elas são liberadas no `shutdown` do `Telemetry` que `startTelemetry` devolve.
  - Importação (DEV-135): `financial_import.*`, descritas em `domain/imports.md`.
- **Painel (DEV-136).** `deploy/observability/grafana/dashboards/saldocerto-api.json` é provisionado na stack local e na de produção. `src/observability-dashboard.test.ts` recusa consulta a métrica que a API não exporta, o que obriga a atualizar o painel junto quando uma métrica muda de nome.
- **Rótulos por lista de permissão.** Uma View aplica `METRIC_ATTRIBUTES` a todo instrumento, e qualquer outro atributo é descartado. Um rótulo é dimensão armazenada por combinação de valores: identificar usuário, carteira, e-mail, valor ou URL seria dado pessoal e cardinalidade sem limite. O teto de 2.000 combinações por métrica protege contra um rótulo permitido que fique sem limite.
- **Testes.** `src/metrics.test.ts` roda num processo próprio, pelo caminho de produção (variáveis de ambiente e exportador OTLP real), até um receptor local. Ele afirma:
  - a rota parametrizada contada pelo modelo e sem o ID no payload;
  - todos os rótulos na lista, e `server.address`, `client.address` e URLs ausentes;
  - as métricas de processo exportadas;
  - `/metrics` respondendo 404;
  - com `TEST_DATABASE_URL`, uma conexão `used` durante uma consulta lenta feita por uma rota.

## Comandos

```bash
cd apps/api
npm ci
npm run typecheck
npm test
npm run build
```

Os testes de integração exigem `TEST_DATABASE_URL`. Consulte [`docs/ci.md`](../../ci.md) antes de interpretar testes pulados como sucesso completo.

## Fontes verificáveis

- [`apps/api/src/app.ts`](../../../apps/api/src/app.ts)
- [`apps/api/src/app.test.ts`](../../../apps/api/src/app.test.ts)
- [`apps/api/src/shared/request-id.ts`](../../../apps/api/src/shared/request-id.ts)
- [`apps/api/src/telemetry.ts`](../../../apps/api/src/telemetry.ts)
- [`apps/api/src/instrumentation.ts`](../../../apps/api/src/instrumentation.ts)
- [`apps/api/src/telemetry.test.ts`](../../../apps/api/src/telemetry.test.ts)
- [`apps/api/src/auth/auth.routes.ts`](../../../apps/api/src/auth/auth.routes.ts)
- [`apps/api/src/auth/auth.routes.test.ts`](../../../apps/api/src/auth/auth.routes.test.ts)
- [`apps/api/src/auth/postgres-auth.integration.test.ts`](../../../apps/api/src/auth/postgres-auth.integration.test.ts)
- [`apps/api/src/server.ts`](../../../apps/api/src/server.ts)
- [`apps/api/src/database.ts`](../../../apps/api/src/database.ts)
- [`apps/api/package.json`](../../../apps/api/package.json)
