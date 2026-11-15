# Arquitetura da API

**Status:** confirmado
**Última revisão:** 15/11/2026

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
- [`apps/api/src/server.ts`](../../../apps/api/src/server.ts)
- [`apps/api/src/database.ts`](../../../apps/api/src/database.ts)
- [`apps/api/package.json`](../../../apps/api/package.json)
