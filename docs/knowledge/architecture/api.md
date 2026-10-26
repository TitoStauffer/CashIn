# Arquitetura da API

**Status:** confirmado
**Última revisão:** 25/10/2026

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
- [`apps/api/src/server.ts`](../../../apps/api/src/server.ts)
- [`apps/api/src/database.ts`](../../../apps/api/src/database.ts)
- [`apps/api/package.json`](../../../apps/api/package.json)
