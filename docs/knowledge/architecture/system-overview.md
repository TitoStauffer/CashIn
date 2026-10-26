# Visão geral do sistema

**Status:** confirmado
**Última revisão:** 25/10/2026

## Componentes

| Componente | Tecnologia | Responsabilidade |
| --- | --- | --- |
| Web | React, TypeScript e Vite | Interface, navegação, sessão e consumo da API |
| API | Node.js, TypeScript e Fastify | HTTP, autenticação, regras de negócio e persistência |
| Banco | PostgreSQL 17 | Dados transacionais, integridade e migrations versionadas |
| Ambiente local | Docker Compose | Web, API e banco com volumes locais |
| Entrega | GitHub Actions e SonarQube Cloud | CI, análise, agentes, gate e pós-merge |

## Fluxo de uma operação financeira

1. A Web mantém a carteira ativa no `WalletContext`.
2. Clientes HTTP enviam a sessão e `X-Wallet-Id` quando aplicável.
3. A rota Fastify valida o contrato e autenticação.
4. O service executa regras de negócio sem depender do banco ou de Fastify.
5. O repositório PostgreSQL aplica o escopo da carteira e persiste a alteração.
6. Respostas monetárias usam strings decimais para preservar precisão.

## Limites arquiteturais

- A API é independente da Web e pode atender outros clientes.
- Cada domínio da API separa rotas, service, tipos/contratos e repositório PostgreSQL.
- O banco aplica chaves compostas e constraints para reforçar isolamento por carteira.
- Integrações privilegiadas de GitHub usam código confiável da `master` e credenciais de menor privilégio.

## Fontes verificáveis

- [`compose.yaml`](../../../compose.yaml)
- [`apps/api/src/app.ts`](../../../apps/api/src/app.ts)
- [`apps/api/src/database.ts`](../../../apps/api/src/database.ts)
- [`apps/web/src/App.tsx`](../../../apps/web/src/App.tsx)
- [`apps/web/src/wallets/WalletContext.tsx`](../../../apps/web/src/wallets/WalletContext.tsx)
