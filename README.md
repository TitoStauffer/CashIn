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

As senhas de novas contas devem ter pelo menos 8 caracteres e incluir uma letra maiúscula, uma minúscula, um número e um caractere especial.

Para parar os containers, use docker compose down. Para remover também os dados locais do banco, use docker compose down -v.

O MVP 1 será validado com API e Web. A API é independente do cliente e poderá ser consumida pelo aplicativo Mobile quando essa etapa entrar no escopo.

## Deploy

Deploy em nuvem e domínio próprio estão fora desta etapa. As imagens e configurações locais serão usadas para validar o ambiente antes de escolher o provedor.

