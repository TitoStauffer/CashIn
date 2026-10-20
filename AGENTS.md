# Instruções do projeto

## Comunicação e autonomia

- Responda em português, de forma curta e explicativa; use inglês apenas quando solicitado.
- Antes de editar, entenda o pedido e inspecione o contexto relevante do projeto.
- Tome decisões de implementação rotineiras com bom senso, seguindo boas práticas de engenharia de software. Peça esclarecimento apenas quando uma decisão puder causar falha grave, perda de dados, risco material, custo relevante ou mudança de escopo.
- Mantenha as alterações limitadas à funcionalidade solicitada.

## Stack e arquitetura

- API: Node.js, TypeScript e Fastify.
- Web: React, TypeScript e Vite.
- Banco de dados: PostgreSQL.
- Use Docker Compose para o ambiente local quando aplicável.
- Mantenha a API independente do cliente que a consome.
- Organize funcionalidades da API em camadas claras, como rotas/controllers para HTTP, services para casos de uso e regras de negócio, repositories para persistência e schemas para validação e contratos.
- Mantenha as regras de negócio desacopladas de Fastify e do banco. Não force camadas ou abstrações sem necessidade; aplique DDD apenas quando a complexidade do domínio justificar(mas pergunte antes de aplicar o DDD).
- Prefira código claro, orientado a objetos quando adequado, e siga KISS, DRY, e SOLID.
- Reutilize dependências existentes. Peça confirmação antes de adicionar dependências de produção.
- Preserve compatibilidade de APIs e banco quando viável. Faça alterações de esquema por migrações versionadas.
- Identificadores do código, incluindo nomes de métodos e classes, e comentários devem ser escritos em inglês. Mensagens de exceção ou erro que serão exibidas ao usuário pelos clientes Web ou Mobile devem ser escritas em português.

## Qualidade, segurança e documentação

- Preserve e amplie a cobertura de testes relevante para a mudança.
- Antes de concluir alterações de código, execute build, lint, testes unitários e as análises estáticas de qualidade, dependências e segurança que estiverem configuradas e forem aplicáveis ao projeto. Informe quando alguma dessas verificações ainda não estiver configurada.
- Use testes de integração ou ponta a ponta para contratos, persistência, APIs e fluxos críticos, conforme o escopo da mudança.
- Se uma verificação falhar, investigue e corrija quando estiver dentro do escopo; caso contrário, informe claramente a falha e seu impacto. Não considere uma entrega pronta para merge enquanto build, testes, lint, análise estática, dependências ou verificações de segurança configuradas estiverem falhando.
- Nunca exponha segredos, dados pessoais ou informações sensíveis em código, logs, testes, documentação ou respostas.
- Atualize a documentação versionada quando APIs, arquitetura ou comportamento público mudarem.

## Git e entrega
- Use a chave de issue atribuída pelo Jira para identificar cada ticket; não invente nem mantenha uma sequência de números manualmente.
- Use prefixos `feature/`, `fix/` e `chore/`, seguidos pela chave da issue e uma descrição curta, por exemplo: `feature/DEV-123-desc-da-feature`. Para iniciar o desenvolvimento de uma issue, crie a branch a partir da branch padrão do repositório.
  - Ao concluir uma feature, pode criar um commit com mensagem objetiva neste formato, substituindo pela chave e pelo conteúdo reais do ticket:
    ```text
    [DEV-123] - título objetivo do ticket
    * Primeira mudança de impacto
    * Segunda mudança de impacto
    ```
    Cada item iniciado por `*` deve ficar em uma linha separada. Preserve a identidade Git configurada e não inclua coautoria do agente.
- No fluxo de uma issue, o Agent de Product Manager pode criar a branch, fazer push e abrir o PR sem solicitação separada. O Agent de Product Manager pode fazer merge somente depois da aprovação do Code Review e de QA e da aprovação de todas as verificações configuradas. Deploy continua exigindo solicitação explícita.


## Workflow
### Inicialização e coordenação de subagentes
- Ao iniciar uma História, o agente que conduz a execução deve ler a descrição, os critérios de aceitação e as instruções relevantes do projeto.
- Deve haver um único Agent técnico principal, responsável por coordenar a implementação e integrar as contribuições dos demais Agents necessários.
- O agente que conduz a execução inicia somente os Agents necessários ao escopo da História. Backend, Frontend e DBA participam conforme as áreas afetadas; QA e Code Review atuam nas etapas definidas neste workflow.
- Cada Agent recebe uma tarefa delimitada, o contexto necessário, dependências e o resultado esperado. Agents só devem trabalhar em paralelo quando as tarefas forem independentes e não houver conflito de arquivos ou contratos.
- Ao concluir sua parte, cada Agent informa o que fez, quais arquivos alterou, quais verificações executou e se encontrou bloqueios.
- O agente que conduz a execução integra o trabalho e verifica a História completa. As responsabilidades de Jira e Git seguem as regras definidas neste workflow.

- Para cada feature do MVP 1 do CashIn, o Agent de Product Manager cria diretamente no Jira uma issue do tipo `História`, no projeto `DEV`, associa-a ao épico [DEV-6 — CashIn MVP 1](https://titostauffer.atlassian.net/browse/DEV-6) e a deixa em `To Do` (`Tarefas pendentes`). Use a chave atribuída pelo Jira e siga o template configurado na ferramenta, sem manter um template paralelo neste arquivo.
- Como os Agents são papéis do fluxo, e não usuários Jira separados, mantenha as issues atribuídas à conta Jira do usuário. Registre na História o papel do Agent técnico principal.
- Quando uma tarefa técnica precisar de acompanhamento separado, crie uma issue do tipo `Tarefa` e vincule-a à História correspondente.
- Toda transição de status de uma issue Jira deve ser seguida por um comentário na própria issue, registrando o evento, o horário local no formato `DD/MM/AAAA HH:mm (America/Sao_Paulo)` e o contexto pertinente. Não presuma que a transição, o PR ou a revisão criará esse comentário automaticamente. Se a transição funcionar e o comentário falhar, tente novamente somente o comentário; não repita a transição.
- Use mensagens claras conforme o evento:
  - `To Do` → `In Progress`: `Iniciado em [data e horário].`
  - `In Progress` → `In Review`: `Pronto para review em [data e horário]. PR: [URL].`
  - `In Review` → `In Progress` por solicitação do Code Review: `De volta para In Progress em [data e horário]. Motivo: [resumo objetivo dos bloqueios].`
  - `In Review` → `In Progress` por reprovação do QA: `De volta para In Progress em [data e horário]. Motivo: [critério não atendido e evidência].`
  - Aprovação do Code Review: `Code Review aprovado em [data e horário]. [Resumo da revisão ou link para a revisão].`
  - Aprovação do QA: `QA aprovado em [data e horário]. [Critérios validados e resultado].`
  - `In Review` → `Done` após o merge: `Merge concluído em [data e horário]. PR: [URL]. Code Review e QA aprovados.`
- Quando uma História do MVP 1 chegar a `Done`, o Agent de Product Manager deve verificar se há outra História do épico `DEV-6` em `To Do` na sprint ativa. Se houver, deve ler a descrição, os critérios de aceitação, as dependências e o papel técnico principal; iniciar somente a próxima História priorizada pelo Jira, respeitando a ordem do quadro em caso de empate. Antes de iniciá-la, criar sua branch a partir da branch padrão e então movê-la de `To Do` para `In Progress`, registrando o comentário de início conforme a regra acima. Se o contexto, as dependências ou a ordem de prioridade não permitirem identificar com segurança qual ticket iniciar, perguntar ao usuário antes da transição. Não puxe automaticamente tickets de outras sprints ou épicos.
- O workflow de uma entrega deve envolver somente os responsáveis pelas áreas incluídas no escopo:
  - Agent de Product Manager cria a História seguindo o template configurado e cria a branch conforme as regras de Git.
  - Agent de Product Manager indica na História o papel do Agent técnico principal conforme a principal área de implementação. Esse Agent puxa o ticket, movendo-o de `To Do` (`Tarefas pendentes`) para `In Progress` (`Em andamento`) pelas transições disponíveis no Jira, usando a conta Jira do usuário. Em Histórias que envolvam várias áreas, há um único Agent técnico principal; os demais Agents necessários colaboram na mesma História.
  - Agent de DBA prepara e valida migrations quando houver alterações de banco de dados.
  - Agents de Backend e de Frontend implementam somente as partes incluídas no escopo do ticket.
  - Quando a História envolver Backend e Frontend, os dois Agents implementam suas partes e podem trabalhar em paralelo quando as dependências e os contratos permitirem. O Agent técnico principal coordena a integração, mas não substitui os demais responsáveis. A História permanece em `In Progress` até todas as partes do escopo estarem concluídas e integradas. Se o acompanhamento separado for necessário, crie issues do tipo `Tarefa` vinculadas à História.
  - Agent de Product Manager cria o commit, faz push da branch e abre o PR conforme as regras de Git.
  - Depois que o PR estiver aberto, Agent de Product Manager move o ticket de `In Progress` (`Em andamento`) para `In Review` (`Em análise`) pelas transições disponíveis no Jira.
  - Agent de Code Review revisa o PR e registra a aprovação se não encontrar bloqueios ou solicita ajustes com comentários no PR. Deve procurar por:
    - Falhas em segurança.
    - Falta de Qualidade de código.
    - Falta de padrões de projeto.
  - Se a revisão pedir ajustes, o Agent técnico principal move o ticket de volta para `In Progress` (`Em andamento`) e coordena a correção com os demais Agents necessários.
  - Após a aprovação do Code Review, Agent de QA valida a implementação com base nos critérios de aceitação e nas condições de conclusão registradas na História, conforme o template do Jira, e registra o resultado no ticket. A validação de QA ocorre em `In Review` (`Em análise`), pois o quadro atual não possui uma coluna exclusiva para QA.
  - Se QA reprovar a implementação, o Agent técnico principal move o ticket de volta para `In Progress` (`Em andamento`) para correção.
  - Depois da aprovação do Code Review e de QA, Agent de Product Manager faz merge do PR conforme as regras de Git. Após o merge bem-sucedido, move o ticket de `In Review` (`Em análise`) para `Done` (`Concluído`) pelas transições disponíveis no Jira.
