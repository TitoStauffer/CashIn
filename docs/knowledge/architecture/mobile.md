# Arquitetura do Mobile

**Status:** confirmado
**Última revisão:** 17/11/2026

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
  - chama `onUnauthorized` no `401`.

  Nada nele registra em log ou console, e há teste para isso. A carteira ativa entra com a DEV-143; até lá, a API usa a carteira pessoal.
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
- **`401` posterior:** qualquer requisição autenticada que receba `401` encerra a sessão. Um `401` sem token (senha errada no login) não conta, e o logout não reporta o próprio `401`.
- **Envio único:** os formulários desabilitam o botão enquanto enviam, com uma trava por `ref` para dois toques no mesmo quadro.

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
- [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
