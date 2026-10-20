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

Para parar os containers, use docker compose down. Para remover também os dados locais do banco, use docker compose down -v.

O MVP 1 será validado com API e Web. A API é independente do cliente e poderá ser consumida pelo aplicativo Mobile quando essa etapa entrar no escopo.

## Deploy

Deploy em nuvem e domínio próprio estão fora desta etapa. As imagens e configurações locais serão usadas para validar o ambiente antes de escolher o provedor.

