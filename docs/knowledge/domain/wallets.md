# Carteiras e compartilhamento

**Status:** implementado
**Última revisão:** 25/10/2026

## Modelo

- Os dados financeiros pertencem a uma carteira, não diretamente ao usuário.
- Cada usuário possui uma carteira pessoal e pode participar de outras carteiras.
- O proprietário administra a carteira, os membros e os pedidos de acesso.
- O contexto de carteira selecionado no cliente delimita consultas e gravações.

## Formas de acesso

1. O proprietário convida uma pessoa pelo e-mail.
2. Uma pessoa solicita acesso usando o fluxo de solicitação.
3. O destinatário precisa possuir ou criar uma conta para concluir o acesso.

Convites e solicitações possuem estados próprios. A API deve validar identidade, vínculo com a carteira e permissão de proprietário antes de operações administrativas.

## Cuidados ao alterar

- Toda consulta financeira deve continuar isolada por carteira.
- Não confiar apenas no identificador enviado pelo cliente; validar a associação do usuário na API.
- Tratar remoção do proprietário e exclusão de carteira como operações destrutivas explícitas.
- Preservar o redirecionamento quando a carteira ativa deixar de estar acessível.

## Fontes verificáveis

- [`apps/api/src/wallets/wallets.service.ts`](../../../apps/api/src/wallets/wallets.service.ts)
- [`apps/api/src/wallet-invitations/wallet-invitations.service.ts`](../../../apps/api/src/wallet-invitations/wallet-invitations.service.ts)
- [`apps/api/src/wallet-access-requests/wallet-access-requests.service.ts`](../../../apps/api/src/wallet-access-requests/wallet-access-requests.service.ts)
- [`apps/web/src/wallets/WalletContext.tsx`](../../../apps/web/src/wallets/WalletContext.tsx)
