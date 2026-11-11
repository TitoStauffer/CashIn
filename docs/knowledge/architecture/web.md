# Arquitetura da Web

**Status:** confirmado
**Última revisão:** 11/11/2026

## Organização

A Web usa React e Vite. `App.tsx` resolve a página pelo caminho atual, restaura a sessão e envolve telas financeiras com `WalletProvider`. Cada domínio mantém página, estilos, montagem de caminhos e testes próximos; o cliente HTTP em si é compartilhado em `src/api/`.

## Áreas principais

- Autenticação e confirmação de e-mail.
- Dashboard.
- Entradas, despesas e metas.
- Categorias, formas de pagamento, cartões/faturas e importações.
- Seleção/criação de carteira e compartilhamento.

`FinancialSidebar` organiza visão geral, registros e cadastros. O menu de compartilhamento aparece para o proprietário de uma carteira não pessoal.

## Estado e contratos

- `WalletContext` carrega carteiras, preserva a seleção e expõe a carteira ativa.
- **Um cliente HTTP compartilhado**, `api/request.ts`. `createApiRequest(ErrorClass, { scopeToActiveWallet })` devolve o `request` que cada domínio usa, e concentra o prefixo `/api`, as credenciais, o `Content-Type` condicional ao corpo ser string, o 204 sem corpo e o erro de domínio. Os dez `*Api.ts`, autenticação incluída, só montam caminho e tipos; nenhum tem `request` próprio. A [DEV-105](https://titostauffer.atlassian.net/browse/DEV-105) unificou nove; o `authApi.ts` ficou de fora porque montava `/api/auth/` com caminho relativo, que a guarda não aceita, e entrou na [DEV-123](https://titostauffer.atlassian.net/browse/DEV-123) passando a usar caminhos absolutos (`/auth/login`). Não há mais exceção: todo caminho da Web passa pela guarda.
- **A carteira ativa é anexada pelo cliente compartilhado**, como header `X-Wallet-Id`, com o estado em `api/activeWallet.ts`. `scopeToActiveWallet: false` existe para as rotas de carteira, que não podem ser escopadas pela carteira já escolhida, e para as de autenticação, que acontecem antes ou independentemente de qualquer carteira e não leem o header. `wallets/walletApi.ts` reexporta `setRequestWalletId` e `withActiveWallet`, então quem já importava dali continua funcionando; o estado saiu de lá para que o cliente não precise importar o módulo que o importa.
- **O caminho passa por `assertSafeApiPath` (`api/requestPath.ts`) antes do `fetch`.** Cada domínio monta o caminho com prefixo literal e identificadores sob `encodeURIComponent`; a guarda recusa caminho que não comece em `/`, protocolo-relativo (`//host`), segmento que suba de diretório em qualquer grafia — `..`, `.%2e`, `%2e%2e` e as formas em maiúscula, por decodificação —, escape truncado e caracteres que uma rota nunca precisa. Ela aceita `!*'()`, que `encodeURIComponent` não escapa. A convenção do encode já bastava; a guarda existe porque convenção se esquece, e porque a análise estática não a prova lendo os chamadores.
- **Caminho recusado tem mensagem própria** em `feedback/apiErrorFeedback.ts`: o erro não tem status, então cairia no texto de conexão de cada tela e mandaria a pessoa tentar de novo algo que não pode dar certo.
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
- [`apps/web/src/authApi.ts`](../../../apps/web/src/authApi.ts)
- [`apps/web/src/api/request.ts`](../../../apps/web/src/api/request.ts)
- [`apps/web/src/layout/FinancialSidebar.tsx`](../../../apps/web/src/layout/FinancialSidebar.tsx)
- [`apps/web/src/wallets/WalletContext.tsx`](../../../apps/web/src/wallets/WalletContext.tsx)
- [`apps/web/package.json`](../../../apps/web/package.json)
