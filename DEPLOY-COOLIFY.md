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

O Compose cria `app`, `worker`, PostgreSQL 17 e Redis 8. Não publica portas do
banco, Redis ou worker no host. Os quatro serviços têm limites de memória/CPU e
healthchecks. Os limites somam aproximadamente 4,5 GiB de memória; reserve também
memória para o sistema, Coolify e o build. Ajuste após medir sua carga real.

## Variáveis

Defina no ambiente de execução do Coolify:

- `APP_URL`: URL HTTPS pública, sem caminho ou porta interna.
- `CHAVE_MESTRA`: 32 bytes aleatórios em base64, iguais para app e worker.
- `POSTGRES_PASSWORD` e `REDIS_PASSWORD`: senhas diferentes em base64url, sem
  caracteres que exigem escape nas URLs de conexão.
- `RESEND_API_KEY` e `RESEND_FROM`: credencial e remetente verificado no Resend.
- `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`: opcionais; quando configurados,
  autorize o callback exato `APP_URL/api/auth/google/callback` no Google.

Gere a chave e cada senha separadamente, em ambiente privado:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Não use chaves de IA globais como credenciais dos clientes. Cada conta conecta
seus provedores na aplicação. Mantenha `TRUSTED_CLIENT_IP_HEADER` sem valor até
validar que o proxy sobrescreve esse cabeçalho e impede sua falsificação.

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
(100) pendentes/ativas por conta, `FILA_LIMITE_TOTAL` (2000) no total e
`POSTGRES_CONEXOES` (10) por processo. Cada conta executa uma tarefa por vez,
porque a sessão ChatGPT abre um único processo Codex; cada execução simultânea
consome cerca de 100 a 200 MB do worker, então aumente `mem_limit` junto com
`EXECUCOES_SIMULTANEAS`. A autorização do worker expira em
60 segundos, é renovada a cada dez segundos e a tarefa tem prazo de 15 minutos.
O worker também entrega a outbox Resend e remove registros expirados.

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
