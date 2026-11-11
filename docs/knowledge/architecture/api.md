# Arquitetura da API

**Status:** confirmado
**Última revisão:** 11/11/2026

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

- O logger serializa de cada requisição apenas método, rota e endereço de origem, e de cada resposta apenas o código; `req.headers`, `res.headers` e `req.body` estão na redação do pino. Nenhum log carrega cookie de sessão, conteúdo de arquivo ou valor financeiro — afirmação verificada na **linha realmente emitida** pelo pino, com destino injetado no teste, e não apenas no objeto de configuração. A redação é a segunda trava, também verificada: uma regressão monta a configuração com um serializer que vaza os cabeçalhos de propósito e afirma que a linha continua sem o cookie.
- Quem mudar o logger, os serializers ou a redação em `src/app.ts` mantém essas duas travas e os testes que leem a linha emitida.

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
- [`apps/api/src/server.ts`](../../../apps/api/src/server.ts)
- [`apps/api/src/database.ts`](../../../apps/api/src/database.ts)
- [`apps/api/package.json`](../../../apps/api/package.json)
