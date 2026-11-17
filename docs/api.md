# Referência da API

Referência dos recursos HTTP da API, por domínio. Ela saiu do README na DEV-137. Nessa mudança, três trechos defasados foram atualizados: o pagamento parcial de fatura, o CSV já suportado e a menção ao MVP 1. Contratos maiores ficam em documentos próprios:

- importação financeira: [`financial-imports-contract.md`](financial-imports-contract.md);
- resumo do dashboard: [`dashboard-summary-contract.md`](dashboard-summary-contract.md);
- arquitetura e regras de logs, traces e métricas: [`knowledge/architecture/api.md`](knowledge/architecture/api.md).

Toda resposta traz o header `X-Request-Id`, que é o `reqId` dos logs daquela requisição (DEV-130).

## Confirmação de e-mail

Para enviar links de confirmação, preencha `SMTP_USER` e `SMTP_PASSWORD` no arquivo `.env` local. Para Gmail, use o endereço completo da conta e uma senha de app do Google; não use a senha normal da conta. Ative a verificação em duas etapas na conta para criar uma senha de app.

O padrão usa `smtp.gmail.com` na porta `587` com STARTTLS (`SMTP_SECURE=false`). Para a porta `465`, configure `SMTP_SECURE=true`. `SMTP_FROM` é opcional e, se omitido, usa `SMTP_USER`. Mantenha o `.env` fora do Git. Sem credenciais válidas, a API sobe, mas não envia a confirmação.

O cadastro responde sem aguardar o envio do e-mail, que ocorre em segundo plano no processo da API. Se o envio falhar, a conta pendente é removida e o erro SMTP é registrado sem credenciais ou conteúdo do e-mail; corrija a configuração e tente cadastrar novamente. Esse processamento em memória atende ao MVP local, mas não mantém tarefas pendentes caso o processo da API seja reiniciado durante o envio.

O mesmo SMTP envia convites de carteira. O prazo padrão do convite é de 168 horas; `WALLET_INVITATION_TOKEN_TTL_HOURS` pode alterar esse prazo. O token bruto existe apenas no link enviado e nunca é armazenado no banco (somente seu hash é persistido). Em cadastro iniciado por convite, a Web envia `inviteToken` para `POST /auth/register`; a API preserva o convite no link de confirmação para que o fluxo funcione mesmo quando o e-mail abre outra aba. A pessoa confirma o e-mail, entra na conta e aceita o convite autenticada.

As senhas de novas contas devem ter pelo menos 8 caracteres e incluir uma letra maiúscula, uma minúscula, um número e um caractere especial.

Cadastro e login têm limites temporários de tentativas por endereço IP para reduzir abuso. O controle é mantido em memória e atende ao MVP com uma única instância da API; para múltiplas instâncias, será necessário compartilhar o estado do limitador.

## Sessão: cookie na Web, token nos clientes nativos

A sessão é a mesma nos dois casos: um token opaco, do qual o banco guarda só o hash em `auth_sessions`. O que muda é por onde ele viaja (DEV-140).

- **Web:** `POST /auth/login` com `{ "email", "password" }` responde `{ "user" }` e define o cookie `HttpOnly; SameSite=Lax` (`Secure` em produção). O token nunca aparece no corpo.
- **Clientes nativos (app mobile):** `POST /auth/token`, com o mesmo corpo, responde `200` com `{ "user": { "id", "email" }, "token": "<token>", "expiresAt": "<ISO 8601>" }` e `Cache-Control: no-store`, sem cookie. O cliente guarda o token no armazenamento seguro do aparelho e o envia em `Authorization: Bearer <token>` em toda rota autenticada, junto com `X-Wallet-Id` quando quiser outra carteira.
- **Precedência:** quando o header `Authorization` está presente, só ele vale, mesmo malformado. A API não recorre ao cookie, para que a requisição nunca se autentique como uma sessão diferente da que ela nomeia. O esquema `Bearer` não diferencia maiúsculas; o token, sim.
- **Erros:** token malformado, desconhecido, expirado ou de sessão encerrada responde `401` com `{ "message": "Autenticação necessária." }`. Conta não confirmada ou senha errada no `/auth/token` responde `401` com a mesma mensagem do login da Web.
- **Logout:** `POST /auth/logout` com o header encerra a sessão no servidor, como com o cookie.
- **Limite de tentativas:** `/auth/login` e `/auth/token` compartilham o mesmo orçamento por IP, para que o segundo caminho não dobre as tentativas contra uma senha.
- **CSRF:** o token no header não é enviado sozinho pelo navegador, então a falsificação de requisição entre sites não se aplica a ele. O cookie da Web continua protegido pelo `SameSite=Lax`.

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

Cada carteira recebe as formas iniciais Crédito, Débito, Pix, Cartão de benefícios (VA/VR) e Auxílio Home Office (AHO). VA e VR compartilham um único saldo e uma única opção para novos lançamentos; formas antigas de VA e VR permanecem inativas para preservar o histórico. As formas podem ser consultadas, cadastradas, renomeadas, reclassificadas e desativadas na carteira ativa. Formas de pagamento não são removidas fisicamente para preservar o histórico das despesas.

- `GET /payment-methods` lista formas ativas e inativas da carteira; a Web usa somente as ativas em novos lançamentos e mantém as inativas visíveis no histórico.
- `POST /payment-methods` recebe `{ "name": "Cartão de débito", "nature": "immediate" }`.
- `PATCH /payment-methods/:paymentMethodId` altera `name`, `nature` e/ou `isActive`.

Os valores aceitos para `nature` incluem `immediate`, `credit_card`, `food_meal_benefit` e `home_office_benefit`. `food_benefit` e `meal_benefit` continuam aceitos para compatibilidade e registros históricos, mas novas gravações são normalizadas para `food_meal_benefit`. Nomes são únicos por carteira sem diferenciar caixa ou acentuação. Despesas no cartão VA/VR reduzem o saldo unificado VA/VR; despesas com AHO reduzem o saldo AHO.
Despesas com natureza `credit_card` exigem um cartão cadastrado na mesma carteira.

### Cartões de crédito e faturas

Cada cartão pertence à carteira ativa e possui apelido, dia de fechamento e dia de vencimento próprios. Os dias aceitam valores de 1 a 31; em meses mais curtos, o fechamento ou vencimento é limitado ao último dia do mês. Compras até e inclusive o dia de fechamento entram na fatura que fecha naquele dia; compras posteriores entram no próximo ciclo. Quando o vencimento configurado não é posterior ao fechamento, ele ocorre no mês seguinte.

- `GET /credit-cards` lista cartões ativos e inativos.
- `POST /credit-cards` recebe `{ "nickname": "Gold", "closingDay": 10, "dueDay": 20 }`.
- `PATCH /credit-cards/:creditCardId` altera `nickname`, `closingDay`, `dueDay` e/ou `isActive`.
- `GET /credit-cards/:creditCardId/statements?from=AAAA-MM-DD&to=AAAA-MM-DD` lista faturas pelo período da data de fechamento, com total, compras categorizadas e situação.
- `POST /credit-cards/:creditCardId/statements/:statementId/pay` recebe `{ "date": "2026-10-20" }` e quita o saldo devedor da fatura, ou `{ "date": "2026-10-20", "amount": "300.00" }` para um pagamento parcial (DEV-85). Uma fatura liquidada não aceita novos pagamentos. Pagamentos também podem vir do extrato bancário importado, pela conciliação descrita em [`financial-imports-contract.md`](financial-imports-contract.md).

Cada pagamento, integral ou parcial, reduz o saldo em dinheiro na data informada. As compras permanecem registradas como despesas nas datas originais e em suas categorias; o pagamento não cria uma nova despesa. A fatura é liquidada quando os pagamentos cobrem o total. Depois disso, suas compras não podem ser adicionadas, editadas ou excluídas.

## Lançamentos de entrada

Todas as operações de entrada exigem uma sessão autenticada e são isoladas pela carteira selecionada. Os valores monetários são enviados e retornados como strings decimais, com até duas casas, para preservar a precisão.

- `GET /incomes?from=AAAA-MM-DD&to=AAAA-MM-DD` lista entradas; os filtros de data são opcionais e inclusivos, com ordenação por data e criação mais recentes primeiro.
- `POST /incomes` cria uma entrada com `{ "amount": "1250.50", "date": "2026-10-19", "description": "Salário", "categoryId": "<uuid>", "subcategoryId": "<uuid-ou-null>", "balanceType": "cash" }`. `balanceType` aceita `cash`, `food_meal_benefit` ou `home_office_benefit`; os valores antigos `food_benefit` e `meal_benefit` continuam aceitos e são normalizados para o saldo unificado. Quando omitido por clientes antigos, a entrada é tratada como dinheiro.
- `PUT /incomes/:incomeId` substitui os campos editáveis e aceita a mesma estrutura do cadastro; descrição e subcategoria podem ser omitidas ou nulas.
- `DELETE /incomes/:incomeId` exclui uma entrada e retorna `204`.

As categorias precisam pertencer à carteira selecionada e ter natureza `income`. A subcategoria, quando informada, precisa pertencer à categoria selecionada.

## Lançamentos de saída

Todas as operações de saída exigem uma sessão autenticada e são isoladas pela carteira selecionada. Os valores monetários são enviados e retornados como strings decimais, com até duas casas, para preservar a precisão.

- `GET /expenses?from=AAAA-MM-DD&to=AAAA-MM-DD` lista saídas; os filtros de data são opcionais e inclusivos, com ordenação por data e criação mais recentes primeiro.
- `POST /expenses` cria uma saída com `{ "amount": "1250.50", "date": "2026-10-19", "description": "Mercado", "categoryId": "<uuid>", "subcategoryId": "<uuid-ou-null>", "paymentMethodId": "<uuid-ou-null>", "creditCardId": "<uuid-ou-null>" }`. Quando a forma de pagamento tem natureza `credit_card`, `creditCardId` é obrigatório.
- `PUT /expenses/:expenseId` substitui os campos editáveis e aceita a mesma estrutura do cadastro; descrição, subcategoria e forma de pagamento podem ser omitidas ou nulas.
- `DELETE /expenses/:expenseId` exclui uma saída e retorna `204`.

O valor deve ser positivo. As categorias precisam pertencer à carteira selecionada e ter natureza `expense`; a subcategoria, quando informada, precisa pertencer à categoria selecionada. Uma forma de pagamento e um cartão informados precisam pertencer à mesma carteira; novos lançamentos só podem usar meios e cartões ativos. IDs de saídas de outras carteiras não podem ser consultados, alterados ou excluídos.

## Resumo financeiro

`GET /financial-summary?from=AAAA-MM-DD&to=AAAA-MM-DD` retorna os totais da carteira selecionada, com filtros de data opcionais e inclusivos. `incomeTotal` e `expenseTotal` continuam representando todos os lançamentos do período, contabilizados nas datas das compras. `availableBalance` mantém compatibilidade e equivale a `cashBalance`, que considera entradas em dinheiro, despesas pagas em dinheiro, aportes e pagamentos de faturas na data da quitação. O pagamento da fatura não duplica `expenseTotal`. `benefitBalances` informa separadamente os saldos de VA, VR e AHO; cada despesa paga com um benefício reduz somente o saldo daquele tipo. Entradas antigas sem destino são tratadas como dinheiro.

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

A API é independente do cliente. Hoje ela atende a Web, e o app mobile (épicos DEV-138 e DEV-139) a consome com o token de `POST /auth/token`, descrito em [Sessão](#sessão-cookie-na-web-token-nos-clientes-nativos).

O contrato da importação financeira está em [financial-imports-contract.md](financial-imports-contract.md). Ele cobre extratos bancários OFX e CSV configurável, faturas de cartão, limites, estados, prévia, confirmação atômica e desfazer.
