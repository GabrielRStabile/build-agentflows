# Deploy SaaS no Coolify — ambiente de validação

A migração SaaS ainda não está concluída. Consulte `SAAS-PLAN.md` antes de liberar
usuários: integrações públicas e alguns recursos legados ainda precisam ser
migrados e auditados. Este Compose prepara a infraestrutura de homologação.

No Coolify, crie uma aplicação do repositório com Build Pack **Docker Compose**.
Use como Base Directory o diretório que contém este projeto (`/` se for a raiz)
e `/docker-compose.coolify.yml` como localização do Compose. Configure somente
o serviço `app` com domínio, por exemplo `https://fluxos.exemplo.com:10000`.
O sufixo informa a porta interna ao proxy; `APP_URL` deve ser
`https://fluxos.exemplo.com`, sem essa porta.

O Compose cria `app`, `worker`, PostgreSQL 17 e Redis 8. Publica somente o
PostgreSQL no host, na porta `POSTGRES_PORTA_HOST` (padrão 5437, mapeada para a
5432 do container), para administração e backup; Redis e worker não são
publicados. Essa porta fica aberta em todas as interfaces do servidor: libere-a
no firewall apenas para os IPs de administração ou use um túnel SSH
(`ssh -L 5437:127.0.0.1:5437 usuario@servidor`) e conecte com
`postgresql://agentflows:<POSTGRES_PASSWORD>@127.0.0.1:5437/agentflows`.
Os quatro serviços têm limites de memória/CPU e healthchecks. Os limites somam aproximadamente 4,5 GiB de memória; reserve também
memória para o sistema, Coolify e o build. Ajuste após medir sua carga real.

## Variáveis

Defina no ambiente de execução do Coolify:

- `APP_URL`: URL HTTPS pública, sem caminho ou porta interna.
- `CHAVE_MESTRA`: 32 bytes aleatórios em base64, iguais para app e worker.
- `POSTGRES_PASSWORD` e `REDIS_PASSWORD`: senhas diferentes em base64url, sem
  caracteres que exigem escape nas URLs de conexão.
- `RESEND_API_KEY` e `RESEND_FROM`: credencial e remetente no formato
  `Nome <conta@dominio>`. O domínio precisa estar **verificado** na conta do
  Resend (resend.com/domains, registros DNS confirmados); sem isso o Resend
  recusa todo envio com 403 e nenhum e-mail de confirmação sai. O worker
  registra `email_remetente` na partida e `/api/health` mostra `mail.sender`.
- `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`: opcionais; quando configurados,
  autorize o callback exato `APP_URL/api/auth/google/callback` no Google.
- `POSTGRES_PORTA_HOST`: opcional (padrão 5437); porta do host publicada para o
  PostgreSQL do container. Ferramentas externas conectam com o usuário
  `agentflows`, o banco `agentflows` e `POSTGRES_PASSWORD`.

Gere a chave e cada senha separadamente, em ambiente privado:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Cada conta conecta seus provedores na aplicação; a única chave de IA do
ambiente é a credencial compartilhada abaixo, limitada no tempo. Mantenha
`TRUSTED_CLIENT_IP_HEADER` sem valor até validar que o proxy sobrescreve esse
cabeçalho e impede sua falsificação.

### E-mails de confirmação que não chegam

O cadastro grava o e-mail em `mail_outbox` na mesma transação da conta; o
worker envia pelo Resend em lotes de cinco a cada segundo, com até oito
tentativas. Para localizar a falha:

1. `GET /api/health` → `mail`: `configured` (RESEND_API_KEY e RESEND_FROM
   presentes), `sender` (`domain`, `verified` true/false/null e `detail` com o
   motivo), `pending`, `failedLast24h`, `sentLast24h` e `oldestPendingSeconds`.
   `sender.verified: false` é a causa mais comum: o domínio de `RESEND_FROM`
   não está verificado na conta do Resend. Pendentes crescendo sem envio
   indicam worker parado ou sem as variáveis (`workerAlive` precisa ser `true`).
2. Logs do worker: `email_remetente` na partida (domínio e verificação) e, a
   cada tentativa, `{"evento":"email_envio","id":…,"tentativa":…,"status":…,
   "resultado":"enviado|repetir|falhou"}`, sem destinatário nem conteúdo.
   `status` 403 é domínio não verificado: a mensagem fica na fila com as oito
   tentativas normais (cerca de duas horas), então verificar o domínio nesse
   prazo entrega o que está pendente. 422 é remetente ou destinatário
   inválido (falha definitiva); `"rede"` é falha de conexão ou tempo limite
   de 10 s.
3. Painel do Resend › Emails mostra o que chegou à API e o estado da entrega
   (bounce, spam). Com o domínio de teste do Resend (`onboarding@resend.dev`)
   só o e-mail do dono da conta recebe mensagens.
4. Cadastro com e-mail já existente responde igual ao novo, para não revelar
   contas, mas a dona do e-mail recebe: a confirmação de novo (conta ainda não
   confirmada; o link anterior deixa de valer) ou um aviso "Você já tem conta"
   com os caminhos para entrar ou redefinir a senha. Esse envio e o botão
   Reenviar e-mail têm limite de três por e-mail por hora.

A mensagem vai em texto e HTML (logo servida por `APP_URL/brand/agentflows-logo.png`,
botão e o mesmo link em texto); o link fica no fragmento da URL e não aparece
nos logs.

### Credencial compartilhada (free tier)

Opcional. Com `OPENAI_CHAVE_COMPARTILHADA` definida, toda conta que entrou por
convite vê, em Credenciais, no seletor de credencial dos blocos LLM/Agente com
OpenAI, a credencial **StartSe OpenAI API (free tier)** durante as 72 horas
seguintes ao resgate do convite; no provedor de embeddings OpenAI das bases de
conhecimento a mesma chave aparece como **StartSe OpenAI Embedding API**. Bases de conhecimento novas já nascem com o fluxo básico
(embeddings OpenAI com essa credencial, Faiss e registro interno) e podem ser
indexadas sem configurar nada; tudo continua editável. Ela aparece primeiro na lista, é somente
leitura (sem editar nem excluir) e a chave fica apenas no ambiente: nada é
copiado para o banco das contas nem enviado ao navegador.

- `OPENAI_CHAVE_COMPARTILHADA`: chave da OpenAI (sk-…). Em branco, nada é
  oferecido.
- `OPENAI_CHAVE_COMPARTILHADA_NOME`: nome exibido antes de "(free tier)";
  padrão `StartSe OpenAI API`.
- `OPENAI_CHAVE_COMPARTILHADA_NOME_EMBEDDINGS`: nome exibido no provedor de
  embeddings, sem sufixo; padrão `StartSe OpenAI Embedding API`.
- `OPENAI_CHAVE_COMPARTILHADA_HORAS`: duração contada a partir do resgate do
  convite; padrão `72`.

Ao terminar o prazo, a credencial some da lista e os blocos que a escolheram
param com a mensagem "O período gratuito da credencial … terminou em
dd/mm/aaaa, hh:mm. Cadastre sua própria chave da OpenAI no bloco." Contas
liberadas pelo administrador sem convite não a recebem; convites resgatados
antes de a variável existir contam o prazo desde o resgate. Trocar a chave ou
removê-la do ambiente vale na próxima requisição, inclusive para execuções já
enfileiradas. Defina um limite de gasto para essa chave no painel da OpenAI:
a aplicação não mede o consumo por conta.

## Inicialização e operação

App e worker aplicam migrações versionadas, protegidas por uma trava PostgreSQL,
antes de servir requisições ou reivindicar tarefas. A conta inicial segue a
mesma confirmação de e-mail e aprovação do beta das demais. Aprovação e criação
de convites são administrativas; os comandos estão em `SAAS-PLAN.md`.

O worker abre o contexto do proprietário persistido no job. PostgreSQL guarda a
fila, os resultados e as autorizações temporárias; Redis contém apenas avisos
com IDs opacos. Se Redis perder avisos ou ficar indisponível após a inicialização,
o worker continua consultando a fila durável. Não há repetição automática de
uma execução interrompida que possa ter produzido efeitos externos.

Limites configuráveis por ambiente (padrão entre parênteses):
`EXECUCOES_SIMULTANEAS` (6) tarefas simultâneas no total, `FILA_LIMITE_USUARIO`
(100) pendentes/ativas por conta, `FILA_LIMITE_TOTAL` (2000) no total,
`LIMITE_EXECUCAO_SEGUNDOS` (180, entre 30 e 900) de tempo por execução comum
(fluxos com modelo de mídia mantêm 10 minutos) e `POSTGRES_CONEXOES` (10) por
processo. Cada conta executa uma tarefa por vez, porque a sessão ChatGPT abre um
único processo Codex; cada execução simultânea consome cerca de 100 a 200 MB e
cerca de 40 PIDs do worker (lançador Node e binário Codex), então aumente
`WORKER_MEM_LIMIT` e `WORKER_PIDS_LIMIT` junto com `EXECUCOES_SIMULTANEAS`. O
limite de conexões ChatGPT por processo acompanha `EXECUCOES_SIMULTANEAS`. A
autorização do worker expira em 60 segundos, é renovada a cada dez segundos e a
tarefa tem prazo de 15 minutos. O worker também entrega a outbox Resend e remove
registros expirados.

`GET /api/health` devolve, além de `ok` (banco), `queue` com pendentes, vagas em
uso, vagas configuradas, workers com heartbeat recente e a espera mais antiga,
e `workerAlive`. O worker registra em JSON `worker_pronto`, `tarefa_iniciada`
(`esperaMs` na fila) e `tarefa_concluida` (`duracaoMs`, `ok`), sem conteúdo do
usuário, para acompanhar a latência da fila nos logs do Coolify.

## Prática com 150 pessoas

Cenário: 150 contas criam um fluxo, salvam e testam com o Agente ao mesmo tempo,
acompanhando o chat e a fila. Análise feita em 13/10/2026 sobre a versão 0.22.0.

**O que limita a experiência.** O gargalo não é o bloco Início, é a fila: toda
execução espera uma das `EXECUCOES_SIMULTANEAS` vagas globais, e o canvas mostrava
Início "Em execução" enquanto a tarefa só aguardava um worker. Com as 6 vagas
padrão e execuções de ~30 s (uma etapa ChatGPT simples), a capacidade é de
cerca de 12 execuções por minuto: se 150 pessoas clicarem no mesmo minuto, a
última espera perto de 12 minutos. A partir da 0.22.0 o chat e o Início mostram a
posição na fila, mas a capacidade continua sendo a decisão principal.

| Vagas (`EXECUCOES_SIMULTANEAS`) | Capacidade com execuções de ~30 s | Espera máxima com 150 envios simultâneos | Worker: memória / PIDs |
| --- | --- | --- | --- |
| 6 (padrão) | ~12 por minuto | ~12 min | 2 GB / 512 |
| 16 | ~32 por minuto | ~4,5 min | 4 GB / 1024 |
| 24 (recomendado) | ~48 por minuto | ~3 min | 6 GB / 1536 |
| 40 | ~80 por minuto | ~2 min | 9 GB / 2048 |

Na prática os envios se espalham por alguns minutos, então 24 vagas atendem a
turma com esperas de segundos a poucos minutos. Fluxos com ferramentas ou mais de
uma etapa de IA duram mais; estime 60 s por execução e dobre as vagas se o
exercício exigir isso.

**Perfil de ambiente para a prática** (variáveis no Coolify; o Compose usa estes
nomes):

```sh
EXECUCOES_SIMULTANEAS=24
LIMITE_EXECUCAO_SEGUNDOS=180
POSTGRES_CONEXOES=20
WORKER_MEM_LIMIT=6g
WORKER_CPUS=4
WORKER_PIDS_LIMIT=1536
WORKER_STOP_GRACE=210s
APP_MEM_LIMIT=2g
APP_CPUS=3
POSTGRES_MEM_LIMIT=1g
```

Medidas de referência: o processo Codex sobe em ~0,3 s em máquina local (1 a 2 s
em container compartilhado), com ~46 MB de RSS ocioso no binário mais o lançador
Node; cada vaga ocupa ~40 PIDs, por isso `pids_limit` de 256 bloqueava a sexta
ou sétima execução simultânea com "Não foi possível iniciar a conexão ChatGPT".
O host precisa de memória para a soma dos limites mais sistema e Coolify: com o
perfil acima, reserve 10 GB.

**Carga no web e no banco.** O acompanhamento da execução é por push: o
navegador abre um stream de eventos (`GET /api/runs/[id]/events`, Server-Sent
Events) e o servidor envia o estado sempre que o PostgreSQL anuncia uma mudança
(`NOTIFY` no commit de cada gravação da execução e a cada vaga ocupada ou
liberada). Cada processo web mantém uma única conexão `LISTEN`; 150 pessoas
acompanhando são 150 conexões abertas quase ociosas, não 75 requisições por
segundo. Se o stream não abrir em 5 s ou cair, o navegador volta ao polling de
`GET /api/runs/[id]?after=` (204 sem corpo quando nada mudou), e o stream é
reaberto a cada 15 minutos para revalidar a sessão. A espera pelo POST usa o
resumo paginado, reabrir o fluxo busca a conversa em uma requisição e testar sem
alteração não repete o salvamento. O proxy precisa aceitar respostas longas sem
buffering (`X-Accel-Buffering: no`, ping a cada 15 s); o Traefik do Coolify
atende. Mantenha o `app` com 3 CPUs e o PostgreSQL com 1 GB.

**Resposta síncrona do endereço publicado.** `POST /webhook/flows/<id>` segura a
conexão até a execução terminar, por até `LIMITE_EXECUCAO_SEGUNDOS` + 15 s
(195 s no padrão), sem enviar bytes nesse intervalo. O Compose não define
rótulos do Traefik: o Coolify gera a configuração do proxy, e os padrões do
Traefik atendem, pois não há limite para a resposta do serviço
(`responseHeaderTimeout` 0) nem para a escrita (`writeTimeout` 0); o
`idleTimeout` de 180 s vale só para conexões ociosas entre requisições. Se houver
outro proxy ou CDN na frente com limite menor (o Cloudflare corta em 100 s),
reduza o `LIMITE_EXECUCAO_SEGUNDOS` ou peça `?wait=<segundos>` abaixo desse
limite e consulte o resultado com `GET ?runId=` quando vier 202.

**O que sobrevive a um reinício ou deploy.** Nada do estado fica no stream,
no Redis ou na memória do web: a fila, as execuções e as aprovações
pendentes estão no PostgreSQL.

- Execução **na fila** quando o worker reinicia: continua na fila e é
  reivindicada quando ele volta; o chat mostra "aguardando o processador"
  enquanto isso.
- Execução **em andamento** no deploy do worker: o worker drena por
  `LIMITE_EXECUCAO_SEGUNDOS` + 5 s antes de encerrar; o que passar disso termina
  como interrompido, com mensagem, sem repetir ações externas.
- **Envio** durante a indisponibilidade do `app`: o editor repete com o mesmo
  `runId`; a execução não é duplicada.
- **Acompanhamento** (stream) quando o `app` reinicia: o navegador cai para o
  polling, ignora as respostas de erro do proxy e, a cada 30 s, tenta o stream
  de novo; ao voltar, o polling para. Ao reabrir, o stream envia o estado atual
  lido do banco, então nenhum aviso perdido nesse intervalo faz falta.
- **PostgreSQL** reiniciado com app e worker no ar: a conexão `LISTEN` reconecta
  com tentativas a cada 5 s; enquanto isso cada stream relê a execução a cada
  10 s, e o worker retoma a fila sozinho. `npm run test:docker` cobre esse
  cenário e a recriação completa dos containers.
- **Redis** indisponível: o worker volta à consulta durável no PostgreSQL a
  cada segundo; nenhum aviso é necessário para a fila andar.

**Checklist antes da sessão.**

1. Aplique o perfil acima e faça o deploy com antecedência; não faça deploy
   durante a prática (o worker drena por `LIMITE_EXECUCAO_SEGUNDOS` + 5 s e o
   `app` fica indisponível por até 60 s).
2. Confira `GET /api/health`: `ok: true`, `workerAlive: true`, `queue.slots`
   igual ao configurado e `queue.queued` zerado.
3. Peça que cada pessoa conecte o ChatGPT antes do exercício: a conexão é por
   conta, e uma execução sem ChatGPT conectado é recusada na hora (409) com
   mensagem clara, sem entrar na fila.
4. Teste com duas contas: uma execução completa, uma com aprovação e uma
   cancelada, observando `tarefa_iniciada`/`tarefa_concluida` nos logs do worker.
5. Durante a prática acompanhe `queue.queued`, `queue.oldestQueuedSeconds` e
   `queue.workers`. Se `oldestQueuedSeconds` passar de 120 s, aumente as vagas
   (requer redeploy do worker) ou peça para alternarem os testes.
6. Se o worker cair, as execuções permanecem na fila e o chat mostra
   "aguardando o processador"; ao voltar, ele retoma em ordem. Execuções que
   estavam em andamento terminam como interrompidas, sem repetir efeitos.

**O que o participante vê em caso de problema.** Posição na fila e vagas em uso
enquanto espera; "Você é o próximo" quando chega a vez; limite de uso da
assinatura ChatGPT, sessão expirada, rede ou tarefa grande demais explicados em
português com o detalhe original; tempo limite da etapa descrito como tal (não
como cancelamento); e, se a resposta do servidor se perder, o editor repete o
envio sem criar uma segunda execução (identificador escolhido pelo cliente).

Limites do plano beta, por conta: `LIMITE_EXECUCOES_MES` (1000) execuções reais
por mês civil (horário de Brasília) e `LIMITE_FLUXOS` (5) fluxos. Contas com
`plan='ai_action'` não têm esses limites (veja SAAS-PLAN.md). Todas as contas
armazenam até `LIMITE_ARMAZENAMENTO_MB` (50) MB em arquivos das bases de conhecimento.

Fluxos, extração e indexação compartilham a mesma cota por usuário. Ao cancelar
uma tarefa ativa, a vaga fica reservada até o worker confirmar o encerramento
ou a recuperação detectar a autorização expirada; cancelar não permite furar
o limite iniciando outra tarefa enquanto a anterior ainda encerra.

Para executar fora do Compose, use os mesmos `DATABASE_URL`, `REDIS_URL`,
`CHAVE_MESTRA`, `APP_URL` e `DATA_DIR` do web:

```sh
npm run db:migrate
npm run worker
```

Mantenha inicialmente uma réplica do web e uma do worker no mesmo host. A
coordenação da fila foi testada com dois workers, mas conexões ChatGPT e arquivos
locais precisam de validação adicional antes de escalar réplicas. O shutdown tem até
60 segundos para interromper chamadas, finalizar registros e fechar conexões.

## Teste isolado com Docker

`npm run test:docker` compila a imagem e cria um projeto Compose temporário com
credenciais aleatórias e envio de e-mail desativado. Valida API autenticada,
isolamento entre contas, limite da fila, dois workers, Faiss, chat incorporado e
persistência após recriar os containers. Ao terminar, remove somente seus containers e volumes.
Não utiliza o `.env` nem os volumes da aplicação. Docker precisa estar em execução;
se o executável não estiver no PATH, defina `DOCKER_BIN` com seu caminho completo.
`AGENTFLOWS_TEST_IMAGE` permite testar uma imagem já compilada.

O teste de containers passou no Docker Desktop com Linux ARM64. A validação do
host Coolify e das integrações externas continua necessária antes da publicação.
A jornada opcional com Playwright também passou em desktop e celular; veja
[EMBED-TENANTS.md](EMBED-TENANTS.md) para reproduzir.

## Disco do host e imagens antigas

Cada deploy pelo Compose gera uma imagem nova para `app` e outra para `worker`
(mesmo Dockerfile, camadas compartilhadas quando o cache acerta) e mantém as
anteriores até a limpeza do Coolify. O cache de build guarda ainda a camada do
`npm ci` com as ferramentas nativas (cerca de 2 GB), que não entra na imagem final.
Em dias com muitos deploys o disco sobe em "dente de serra" até a limpeza diária.

- No Coolify, em Servers → servidor → Advanced → Docker Cleanup, reduza o intervalo
  (cron, padrão diário à meia-noite UTC) e defina o limiar de uso de disco que dispara
  a limpeza fora do horário. Não existe "manter N builds" por aplicação: a poda vale
  para o servidor inteiro e preserva as imagens dos containers em execução.
- Para aliviar na hora, no host: `docker system df` mostra o uso; `docker image prune
  -af --filter "until=24h"` e `docker builder prune -af --filter "until=24h"` removem
  imagens e cache com mais de 24 horas sem derrubar containers.
- O deploy automático a cada push na `main` multiplica as imagens; com commits pequenos
  e frequentes, prefira disparar o deploy por release.

A imagem final leva o `node_modules` de produção completo porque o worker executa
`lib/*.ts` fora do Next (o rastreamento do standalone cobre só o que o servidor usa).
O Dockerfile apaga o `node_modules` do standalone antes da cópia, para não deixar
uma camada duplicada de cerca de 400 MB por imagem.

## Persistência e recuperação

- `postgres-dados`: contas, sessões, credenciais cifradas, fluxos, anexos,
  conhecimento, convites, sessão ChatGPT cifrada e jobs.
- `dados`: diretórios privados de ferramentas e FAISS,
  compartilhados entre app e worker.
- `redis-dados`: AOF dos avisos da fila. A fila durável permanece no PostgreSQL.

Faça backup consistente do PostgreSQL e do volume de arquivos, com app/worker
parados quando necessário para coordenar arquivos e registros. Guarde a chave
mestra separadamente; sem ela, os segredos cifrados não podem ser recuperados.
Não remova volumes ao atualizar. Trocar a senha no ambiente não altera a senha
de um PostgreSQL já inicializado: uma rotação exige alterar também a conta SQL.

Use um banco vazio para homologação desta fundação Drizzle. A aplicação passa
a ser exclusivamente multi-tenant; não haverá modo SQLite nem importador legado.

## Verificação antes de abrir o beta

Confirme healthchecks, migrações e envio real de confirmação/recuperação; execute
login Google com o domínio final e jornadas com duas contas. Reinicie o worker
durante uma tarefa de teste e confira que ela termina como interrompida sem
repetir efeitos. Valide restauração do backup, cancelamento entre processos e
persistência após redeploy no host final. O build da imagem e a subida do Compose
já passaram no Docker local; o ambiente Coolify e a restauração ainda precisam
ser validados.

Referências: [Docker Compose no Coolify](https://coolify.io/docs/applications/builds/docker-compose)
e [serviços do Compose](https://docs.docker.com/reference/compose-file/services/).

A autenticação ChatGPT usa um cofre cifrado no PostgreSQL e uma cópia temporária
em tmpfs por processo. App e worker montam `/tmp` com limite de 256 MiB; preserve
essa montagem no Coolify. Veja [CHATGPT-SESSIONS.md](CHATGPT-SESSIONS.md) para
atualização, revogação e limites da recuperação após queda.
