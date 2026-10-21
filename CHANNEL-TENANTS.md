# Canais por usuário

WhatsApp e avisos pós-ligação da ElevenLabs autenticam o dono antes de ler fluxos
ou criar execuções. URLs em Configurações/Implantar têm uma chave individual,
guardada cifrada em `credentials`. O prefixo identifica a conta para verificar o
segredo completo; parâmetros e identificadores de usuário no payload não concedem
acesso. Contas sem verificação, pendentes ou bloqueadas não recebem novos jobs.

## Configuração

- Recadastre as URLs exibidas em Configurações/Implantar: URLs globais antigas não
  são aceitas. Z-API/ZapperHub permitem cadastrar o endereço ao salvar a conexão.
- Meta: informe também **Segredo do aplicativo**. POST exige HMAC SHA-256 do corpo
  original (`X-Hub-Signature-256`), chave da URL e `metadata.phone_number_id`
  correspondente à conta. GET verifica `hub.verify_token` e devolve o desafio.
- Z-API: chave na URL, `instanceId` da conexão e `messageId` da mensagem.
- ZapperHub: chave na URL e identificador `event.Info.ID`; configure eventos em
  JSON. Instâncias personalizadas exigem HTTPS público; DNS é validado e fixado
  na conexão, sem redirecionamentos nem acesso a endereços internos.
- ElevenLabs: recadastre a URL com `?chave=…`, informe o segredo HMAC e o agente.
  A assinatura `ElevenLabs-Signature` valida o corpo original e timestamp
  (tolerância de 30 minutos); `agent_id` precisa coincidir com o configurado.
  `conversation_id` identifica a ligação. Aceitamos `post_call_transcription`.

O contrato de assinatura, identificação da conversa e repetição de eventos está
na [documentação da ElevenLabs](https://elevenlabs.io/docs/eleven-api/resources/webhooks).
A estrutura de pós-ligação está documentada em
[Post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks).
Os provedores foram exercitados com respostas controladas; não foi feita uma
ligação nem enviada uma mensagem real nesta validação.

## Fila e limites

Cada mensagem/ligação válida grava `channel_events`, execução e job na mesma
transação PostgreSQL. Só então HTTP retorna 200; Redis apenas notifica os workers.
Falha de Redis não perde um job aceito. Nenhum fluxo roda em tarefa solta no
servidor HTTP. Todas as mensagens de texto de um lote Meta são consideradas;
se a capacidade acabar no meio, o provedor pode repetir o lote, pois as mensagens
já aceitas são deduplicadas. Configure as tentativas de entrega no provedor.

A identidade deduplicada inclui usuário, canal, conta do provedor, remetente
(quando aplicável) e ID externo. Repetições concorrentes criam uma única execução;
IDs iguais em usuários diferentes não interferem. A deduplicação permanece durante
a vida do fluxo/histórico e sobrevive a reinícios. Excluir o fluxo remove também
seus eventos e recibos. Não remova o histórico enquanto houver retries do provedor.

Limites compartilhados: uma tarefa ativa por usuário, duas globais, dez tarefas
ativas/pendentes por usuário e mil globais. Os canais ainda limitam a 20 novos jobs
por usuário/minuto, 60 requisições autenticadas por usuário/minuto e 180 por IP/minuto
(o proxy deve sobrescrever o cabeçalho configurado em `TRUSTED_CLIENT_IP_HEADER`).
Duplicatas não gastam uma nova vaga nem a cota de criação de jobs. Corpos: 300 KB
no WhatsApp, 1 MiB na ElevenLabs, entrada do fluxo até 20 mil caracteres e até
100 textos por lote. Conteúdo maior é recusado, sem truncar a entrada do fluxo.

## Conversa por remetente

Cada mensagem do WhatsApp entra numa sessão derivada da conta do provedor e do
número de quem escreveu (`whatsapp:<sha-256>`, sem o telefone em claro). Como na
sessão da integração HTTP, as execuções concluídas da mesma sessão viram o
histórico da próxima, e a memória dos blocos LLM/Agente responde no contexto da
conversa daquela pessoa — duas pessoas falando com o mesmo número não se misturam.

O número e o nome do perfil só chegam ao fluxo quando o Início declara as
variáveis `whatsapp_telefone` e/ou `whatsapp_nome` (`{{fluxo.whatsapp_telefone}}`).
Fluxo que não as declara não guarda o telefone na execução.

## Entrega da resposta

`channel_deliveries` pertence ao usuário, job e execução por chaves estrangeiras
compostas. O destinatário e a impressão da conexão ficam cifrados com contexto
do usuário/execução. Ao terminar cada etapa, o worker envia uma resposta textual
(até 4 mil caracteres), conservando a vaga até o pedido ao provedor terminar.
Aprovação humana envia um aviso de análise; a retomada autorizada cria outro job
e envia o resultado final. ElevenLabs apenas enfileira a transcrição.

Antes do envio, o worker revalida seu lease e a conexão atual. Trocar credenciais,
provedor, fluxo, chave ou aceite cancela a resposta pendente. Cancelar uma execução
em espera também cancela a entrega pendente. O sinal de shutdown/cancelamento do
worker chega ao pedido HTTP, com timeout de 20 segundos.

O recibo muda para `sending` **antes** do POST. Um POST é tentado uma vez por job.
Sucesso vira `sent`; timeout/erro ou queda após iniciar o envio vira `uncertain`.
Queda antes do envio vira `cancelled`. Não há replay automático de efeito externo
incerto. O histórico mostra a confirmação do provedor ou orienta conferir a
entrega antes de reenviar; confirmação do provedor não significa leitura pelo
cliente. Um fluxo pode terminar com sucesso e ter a resposta não entregue: os
estados de execução e entrega são distintos.

## Validação

`lib/saas-channels.test.ts` cobre autenticação A/B, IDs cruzados, assinatura, lote
Meta, deduplicação concorrente, fila cheia/retry, aprovação, rotação, cancelamento,
limite durante envio, recuperação de worker, SSRF e vínculos no banco.
`npm run test:postgres` executa essa suíte em PostgreSQL servidor.
`npm run test:docker` valida HTTP e workers separados, persistência dos canais e
repetição após recriar os containers, sem contactar provedores pagos.
