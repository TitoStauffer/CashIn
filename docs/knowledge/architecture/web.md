# Arquitetura da Web

**Status:** confirmado
**Última revisão:** 25/10/2026

## Organização

A Web usa React e Vite. `App.tsx` resolve a página pelo caminho atual, restaura a sessão e envolve telas financeiras com `WalletProvider`. Cada domínio mantém página, estilos, cliente HTTP e testes próximos.

## Áreas principais

- Autenticação e confirmação de e-mail.
- Dashboard.
- Entradas, despesas e metas.
- Categorias, formas de pagamento, cartões/faturas e importações.
- Seleção/criação de carteira e compartilhamento.

`FinancialSidebar` organiza visão geral, registros e cadastros. O menu de compartilhamento aparece para o proprietário de uma carteira não pessoal.

## Estado e contratos

- `WalletContext` carrega carteiras, preserva a seleção e expõe a carteira ativa.
- Clientes `*Api.ts` concentram chamadas HTTP e enviam a carteira ativa.
- Todo cliente HTTP de domínio monta o caminho com prefixo literal e identificadores sob `encodeURIComponent`, e passa esse caminho por `assertSafeApiPath` (`api/requestPath.ts`) antes do `fetch`. A guarda recusa caminho que não comece em `/`, caminho protocolo-relativo (`//host`), travessia (`..`) e caracteres que uma rota nunca precisa. A convenção do `encodeURIComponent` já bastava; a guarda existe porque convenção se esquece, e porque a análise estática não consegue provar a convenção lendo os chamadores — ver [DEV-105](https://titostauffer.atlassian.net/browse/DEV-105).
- Feedbacks de API passam pelas funções em `feedback/` para mensagens acionáveis.
- Período mensal é compartilhado por utilitários em `period/`.
- Não há biblioteca externa de roteamento; `App.tsx` usa `window.location` e caminhos conhecidos.

## Comandos

```bash
cd apps/web
npm ci
npm run lint
npm run test:coverage
npm run build
```

## Fontes verificáveis

- [`apps/web/src/App.tsx`](../../../apps/web/src/App.tsx)
- [`apps/web/src/layout/FinancialSidebar.tsx`](../../../apps/web/src/layout/FinancialSidebar.tsx)
- [`apps/web/src/wallets/WalletContext.tsx`](../../../apps/web/src/wallets/WalletContext.tsx)
- [`apps/web/package.json`](../../../apps/web/package.json)
