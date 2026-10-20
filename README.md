# Saldo Certo

Base inicial do MVP 1.

## Stack

- API: Node.js, Fastify e TypeScript
- Web: React, Vite e TypeScript
- Banco local: PostgreSQL

## Requisitos locais

- Docker Desktop com Docker Compose
- Node.js 24 ou compatível com os projetos
- npm

## Iniciar a Web, API e PostgreSQL

Opcionalmente, copie .env.example para .env para explicitar as credenciais locais. Depois, na raiz do repositório, execute:

    docker compose up --build

- Web: http://localhost:5173
- Health da API e do PostgreSQL: http://localhost:3000/health
- PostgreSQL no host: localhost:5433

O Compose cria um volume persistente para os dados locais do PostgreSQL. As credenciais padrão no Compose são exclusivas para desenvolvimento local e não devem ser reutilizadas em produção.

## Confirmação de e-mail

Para enviar links de confirmação, preencha `SMTP_USER` e `SMTP_PASSWORD` no arquivo `.env` local. Para Gmail, use o endereço completo da conta e uma senha de app do Google; não use a senha normal da conta. Ative a verificação em duas etapas na conta para criar uma senha de app.

O padrão usa `smtp.gmail.com` na porta `587` com STARTTLS (`SMTP_SECURE=false`). Para a porta `465`, configure `SMTP_SECURE=true`. `SMTP_FROM` é opcional e, se omitido, usa `SMTP_USER`. Mantenha o `.env` fora do Git. Sem credenciais válidas, a API sobe, mas não envia a confirmação.

O cadastro responde sem aguardar o envio do e-mail, que ocorre em segundo plano no processo da API. Se o envio falhar, a conta pendente é removida e o erro SMTP é registrado sem credenciais ou conteúdo do e-mail; corrija a configuração e tente cadastrar novamente. Esse processamento em memória atende ao MVP local, mas não mantém tarefas pendentes caso o processo da API seja reiniciado durante o envio.

O mesmo SMTP envia convites de carteira. O prazo padrão do convite é de 168 horas; `WALLET_INVITATION_TOKEN_TTL_HOURS` pode alterar esse prazo. O token bruto existe apenas no link enviado e nunca é armazenado no banco (somente seu hash é persistido). Em cadastro iniciado por convite, a Web envia `inviteToken` para `POST /auth/register`; a API preserva o convite no link de confirmação para que o fluxo funcione mesmo quando o e-mail abre outra aba. A pessoa confirma o e-mail, entra na conta e aceita o convite autenticada.

As senhas de novas contas devem ter pelo menos 8 caracteres e incluir uma letra maiúscula, uma minúscula, um número e um caractere especial.

Cadastro e login têm limites temporários de tentativas por endereço IP para reduzir abuso. O controle é mantido em memória e atende ao MVP com uma única instância da API; para múltiplas instâncias, será necessário compartilhar o estado do limitador.

## Carteiras e escopo dos dados

Os dados financeiros são organizados por carteira. Toda conta possui uma carteira pessoal; um usuário também pode ter acesso a outras carteiras quando estiver cadastrado como membro.

- `GET /wallets` lista as carteiras às quais o usuário autenticado pertence. A resposta tem o formato `{ "items": [{ "id": "<uuid>", "name": "Pessoal", "isPersonal": true, "role": "owner" }] }`.
- `POST /wallets` cria uma carteira adicional para o usuário autenticado, com `{ "name": "Viagem" }`, e retorna a carteira criada com status `201`.

Convites e administração de membros são exclusivos do proprietário de carteiras compartilhadas (carteira pessoal não pode ser compartilhada):

- `POST /wallets/:walletId/invites` com `{ "email": "pessoa@example.com" }` cria um convite e agenda o e-mail em segundo plano; retorna `202` sem o token.
- `GET /wallets/:walletId/invites` lista convites e estados `pending`, `accepted`, `cancelled` ou `expired`.
- `DELETE /wallets/:walletId/invites/:inviteId` cancela um convite pendente e retorna `204`.
- `POST /wallet-invitations/accept` com `{ "token": "..." }` exige sessão autenticada e e-mail confirmado que corresponda ao endereço convidado; retorna `200` com a carteira concedida. Tokens expirados, cancelados ou já usados são recusados.
- `GET /wallets/:walletId/members` lista proprietário e membros; `DELETE /wallets/:walletId/members/:userId` remove um membro e encerra seu acesso à carteira. A propriedade não pode ser removida por esse endpoint.

Convites não concedem acesso até a aceitação autenticada. Um membro pode usar os recursos financeiros da carteira, mas não pode listar/cancelar convites, administrar membros ou transferir propriedade; essas rotas respondem `404` para não proprietários.

Envie `X-Wallet-Id: <uuid>` nas operações de categorias, entradas, saídas, metas de investimento, aportes e resumo financeiro para selecionar a carteira. Se o header for omitido, a API usa a carteira pessoal do usuário. A API só permite acessar uma carteira quando há um registro de membership para o usuário autenticado; carteira inexistente ou sem acesso retorna `404`.

Links de solicitação de acesso a carteiras compartilhadas são válidos por 168 horas por padrão; configure WALLET_ACCESS_LINK_TTL_HOURS para mudar esse prazo. Cada novo link revoga o anterior e somente seu hash é armazenado. A solicitação válida notifica o proprietário por e-mail, sem revelar informações financeiras ao solicitante. A aprovação envia um convite de uso único; o acesso só é concedido após cadastro ou login, confirmação do e-mail e aceite autenticado.

- POST /wallets/:walletId/access-links (somente proprietário) cria link e retorna seu URL e prazo de expiração.
- POST /wallet-access-requests recebe token e e-mail sem autenticação; retorna a mesma resposta para links válidos e inválidos e limita tentativas por IP.
- GET /wallets/:walletId/access-requests lista solicitações somente para o proprietário.
- POST /wallets/:walletId/access-requests/:requestId/approve aprova e envia convite; /reject recusa. DELETE /wallets/:walletId/access-requests/:requestId cancela solicitações pendentes.

## Categorias financeiras

Categorias e subcategorias são gerenciadas dentro da carteira selecionada. As naturezas disponíveis são `income` (entrada), `expense` (saída), `investment` (meta de investimento) e `investment_goal` (natureza legada, mantida por compatibilidade). Uma subcategoria herda a natureza da categoria.

- `GET /categories?nature=income|expense|investment|investment_goal` lista categorias e suas subcategorias; o filtro `nature` é opcional.
- `POST /categories` cria uma categoria com `{ "name": "...", "nature": "income" }`.
- `PATCH /categories/:categoryId` renomeia uma categoria com `{ "name": "..." }`.
- `DELETE /categories/:categoryId` exclui uma categoria e suas subcategorias, desde que não estejam referenciadas por movimentações ou metas.
- `POST /categories/:categoryId/subcategories` cria uma subcategoria com `{ "name": "..." }`.
- `PATCH /categories/:categoryId/subcategories/:subcategoryId` renomeia uma subcategoria com `{ "name": "..." }`.
- `DELETE /categories/:categoryId/subcategories/:subcategoryId` exclui uma subcategoria, desde que não esteja referenciada.

Os nomes são normalizados sem espaços nas extremidades e não diferenciam maiúsculas de minúsculas: categorias devem ser únicas por carteira e natureza; subcategorias, dentro da categoria. A natureza de uma categoria não pode ser alterada. A API responde `409` para nomes duplicados ou tentativas de excluir itens em uso.

### Formas de pagamento

Cada carteira recebe as formas iniciais Crédito, Débito, Pix, Vale-Alimentação, Vale-Refeição e Auxílio Home Office. Elas podem ser consultadas, cadastradas, renomeadas, reclassificadas e desativadas na carteira ativa. Formas de pagamento não são removidas fisicamente para preservar o histórico das despesas.

- `GET /payment-methods` lista formas ativas e inativas da carteira; a Web usa somente as ativas em novos lançamentos e mantém as inativas visíveis no histórico.
- `POST /payment-methods` recebe `{ "name": "Cartão de débito", "nature": "immediate" }`.
- `PATCH /payment-methods/:paymentMethodId` altera `name`, `nature` e/ou `isActive`.

Os valores aceitos para `nature` são `immediate`, `credit_card`, `food_benefit`, `meal_benefit` e `home_office_benefit`. Nomes são únicos por carteira sem diferenciar caixa ou acentuação. A natureza registra o tipo de meio para tratamento futuro; regras de fatura e de saldo de benefícios pertencem a Histórias próprias.

Para parar os containers, use docker compose down. Para remover também os dados locais do banco, use docker compose down -v.

## Lançamentos de entrada

Todas as operações de entrada exigem uma sessão autenticada e são isoladas pela carteira selecionada. Os valores monetários são enviados e retornados como strings decimais, com até duas casas, para preservar a precisão.

- `GET /incomes?from=AAAA-MM-DD&to=AAAA-MM-DD` lista entradas; os filtros de data são opcionais e inclusivos, com ordenação por data e criação mais recentes primeiro.
- `POST /incomes` cria uma entrada com `{ "amount": "1250.50", "date": "2026-10-19", "description": "Salário", "categoryId": "<uuid>", "subcategoryId": "<uuid-ou-null>" }`.
- `PUT /incomes/:incomeId` substitui os campos editáveis e aceita a mesma estrutura do cadastro; descrição e subcategoria podem ser omitidas ou nulas.
- `DELETE /incomes/:incomeId` exclui uma entrada e retorna `204`.

As categorias precisam pertencer à carteira selecionada e ter natureza `income`. A subcategoria, quando informada, precisa pertencer à categoria selecionada.

## Lançamentos de saída

Todas as operações de saída exigem uma sessão autenticada e são isoladas pela carteira selecionada. Os valores monetários são enviados e retornados como strings decimais, com até duas casas, para preservar a precisão.

- `GET /expenses?from=AAAA-MM-DD&to=AAAA-MM-DD` lista saídas; os filtros de data são opcionais e inclusivos, com ordenação por data e criação mais recentes primeiro.
- `POST /expenses` cria uma saída com `{ "amount": "1250.50", "date": "2026-10-19", "description": "Mercado", "categoryId": "<uuid>", "subcategoryId": "<uuid-ou-null>", "paymentMethodId": "<uuid-ou-null>" }`.
- `PUT /expenses/:expenseId` substitui os campos editáveis e aceita a mesma estrutura do cadastro; descrição, subcategoria e forma de pagamento podem ser omitidas ou nulas.
- `DELETE /expenses/:expenseId` exclui uma saída e retorna `204`.

O valor deve ser positivo. As categorias precisam pertencer à carteira selecionada e ter natureza `expense`; a subcategoria, quando informada, precisa pertencer à categoria selecionada. Uma forma de pagamento informada precisa estar ativa e pertencer à mesma carteira. IDs de saídas de outras carteiras não podem ser consultados, alterados ou excluídos.

## Resumo financeiro

`GET /financial-summary?from=AAAA-MM-DD&to=AAAA-MM-DD` retorna os totais da carteira selecionada, com filtros de data opcionais e inclusivos. A resposta separa as entradas, despesas de consumo e aportes: `{ "incomeTotal": "500.00", "expenseTotal": "100.00", "contributionTotal": "50.00", "availableBalance": "350.00" }`. O saldo disponível é calculado como entradas menos despesas menos aportes; aportes não são somados às despesas.

## Metas de investimento e aportes

Todas as operações de metas e aportes exigem autenticação e usam a carteira selecionada como escopo. Valores monetários são decimais enviados e retornados como strings, preservando até duas casas decimais. A natureza de categoria `investment` pode ser usada para associar uma meta; `investment_goal` permanece válida para compatibilidade com categorias existentes.

- `GET /investment-goals` lista metas com `contributedAmount` e `progressPercentage` calculados a partir dos aportes atuais.
- `GET /investment-goals/:goalId` consulta uma meta e seu progresso.
- `POST /investment-goals` cria uma meta com `{ "title": "Reserva", "description": "Reserva de emergência", "targetAmount": "10000.00", "dueDate": null, "categoryId": "<uuid-ou-null>", "subcategoryId": "<uuid-ou-null>" }`. Prazo e categoria/subcategoria são opcionais.
- `PUT /investment-goals/:goalId` substitui os campos editáveis da meta usando o mesmo formato de cadastro.
- `POST /investment-goals/:goalId/close` encerra uma meta. Metas encerradas continuam consultáveis; criação de aporte, edição da meta e edição ou exclusão de aportes retornam `409`.
- `GET /investment-goals/:goalId/contributions` lista os aportes da meta.
- `POST /investment-goals/:goalId/contributions` cria um aporte com `{ "amount": "250.00", "date": "2026-10-19", "description": "Aporte mensal" }`.
- `PUT /investment-goals/:goalId/contributions/:contributionId` atualiza um aporte; `DELETE` no mesmo caminho o exclui.

O total aportado e o percentual são derivados na consulta, portanto criação, edição e exclusão de aportes atualizam o progresso sem duplicar valores. Aportes são registros financeiros separados das despesas de consumo.

O MVP 1 será validado com API e Web. A API é independente do cliente e poderá ser consumida pelo aplicativo Mobile quando essa etapa entrar no escopo.

## Integração contínua

O workflow `.github/workflows/ci.yml` (GitHub Actions) valida a API e a Web em todo Pull Request e push para `master`: lint (Web), typecheck, testes unitários e de integração com PostgreSQL (API) e build. Detalhes, checks obrigatórios do GitHub e a preparação para o SonarQube estão em [docs/ci.md](docs/ci.md).

## Deploy

Deploy em nuvem e domínio próprio estão fora desta etapa. As imagens e configurações locais serão usadas para validar o ambiente antes de escolher o provedor.
