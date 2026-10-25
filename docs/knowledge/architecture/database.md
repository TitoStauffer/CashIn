# Arquitetura do banco de dados

**Status:** confirmado
**Última revisão:** 25/10/2026

## Estratégia

O PostgreSQL é acessado pelo driver `pg`. `runMigrations` cria `schema_migrations`, lê `apps/api/migrations` em ordem lexical e registra cada arquivo aplicado. Novas mudanças de esquema devem ser migrations aditivas e versionadas.

## Grupos de dados

- Identidade: `users`, tokens de confirmação e sessões.
- Carteiras: `wallets`, `wallet_members`, convites, links e solicitações de acesso.
- Cadastros: categorias, subcategorias, formas de pagamento e cartões.
- Financeiro: entradas, despesas, metas, aportes e faturas.
- Importação: sessões e itens de prévia/resultado.

## Garantias relevantes

- IDs UUID e timestamps são gerados no banco.
- Recursos financeiros carregam `wallet_id` e usam constraints compostas para impedir referências entre carteiras.
- Valores financeiros usam `numeric` com duas casas e limites explícitos.
- Formas, cartões e registros históricos são desativados ou preservados quando a exclusão quebraria rastreabilidade.
- Confirmação e desfazer de importações usam transações.

## Atenção à numeração

Existem duas migrations iniciadas por `013_`. A ordem efetiva é lexical pelo nome completo. Não renomeie migrations já aplicadas; use o próximo prefixo disponível em uma nova migration.

## Fontes verificáveis

- [`apps/api/src/database.ts`](../../../apps/api/src/database.ts)
- [`apps/api/migrations/`](../../../apps/api/migrations/)
- [`compose.yaml`](../../../compose.yaml)
- [`apps/api/src/financial-imports/postgres-financial-imports.repository.ts`](../../../apps/api/src/financial-imports/postgres-financial-imports.repository.ts)
