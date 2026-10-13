# Arquitetura multi-tenant

A aplicação é exclusivamente SaaS. Cada usuário autenticado é um tenant pessoal.
O proprietário vem da sessão, do job ou de um token público validado, nunca de
um `user_id` arbitrário enviado pelo navegador.

PostgreSQL é obrigatório. Drizzle define as 31 tabelas em `lib/db/schema.ts`,
as relações e as migrações em `drizzle/`. As tabelas não têm prefixo `saas_`.
SQL parametrizado é usado nas transações, travas, consultas JSONB e operações
atômicas da fila. Não existe modo local, bypass de autenticação ou importador SQLite.

## Isolamento e armazenamento

- Configurações e credenciais ficam cifradas por usuário. Novas contas não herdam
  chaves de IA/ferramentas do ambiente. A chave mestra é obrigatória e compartilhada
  somente pelos serviços web/worker da instalação.
- Fluxos, execuções, bases, fontes, fragmentos, índices e anexos incluem `user_id`
  nas consultas e relações. IDs de outra conta retornam indisponível; FKs compostas
  impedem vínculos cruzados. Subfluxos e memória validam o mesmo proprietário.
- Ausência ou encerramento do contexto de usuário impede acesso mesmo quando
  `DATABASE_URL` não está definida. Os repositórios SQLite e seus fallbacks foram
  removidos; `store.ts` trabalha apenas com o estado cifrado do tenant.
- Configurações são confirmadas antes da resposta numa transação com controle de
  conflito. Erros/cancelamento descartam alterações. Até 1.000 chaves, 4 MiB por
  contexto, 256 KiB por valor e 200 credenciais nomeadas por conta.
- Anexos e seus bytes são transacionais no PostgreSQL. Fontes de conhecimento
  ficam cifradas por usuário/base/recurso. Arquivos de ferramentas e FAISS usam
  diretórios privados com proteção contra caminhos externos e links simbólicos.
  Provedores vetoriais e registros externos usam namespaces por usuário/base/geração.
- Conhecimento tem trava por base, publicação atômica e limpeza com nova tentativa.
  Alterar apenas opções de busca não invalida vetores, inclusive após leitura JSONB.
  O registro interno usa PostgreSQL; `0004_internal-record-manager.sql` atualiza
  seu identificador em bases e índices existentes.
- Credenciais nomeadas não usam mais IDs `default:` nem opções bloqueadas por
  variáveis globais. Servidores MCP precisam de cadastro e identificação explícitos;
  os aliases da primeira versão e a voz herdada do armazenamento local foram removidos.
- A sessão ChatGPT é cifrada em PostgreSQL, com trava entre processos e revogação.
  Arquivos nativos ficam em diretório temporário privado (tmpfs no Docker).
  Detalhes em [CHATGPT-SESSIONS.md](CHATGPT-SESSIONS.md).

## Autenticação, beta e integrações

Cadastro por senha, verificação de e-mail, recuperação e Google usam sessões
revogáveis. Tokens são de uso único e têm expiração; confirmações são consumidas
por POST. Google valida assinatura, audiência, nonce, PKCE e vínculo ao navegador.
Resend usa uma outbox persistida com retentativas e chave de idempotência.

Uma conta só acessa recursos após confirmar o e-mail e obter aprovação ou
resgatar um convite válido. Convites limitam usos atomicamente e mantêm auditoria
por usuário. Suspensão revoga acesso também para jobs já enfileirados.
Um link com `?invite=<código>` em qualquer página guarda o código num cookie
HttpOnly de 24 horas (`agentflows_invite`) e o mantém nos redirecionamentos e
links de entrada/cadastro. Ao chegar em `/acesso` com o e-mail confirmado e a
conta na lista de espera, o convite é resgatado sem outro clique. O cookie é
descartado após o resgate, quando o convite é recusado de forma definitiva e
no logout; continua enquanto falta confirmar o e-mail. Conta já liberada que abre
uma página com `?invite=` é redirecionada para a mesma URL sem o parâmetro.

APIs validam sessão, origem, tamanho do corpo e limites persistidos; respostas
privadas não são armazenadas em cache. O proxy é uma camada adicional, e as
rotas/repositórios fazem a própria validação.

Chat incorporado, webhook de fluxos, MCP público, WhatsApp e ElevenLabs têm
chaves vinculadas ao dono e executam pela fila compartilhada. Eventos de canais
são persistidos e deduplicados antes do retorno HTTP. Envios com resultado incerto
ficam visíveis e não são repetidos automaticamente. Contratos:
[EMBED-TENANTS.md](EMBED-TENANTS.md), [INTEGRATION-TENANTS.md](INTEGRATION-TENANTS.md)
e [CHANNEL-TENANTS.md](CHANNEL-TENANTS.md).

Agente/LLM suportam modalidades de entrada e geração de imagens por Higgsfield e
MuAPI; o LLM aceita modelos abertos da Replicate (`empresa/modelo`) com saída em
texto, imagens ou vídeo. Chaves e resultados pertencem ao usuário; limites e contratos
estão em [MEDIA-PROVIDERS.md](MEDIA-PROVIDERS.md).

## Fila e limites de execução

PostgreSQL mantém a fila durável; Redis transporta notificações contendo IDs.
Perder uma notificação ou reiniciar o Redis não apaga os jobs.

| Limite | Valor |
| --- | --- |
| Tarefas ativas por usuário, somando todos os workers | 1 |
| Tarefas ativas na instalação | 2 |
| Tarefas pendentes/ativas por usuário | 10 |
| Tarefas pendentes/ativas na instalação | 1.000 |
| Validade da autorização de execução | 60 segundos, renovada a cada 10 |
| Duração máxima do job | 15 minutos |

Fluxos, extração e indexação compartilham essas vagas. Enfileirar run/job ou
aprovação/job é atômico. Cancelar revoga a execução imediatamente, mas mantém a
vaga até confirmação do worker ou expiração da autorização. Recuperação marca
a tarefa como interrompida e não repete efeitos externos incertos. Um token antigo
não pode gravar progresso, liberar a vaga ou sobrescrever uma operação substituta.

O Compose Coolify inclui web, worker, PostgreSQL e Redis, com rede privada,
volumes, healthchecks, shutdown e limites de recursos. Migrações usam trava de
deploy para impedir aplicação simultânea. `npm run test:docker` cria projeto e
volumes descartáveis e não usa dados ou segredos reais da aplicação.

## Planos e limites mensais

| Plano | Execuções por mês | Fluxos |
| --- | --- | --- |
| `beta` (padrão) | 1000 (`LIMITE_EXECUCOES_MES`) | 5 (`LIMITE_FLUXOS`) |
| `ai_action` | ilimitadas | ilimitados |

O mês é civil, no horário de Brasília (`usage_months.month` = `AAAA-MM`). Contam
execuções reais criadas pelo chat, MCP, webhook, canais e chat incorporado, no
mesmo bloqueio e transação que enfileira o run; simulações e retomadas após
aprovação não contam. Excluir execuções ou fluxos não devolve o uso do mês.
Contas acima de 5 fluxos antes do limite mantêm seus fluxos, mas só criam
outro depois de ficar abaixo do limite. O erro HTTP 403 traz `code: "plan_limit"`
e `upgradeUrl`, e a interface oferece o AI Action.

## Validação

Em 29/09/2026: **307 testes gerais e 104 testes com PostgreSQL servidor**
aprovados; build/TypeScript aprovados e lint sem erros (um aviso preexistente
de imagem no avatar do chat). Migração do registro interno validada também com
bases/índices preexistentes e reaplicação idempotente. Docker/Compose aprovado
com dois workers, reinício preservando volumes, isolamento A/B e navegador em
desktop/celular, sem credenciais de provedores reais.

As suítes usam usuários e bancos descartáveis, serviços externos simulados e
assinaturas criptográficas reais. A suíte geral limita a quatro arquivos de teste
simultâneos para evitar excesso de instâncias PGlite.

```sh
npm test
npm run lint
npm run build
PG_BIN_DIR=/caminho/postgres/bin npm run test:postgres
REDIS_SERVER=/caminho/redis-server npm run test:redis
npm run test:docker
```

A validação local inclui contas A/B, tentativas de acesso cruzado, aprovação,
credenciais cifradas, recuperação, dois workers, reinício preservando volumes e
navegação desktop/celular. O teste PostgreSQL usa conexões independentes para
validar transações e concorrência além do PostgreSQL embarcado.

Configuração do domínio, autorização real Google, envio real Resend e geração
em contas pagas dependem das credenciais do ambiente de implantação. A execução
local não publica no Coolify nem consome serviços pagos. Backups devem incluir
PostgreSQL, arquivos persistentes e a chave mestra guardada separadamente.

## Administração do beta no PostgreSQL

Aplicar a fundação, num banco de desenvolvimento configurado em `DATABASE_URL`:

```sh
npm run db:migrate
```

Gerar o segredo de cifragem e manter cópia segura fora do volume:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Criar código forte fora do banco e inserir somente seu SHA-256. Exemplos SQL
(substituir o código e o e-mail pelos valores desejados):

```sql
INSERT INTO invites (id, code_hash, label, max_uses, expires_at)
VALUES (gen_random_uuid(), encode(sha256(convert_to('CODIGO-ALEATORIO-LONGO', 'UTF8')), 'hex'),
        'Turma inicial', 20, now() + interval '30 days');

UPDATE users SET beta_status = 'approved', approved_at = now()
WHERE email = 'pessoa@example.com';

-- Suspensão impede acesso mesmo com sessão previamente emitida.
UPDATE users SET beta_status = 'blocked' WHERE email = 'pessoa@example.com';

SELECT i.label, i.uses, i.max_uses, u.email, r.redeemed_at
FROM invites i
LEFT JOIN invite_redemptions r ON r.invite_id = i.id
LEFT JOIN users u ON u.id = r.user_id;

UPDATE invites SET revoked_at = now() WHERE label = 'Turma inicial';

-- Participante do AI Action: execuções e fluxos ilimitados. Voltar com plan = 'beta'.
UPDATE users SET plan = 'ai_action' WHERE email = 'pessoa@example.com';

-- Uso do mês corrente por conta.
SELECT u.email, u.plan, coalesce(m.runs, 0) AS execucoes,
       (SELECT count(*) FROM flows f WHERE f.user_id = u.id) AS fluxos
FROM users u LEFT JOIN usage_months m
  ON m.user_id = u.id AND m.month = to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM');
```

Uma aprovação administrativa não substitui confirmação do e-mail. Códigos são
sensíveis a maiúsculas/minúsculas, com espaços externos removidos no resgate.
Auditoria e contadores são retidos; excluir conta com resgate exige decidir a
política de retenção, em vez de apagar silenciosamente o histórico de uso.

Referências consultadas: [Resend Send Email](https://resend.com/docs/api-reference/emails/send-email)
e [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
