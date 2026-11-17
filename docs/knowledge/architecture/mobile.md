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

## Qualidade

- Job `Mobile` no CI: lint (`expo lint`), Jest com `jest-expo` e Testing Library, typecheck, `expo export` dos bundles Android e iOS e mutantes declarados para `apps/mobile`. A cobertura vai ao SonarQube, sem as rotas.
- **Pendências da automação:** o job ainda não está na lista de checks do `Merge Readiness` nem na evidência de CI lida pelos agentes ([DEV-153](https://titostauffer.atlassian.net/browse/DEV-153)). Enquanto isso, o `SonarQube` depende do `Mobile`, então um job vermelho ainda segura o CI completo.
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
- [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
