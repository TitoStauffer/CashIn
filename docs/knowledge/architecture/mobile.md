# Arquitetura do Mobile

**Status:** confirmado
**Última revisão:** 18/11/2026

## Organização

O app fica em `apps/mobile`, com Expo SDK 58, React Native e TypeScript estrito, para Android e iOS ([DEV-141](https://titostauffer.atlassian.net/browse/DEV-141), épicos DEV-138 e DEV-139). A navegação usa Expo Router:

- **Rotas:** cada arquivo em `src/app/` é uma rota, e `_layout.tsx` define a pilha. As rotas só ligam a tela ao caminho.
- **Fora das rotas:** telas (`src/screens/`), componentes (`src/ui/`), cliente HTTP (`src/api/`) e testes ficam fora de `src/app/`. Um teste dentro dela viraria rota.
- **Pacotes:** não há pacote compartilhado com a Web. Ele só será extraído quando houver duplicação real.

## Contratos com a API

- **Sessão por token.** O app usa `POST /auth/token` e envia `Authorization: Bearer` ([DEV-140](https://titostauffer.atlassian.net/browse/DEV-140)), nunca o cookie. O token fica só no `expo-secure-store`, com `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: no Keychain do iOS e no armazenamento protegido pelo Keystore no Android. O app não depende de `AsyncStorage`, e um teste falha se a dependência aparecer.
- **Um cliente HTTP** em `src/api/client.ts`, que:
  - anexa o token e, nas rotas escopadas, o `X-Wallet-Id`;
  - recusa caminho inseguro (`..` em qualquer grafia, protocolo-relativo, esquema próprio);
  - aplica timeout de 15 s;
  - transforma toda falha da requisição ou da resposta em `ApiError`, com a mensagem da API ou um texto fixo em português por status. A exceção é o caminho inseguro, que lança `Error` antes de qualquer requisição porque é erro de programação, e não algo a mostrar à pessoa;
  - chama `onUnauthorized` no `401`;
  - chama `onWalletNotFound` no `404` de uma requisição que enviou `X-Wallet-Id`, com a carteira enviada.

  Nada nele registra em log ou console, e há teste para isso.
- **Endereço da API** em `src/config/apiUrl.ts`:
  - `EXPO_PUBLIC_API_URL` vence quando definido;
  - em desenvolvimento, sem ele, o app usa o host do servidor do Expo na porta 3000, o que funciona no celular da mesma rede;
  - fora de desenvolvimento, o endereço é obrigatório e só `https` é aceito, porque o token vai em toda requisição.

## Conta e sessão (DEV-142)

- **Rotas:** `index` decide pela sessão (verificando, indisponível, fora ou dentro), `login` e `register`. As telas ficam em `src/screens/` e recebem as ações por props; a sessão vive em `src/auth/SessionProvider.tsx`.
- **Abertura do app:** um token guardado é conferido com `GET /auth/me`. Se a API recusa (`401`), o token sai do aparelho e o login mostra "Sua sessão expirou". Sem conexão, o token fica e a tela oferece tentar de novo, para o app não deslogar quem só está offline.
- **Login:** `POST /auth/token`; o token vai só para o `expo-secure-store`. As recusas mostram a mensagem da API (senha errada e conta não confirmada respondem igual, de propósito; limite de tentativas).
- **Cadastro:** `POST /auth/register`. A regra de senha é a da API, que responde a mensagem; o app só confere campos vazios e a repetição da senha. Um e-mail já usado recebe a mesma resposta de sucesso, porque a API não revela quem tem conta. O link de confirmação abre a Web, e a tela explica isso.
- **Logout:** `POST /auth/logout` encerra a sessão no servidor e o token sempre sai do aparelho, mesmo sem conexão.
- **`401` posterior:** qualquer requisição autenticada que receba `401` encerra a sessão, desde que o token recusado seja o guardado; um `401` atrasado de antes de um novo login é ignorado. Um `401` sem token (senha errada no login) não conta, e o logout não reporta o próprio `401`. Se o armazenamento seguro recusar apagar o token, o app sai mesmo assim.
- **Envio único:** os formulários desabilitam o botão enquanto enviam, com uma trava por `ref` para dois toques no mesmo quadro.

## Carteiras (DEV-143)

- **Rotas:** `wallets` (lista, troca e criação) e `wallet-sharing` (compartilhamento de uma carteira). O estado vive em `src/wallets/WalletProvider.tsx`, dentro do `SessionProvider`; as chamadas ficam em `src/wallets/walletApi.ts`.
- **Carteira ativa:** a escolha fica em memória para o cliente HTTP mandar no `X-Wallet-Id` e é lembrada por conta no `expo-secure-store` (`saldocerto.active-wallet.<userId>`). Na abertura vale a lembrada, depois a pessoal, depois a primeira. As rotas de carteira nunca levam `X-Wallet-Id`: o compartilhamento nomeia a carteira no caminho.
- **Carteira perdida:** se a lembrada não volta na lista, ou se uma requisição da carteira ativa recebe `404`, o app relê as carteiras, volta para a pessoal e avisa "A carteira escolhida não está mais disponível". Um `404` de outra carteira não relê nada. Ao sair da conta, a carteira ativa é limpa.
- **Compartilhamento:** só o proprietário de uma carteira compartilhada vê a opção; a tela também recusa sozinha quem não é proprietário, antes de chamar a API, que continua sendo a fonte da autorização. O proprietário vê membros (remover pede confirmação), convida por e-mail, cancela convites pendentes, gera o link de acesso e o envia pela folha de compartilhamento do sistema, e aprova, recusa ou cancela solicitações. As respostas mostram a mensagem da API.
- **Fora do app, por ora:** aceitar convite e pedir acesso por link continuam na Web, porque o app ainda não abre deep links.

## Categorias e formas de pagamento (DEV-144)

- **Rotas:** `categories` e `payment-methods`. As chamadas ficam em `src/catalog/catalogApi.ts`, e todas levam o `X-Wallet-Id` da carteira ativa.
- **Rotas dentro da carteira ativa:** `src/wallets/activeWalletGate.ts` decide o que uma rota escopada mostra: primeiro o redirecionamento da sessão, depois o erro das carteiras com nova tentativa, depois a espera, e só então a tela, já com a carteira. Nenhuma requisição escopada sai antes de a carteira ativa ser conhecida. As telas de lançamentos e o dashboard (DEV-145 a DEV-147) vão reutilizar esse gate.
- **Troca de carteira:** a tela recebe o id da carteira e relê a lista quando ele muda. A lista antiga sai da tela antes de chegar a nova, e formulário, editor, mensagem e erro de leitura da carteira anterior são descartados. Uma ação que termina depois da troca não é relatada nem limpa o formulário do escopo novo.
- **Categorias:** uma natureza por vez (entradas, saídas, metas de investimento e a natureza legada), com subcategorias. A tela só recusa nome em branco; nome duplicado e exclusão de item em uso são recusados pela API, e a mensagem dela aparece. Excluir pede confirmação.
- **Formas de pagamento:** a API não exclui forma de pagamento, para preservar o histórico das despesas, então o app desativa e reativa. Uma forma com natureza histórica de VA ou VR mantém essa opção enquanto é editada, e a edição manda só os campos alterados: a API normaliza toda natureza recebida, então reenviar a natureza histórica a reclassificaria.
- **Ações:** `src/ui/useActionRunner.ts` executa uma ação por vez, mostra a mensagem e relê a lista depois.

## Qualidade

- Job `Mobile` no CI: lint (`expo lint`), Jest com `jest-expo` e Testing Library, typecheck, `expo export` dos bundles Android e iOS e mutantes declarados para `apps/mobile`. A cobertura vai ao SonarQube, sem as rotas.
- **Gate e evidência:** desde a [DEV-153](https://titostauffer.atlassian.net/browse/DEV-153), o `Mobile` é exigido pelo `Merge Readiness`, pelo resumo de checks dos agentes e pelo Coordinator, e o QA lê os passos dele, inclusive os mutantes de `apps/mobile`.
- O lockfile chega aos agentes como resumo ([DEV-152](https://titostauffer.atlassian.net/browse/DEV-152)), porque passa do teto do contexto.
- O app não tem assets binários: os agentes recusam binário, e ícone e splash entram com a publicação ([DEV-151](https://titostauffer.atlassian.net/browse/DEV-151)).

## Comandos

```bash
cd apps/mobile
npm ci
npx expo start        # Expo Go no Android ou iOS, na mesma rede da API
npm run lint
npm run test:coverage
npm run typecheck
npm run build         # expo export dos bundles Android e iOS
```

A API precisa estar acessível pelo celular. O `docker compose up` publica a porta 3000 em todas as interfaces, mas o firewall do Windows pode bloqueá-la para a rede local.

## Fontes verificáveis

- [`apps/mobile/package.json`](../../../apps/mobile/package.json)
- [`apps/mobile/app.json`](../../../apps/mobile/app.json)
- [`apps/mobile/src/api/client.ts`](../../../apps/mobile/src/api/client.ts)
- [`apps/mobile/src/config/apiUrl.ts`](../../../apps/mobile/src/config/apiUrl.ts)
- [`apps/mobile/src/auth/tokenStorage.ts`](../../../apps/mobile/src/auth/tokenStorage.ts)
- [`apps/mobile/src/auth/SessionProvider.tsx`](../../../apps/mobile/src/auth/SessionProvider.tsx)
- [`apps/mobile/src/auth/authApi.ts`](../../../apps/mobile/src/auth/authApi.ts)
- [`apps/mobile/src/wallets/WalletProvider.tsx`](../../../apps/mobile/src/wallets/WalletProvider.tsx)
- [`apps/mobile/src/wallets/walletApi.ts`](../../../apps/mobile/src/wallets/walletApi.ts)
- [`apps/mobile/src/wallets/activeWallet.ts`](../../../apps/mobile/src/wallets/activeWallet.ts)
- [`apps/mobile/src/screens/WalletSharingScreen.tsx`](../../../apps/mobile/src/screens/WalletSharingScreen.tsx)
- [`apps/mobile/src/catalog/catalogApi.ts`](../../../apps/mobile/src/catalog/catalogApi.ts)
- [`apps/mobile/src/wallets/activeWalletGate.ts`](../../../apps/mobile/src/wallets/activeWalletGate.ts)
- [`docs/api.md`](../../api.md) — contrato das rotas de carteira, convites, membros, link de acesso e solicitações que `walletApi.ts` segue, e das categorias e formas de pagamento que `catalogApi.ts` segue
- [`apps/api/src/wallets/wallets.routes.ts`](../../../apps/api/src/wallets/wallets.routes.ts)
- [`apps/api/src/wallet-invitations/wallet-invitations.routes.ts`](../../../apps/api/src/wallet-invitations/wallet-invitations.routes.ts)
- [`apps/api/src/wallet-access-requests/wallet-access-requests.routes.ts`](../../../apps/api/src/wallet-access-requests/wallet-access-requests.routes.ts)
- [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
