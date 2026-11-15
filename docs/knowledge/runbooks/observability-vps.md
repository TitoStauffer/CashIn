# Runbook — Stack de observabilidade na VPS

**Status:** preparado na DEV-133, ainda **não aplicado**. Aplicar na VPS exige pedido explícito do Tito.
**Última revisão:** 15/11/2026

Configuração em `deploy/observability/`: OpenTelemetry Collector, Loki, Tempo, Prometheus e Grafana, cada um numa imagem própria fixada por digest. É a mesma visão do ambiente local (`docs/observability.md`), sem a imagem de desenvolvimento `grafana/otel-lgtm`.

## Desenho

- **Rede compartilhada com a API.** A API envia OTLP/HTTP para `otel-collector:4318` pela rede Docker `saldocerto-observability`. O coletor é o único serviço dessa rede.
- **Rede interna.** Loki, Tempo, Prometheus e Grafana conversam só pela rede `internal`, marcada como `internal: true`.
- **Portas.** Nenhuma porta fica em interface pública. O Grafana é o único publicado, em `127.0.0.1:3001`, por uma rede `ui` que carrega só essa porta.
- **Acesso.** Túnel SSH, nunca porta aberta no firewall.
- **Persistência.** Volumes nomeados `loki_data`, `tempo_data`, `prometheus_data` e `grafana_data`.

| Sinal | Componente | Retenção | Teto |
| --- | --- | --- | --- |
| Logs | Loki | 7 dias (`retention_period: 168h`, compactor a cada 10 min) | ingestão limitada a 4 MB/s (pico de 8 MB) |
| Traces | Tempo | 7 dias (`block_retention: 168h` no scheduler e no worker) | ingestão limitada a 4 MB/s (pico de 8 MB) |
| Métricas | Prometheus | 15 dias **ou** 2 GB, o que vier primeiro | 2 GB em disco (`retention.size`) |

Loki e Tempo não têm teto de disco nativo. O teto deles é a retenção multiplicada pela ingestão real. Monitore o uso dos volumes na primeira semana e ajuste `retention_period` e `block_retention` se o disco da VPS pedir.

| Serviço | CPU | Memória |
| --- | --- | --- |
| otel-collector | 0,5 | 256 MB (o `memory_limiter` recusa carga em 200 MB) |
| loki | 0,5 | 512 MB |
| tempo | 0,5 | 512 MB |
| prometheus | 0,5 | 512 MB |
| grafana | 0,5 | 384 MB |

No total, até 2,5 CPUs e cerca de 2,2 GB. A VPS precisa ter folga para isso **além** da API, do banco e da Web. Os limites existem para a observabilidade nunca derrubar a API.

## Aplicar (somente quando o deploy for pedido)

1. Na VPS, crie fora do repositório um diretório de segredos com permissão restrita:

   ```bash
   install -d -m 700 /etc/saldocerto/observability
   openssl rand -base64 24 > /etc/saldocerto/observability/grafana-admin-password
   chmod 644 /etc/saldocerto/observability/grafana-admin-password
   ```

   O `644` é proposital. Fora do swarm, o secret do Compose é um bind mount que mantém as permissões do host, e o Grafana roda como uid 472 dentro do container. Um arquivo `600` do root fica ilegível para ele, e o Grafana subiria **sem** a senha configurada. Quem impede os outros usuários do host de ler a senha é o diretório `700`. O smoke test do CI pegou esse problema na primeira execução.

2. Copie `deploy/observability/.env.example` para `deploy/observability/.env` e preencha `GRAFANA_ADMIN_USER` com um login que não seja `admin`, e `GRAFANA_ADMIN_PASSWORD_FILE` com o caminho do passo 1. O `.env` fica fora do Git.
3. Valide antes de subir:

   ```bash
   docker compose -f deploy/observability/compose.yaml config --format json | node deploy/observability/check-compose.mjs
   ```

4. Suba: `docker compose -f deploy/observability/compose.yaml up -d`.
5. Ligue a API à rede `saldocerto-observability` e defina, no ambiente dela:
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`
   - `OTEL_LOGS_EXPORTER=otlp`
   - `OTEL_SERVICE_NAME=saldocerto-api`
6. Confira a ausência de porta pública: `ss -tlnp` não pode listar 3001, 3100, 3200, 4318 ou 9090 fora de `127.0.0.1`.

## Acessar

De sua máquina, abra o túnel com `ssh -N -L 3001:127.0.0.1:3001 <usuário>@<vps>`, abra http://localhost:3001 e entre com o usuário e a senha do passo 1. O Grafana não aceita acesso anônimo, cadastro, login básico pela API nem instalação de plugins.

## Rotacionar a senha do Grafana

1. Gere uma senha nova no arquivo do passo 1.
2. O Grafana só lê `GF_SECURITY_ADMIN_PASSWORD__FILE` na **criação** do banco dele. Com o volume já existente, troque também pela CLI:

   ```bash
   docker compose -f deploy/observability/compose.yaml exec grafana grafana cli admin reset-admin-password "$(cat /etc/saldocerto/observability/grafana-admin-password)"
   ```

3. Confirme o login com a senha nova pelo túnel.

## Recuperar

- **Um serviço parou:** `docker compose -f deploy/observability/compose.yaml ps`. Leia os logs do serviço com `logs <serviço> --tail 100` e suba de novo com `up -d <serviço>`. A API continua funcionando com o coletor fora do ar: os envios falham em silêncio.
- **Disco cheio:** reduza a retenção (tabela acima), suba de novo o serviço e aguarde a compactação. Em último caso, `docker volume rm` do volume do sinal afetado apaga só o histórico daquele sinal.
- **Configuração inválida depois de atualizar uma imagem:** volte o digest anterior no `compose.yaml`. Rode o `check-compose.mjs` e o roteiro de validação antes de trocar versões.

## Validação (simulando a VPS)

`node deploy/observability/smoke/smoke-test.mjs`, na raiz do repositório, faz a validação completa. O job `Observability stack` do CI roda o mesmo script sempre que o commit altera `deploy/observability`. Ele verifica, por trace, log e métrica OTLP enviados pela rede `saldocerto-observability`:
- os três sinais chegam e podem ser consultados pelo Grafana autenticado;
- o Grafana recusa acesso anônimo (`401`);
- os dados persistem depois de `down`/`up`;
- só o Grafana publica porta, e só em `127.0.0.1`.

Rode o script antes de trocar versões ou configurações. Ele usa uma senha temporária e sempre desmonta a stack com os volumes.

## Fontes

- [`deploy/observability/compose.yaml`](../../../deploy/observability/compose.yaml)
- [`deploy/observability/otel-collector.yaml`](../../../deploy/observability/otel-collector.yaml)
- [`deploy/observability/loki.yaml`](../../../deploy/observability/loki.yaml)
- [`deploy/observability/tempo.yaml`](../../../deploy/observability/tempo.yaml)
- [`deploy/observability/check-compose.mjs`](../../../deploy/observability/check-compose.mjs)
- [`deploy/observability/smoke/smoke-test.mjs`](../../../deploy/observability/smoke/smoke-test.mjs)
