# Build Agentflows — v0.37.0

Versão 0.42.0: o link de confirmação de e-mail confirma ao abrir e leva ao login (ou à tela do convite, se já estiver na conta), sem botão nem reenvio. Versão 0.41.1: o Registro interno do Record Manager volta a ter o ícone do SQLite, distinto do Postgres. Versão 0.41.0: nível da senha (fraca, razoável, boa, forte) em quatro barras ao criar conta, redefinir senha e alterar a senha em Minha conta. Versão 0.40.0: credencial OpenAI compartilhada também nos embeddings das bases de conhecimento, selecionada por padrão, com Faiss e registro interno formando o fluxo básico de bases novas. Versão 0.39.0: tela "Confira seu e-mail" após o cadastro com reenvio por contagem regressiva, e-mails de confirmação em HTML com a logo e diagnóstico da fila de e-mails em /api/health e nos logs do worker. Versão 0.38.0: credencial OpenAI compartilhada pelo ambiente, "StartSe OpenAI API (free tier)", visível por 72 horas às contas que entram por convite (somente leitura, chave apenas no ambiente, sem cópia no banco). Versão 0.37.0: referência a bloco que não executou vale vazio com observação na etapa, e o motor espera e repete a chamada quando o fornecedor informa o tempo do limite de uso (planos gratuitos). Versão 0.36.0: parâmetro "Esforço de raciocínio" nos modelos de raciocínio da OpenAI (o gpt-6-luna usa ferramentas com none, aplicado sozinho pelo Agente) e erros dos fornecedores de API com a explicação devolvida por eles. Versão 0.35.0: sessão de conversa no endereço publicado (campo session, gerado e devolvido quando ausente; reenviado, continua a mesma conversa com o histórico na memória dos blocos). Versão 0.34.0: o endereço publicado responde de forma síncrona com o resultado da execução (202 só ao passar do limite de tempo ou com ?wait=0) e a aba cURL fica mais limpa, com os detalhes da requisição recolhidos. Versão 0.33.0: execução publicada em multipart/form-data (campo input e arquivos em file), auxiliar "Requisição HTTP" na aba cURL com link da API para copiar, seleção de texto visível nos campos com referências e modal da etapa com Instruções/Memória recolhidas e Entrada em turnos. Versão 0.32.0: aba cURL de Implantar com acesso público por padrão (sem chave) e opção "Com autenticação", que libera a geração da chave de acesso. Versão 0.31.3: no modal da etapa, a memória enviada ao modelo fica em um bloco recolhível "Memória" abaixo das Instruções, fora da Entrada. Versão 0.31.2: no primeiro LLM/Agente com Mensagem, o modelo responde à conversa antes de receber a Mensagem (duas interações reais, com a resposta do assistente entre elas na Entrada). Versão 0.31.1: no primeiro LLM/Agente com Mensagem, a conversa vai como mensagem da pessoa (não como dado de contexto) e o modal da etapa mostra as Instruções abertas acima de Entrada/Saída. Versão 0.31.0: Mensagem (opcional) do LLM/Agente enviada como a pergunta seguinte de uma conversa (conversa, resultado anterior, Mensagem), com o papel user indicado no editor; botão Limpar conversa em vermelho; ícones de desfazer e refazer corrigidos. Versão 0.30.0: referência {{currentDateTime}} (data e hora atuais, horário de Brasília) nas opções de {{. Versão 0.29.0: referências nativas em português nos campos ({{Conversa}}, {{Etapa anterior}}, {{Decisão da aprovação}}). Versão 0.28.0: chat de teste mostra o bloco em andamento durante a execução e só a resposta final ao terminar. Versão 0.27.0: referências a blocos mostradas pelo nome nos campos do editor, com o id gravado por baixo. Versão 0.26.0: bloco Repetir sem setas, com destino escolhido pelo nome e mensagem ao atingir o limite; fluxos antigos migrados automaticamente. Versão 0.25.0: "Expandir" no chat de teste abre um modal grande sobre o editor e os diálogos dos blocos não fecham ao soltar uma seleção de texto fora deles. Versão 0.24.0: referências {{…}} coloridas nos campos dos blocos (vermelhas quando não existem no fluxo), abrir um bloco não foca o nome do cabeçalho, aba Integrações abre em cURL e botões "Conhecer o programa" e "Garantir minha vaga" (checkout com cupom) em Minha conta. Versão 0.23.0: diálogo Implantar sem cabeçalho (só o botão de fechar), aba Developer renomeada para cURL e Chave de acesso abaixo do exemplo nas abas cURL e Conector MCP. Versão 0.22.0: preparação para turmas grandes — posição na fila no chat e no Início, acompanhamento leve (204 sem mudanças), envio idempotente com repetição automática, limite de execução configurável, conexões ChatGPT acompanhando a concorrência, erros do provedor explicados e `/api/health` com o estado da fila; veja "Prática com 150 pessoas" em DEPLOY-COOLIFY.md. Versão 0.21.0: PROMPT em modelos de imagem e vídeo no LLM, Replicate como ferramenta do Agente com verificação de modelos multimodais, custo exibido quando o provedor informa e chat mais limpo para mídia. Versão 0.20.0: convite do AI Action com cupom exclusivo em Minha conta e limite de 50 MB em arquivos das bases de conhecimento (até 10 MB por arquivo). Versão 0.19.0: modelos abertos da Replicate no bloco LLM (texto, imagens e vídeo), vídeos de até 10 minutos, mídia com "Abrir em nova aba" no chat, referências sem duplicação e limites do plano beta. Versão 0.18.0: aplicação exclusivamente multi-tenant com PostgreSQL, contas com convite para o beta, fila por usuário com limites configuráveis, novas telas de entrada com logo e animação de conexões, e novo favicon. Versões anteriores incluem acesso à Base de Conhecimento removido da tela Fluxo Agêntico, paginação oculta quando há apenas uma página, badges de referências e ferramentas no chat de teste, múltiplas bases como ferramentas no Agente e LLM, descrição de uso e referências por base, ícones compactos no canvas, modos de limpeza no Record Manager, exclusão de base com confirmação pelo nome, endereço dos embeddings em Opções avançadas, Top K e filtros salvos na base, armazenamento Faiss automático, conexão Postgres por credencial e campos separados, opções de busca/gravação e dimensões/formato dos embeddings OpenAI. Veja a [comparação de recursos e preparação dos serviços](KNOWLEDGE-FLOWISE.md). Consulte o [histórico de versões](CHANGELOG.md). Para publicar no Coolify, consulte [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md) e use `docker-compose.coolify.yml`.

Crie fluxos visuais de agentes de IA, teste cada etapa e publique versões que seus sistemas e assistentes podem executar. Aplicação independente da suíte **IA para Executivos**, inspirada na orquestração explícita de [AgentFlow V2 do Flowise](https://docs.flowiseai.com/using-flowise/agentflowv2).

Na versão 0.8.1: os botões de enviar mensagem e iniciar conversa por voz permanecem visíveis lado a lado, inclusive com o campo vazio. A dica “Enter para enviar” foi removida; os atalhos Enter e Shift+Enter continuam funcionando.

## O que resolve

Um quadro visual conecta os blocos: Início, LLM (Assistente), Agente, Condição, Atualizar estado, Requisição HTTP, Aprovação humana, Repetir e Resposta. Ferramentas, WhatsApp e ligações vivem dentro do Agente e em Implantar (fluxos antigos com os blocos Ferramenta, Enviar WhatsApp e Ligação continuam funcionando). Blocos novos nascem com nome incremental (Agente 0, LLM 1…) e podem ser renomeados no próprio cabeçalho, com Enter ou pelo check; o botão Salvar fica inativo até haver uma mudança, e sair com alterações abre um modal para salvar ou descartar. O agente escolhe ferramentas autorizadas e incorpora seus resultados, em até 12 chamadas por etapa. As conexões determinam o caminho; condições e aprovações possuem saídas Sim/Não. Repetir não tem setas de saída: dentro dele você escolhe pelo nome o bloco para onde voltar, o máximo de passagens e a mensagem entregue quando o limite chega sem concluir (em branco, o resultado anterior).

O campo **Mensagem (opcional)** do LLM e do Agente é enviado ao modelo com o papel `user`, depois das Instruções (`system`), e o editor mostra esse papel ao lado do campo. Com a memória ligada, a etapa chega ao modelo como uma conversa com duas interações: no primeiro bloco (sem resultado anterior), o modelo responde primeiro à conversa do chat e só então recebe a Mensagem como pergunta seguinte, numa segunda chamada com o histórico dessa troca; nos blocos seguintes, a conversa é a pergunta da pessoa, o resultado da etapa anterior faz o papel da primeira resposta e a Mensagem é a pergunta seguinte, em uma única chamada. A Entrada da etapa mostra a transcrição completa (Usuário, Assistente, Usuário) e os tokens somam as duas chamadas. A resposta de abertura (à conversa) entra na memória dos blocos seguintes como resposta desse bloco, junto com a resposta final; a Mensagem em si, que era instrução só para ele, não entra. A memória enviada (resumo e mensagens anteriores) aparece no modal da etapa em um bloco recolhível próprio, "Memória", logo abaixo das Instruções, e não mais dentro da Entrada. OpenRouter, OpenAI e Anthropic recebem esses turnos com seus papéis; o ChatGPT (App Server) só aceita texto da pessoa, então a troca vai como transcrição ("Usuário:"/"Assistente:"). Turnos já citados por referência não se repetem e saem da memória; com memória desligada a Mensagem vai sozinha. Um LLM ou Agente com a mensagem em branco recebe automaticamente a conversa (no primeiro passo) ou o resultado da etapa anterior; `{{input}}` não é obrigatório. Ao digitar `{{` em qualquer campo aparece um autocompletar com a conversa, a etapa anterior, as variáveis e os blocos do fluxo.

O editor segue a experiência do Agentflow V2: blocos compactos coloridos, alça de entrada em barra, saídas em seta que aparecem ao passar o mouse, conexões com gradiente entre as cores dos blocos e botão para removê-las, rótulo do ramo (Sim, Não) junto à origem. Arraste uma saída para outro bloco para conectar; solte no vazio para escolher o próximo bloco já conectado. Cada saída aceita uma conexão e nenhuma conexão volta a um bloco anterior: repetições acontecem pelo bloco Repetir, que mostra o destino escolhido como etiqueta. O botão ✨ abre "O que você quer construir?": o ChatGPT desenha blocos, conexões e instruções a partir de uma descrição, com prévia antes de ir para o quadro. Salvar valida e publica ou atualiza uma única versão, v1, usada pelos testes e pelas integrações configuradas. Não há uma ação separada de publicar. Testes usam o último fluxo salvo pelo chat no canto superior direito, com histórico da sessão, etapas executadas e aprovação em linha. Cada execução guarda entrada, saída, versão, estado e registro de etapas no PostgreSQL, vinculados ao usuário. Aprovações persistem após reinício e aceitam uma única decisão. Execuções que estavam rodando no momento do reinício são marcadas como interrompidas para não repetir ações externas silenciosamente.

Ao selecionar explicitamente a simulação, os fluxos rodam em demonstração: agentes devolvem respostas ilustrativas e nenhuma chamada HTTP ou ferramenta externa é executada. Com um provedor de IA configurado, o chat oculta as sugestões e a opção de simulação e envia execuções reais. `/?exemplo=1` cria um exemplo de triagem quando ainda não há fluxos.

## Detalhes das execuções

Clique em uma etapa no chat ou no histórico de execuções para abrir o modal com status, duração, entrada e saída. Chamadas de ferramentas aparecem desde o início e registram sucesso, falha ou interrupção. Seus argumentos e resultados ficam separados, com JSON formatado quando disponível.

No chat de teste, as referências aparecem em badges por chunk, com o conteúdo completo, documento, base e origem em um modal. Os trechos são preservados na execução a partir desta versão, respeitando a opção de referências de cada base; execuções anteriores mantêm as referências em texto. As ferramentas efetivamente chamadas também ganham badges, que abrem entrada, saída, duração e status. O histórico e os canais externos mantêm sua apresentação atual.

Etapas de Agente e LLM registram tokens de entrada, saída, cache e raciocínio quando informados pelo ChatGPT ou OpenRouter. O total agrega as chamadas da etapa, incluindo resumos de memória, sem duplicar notificações cumulativas. Cache e raciocínio são detalhamentos do total, não custos adicionais. Dados incompletos recebem indicação de consumo parcial; execuções antigas ou provedores sem telemetria mostram “Não informado”. O consumo das chamadas do modelo que usam ferramentas pertence à etapa do agente. O registro de entrada do agente não copia o conteúdo dos anexos nem o contexto da página; indica quando esses dados foram enviados separadamente.

Respostas no chat e no histórico, além dos textos no modal, aceitam Markdown com títulos, listas, links, tabelas e código. HTML não é executado; imagens em Markdown aparecem como links.

## Memória dos agentes

Os blocos **Agente** e **LLM** têm a chave **Ativar memória** e o seletor **Tipo de memória**, abaixo de **Instruções**, com as cores dos temas claro e escuro do projeto. O padrão, inclusive em blocos antigos sem configuração, é memória ativada com **Todas as mensagens**: recebe as interações anteriores fornecidas pela conversa, a entrada atual e as respostas dos agentes já executados. Cada bloco escolhe sua própria memória:

- **Todas as mensagens**: inclui todo esse histórico disponível, sem o antigo recorte de seis interações ou truncamento das perguntas e respostas.
- **Últimas mensagens**: inclui as últimas N mensagens anteriores (padrão 20), além da mensagem desta etapa. N conta mensagens individuais, não pares de pergunta e resposta.
- **Resumo da conversa**: faz uma chamada adicional ao modelo do bloco, sem ferramentas, para resumir o histórico antes de responder.
- **Resumo e mensagens recentes**: resume as mensagens antigas quando o histórico ultrapassa um limite aproximado (padrão 2.000 tokens, estimados por caracteres) e preserva as recentes. Esse limite é um gatilho para resumir o histórico, não um teto do prompt inteiro.

Desligar **Ativar memória** oculta as opções e preserva o tipo e os limites escolhidos para quando for reativada. Sem memória, o bloco não inclui histórico automaticamente; mantém instruções, mensagem da etapa, referências explícitas e anexos.

A mensagem da etapa é o campo **Mensagem**, ou a saída anterior quando ele fica em branco. O histórico usa as respostas concluídas dos agentes, preserva as passagens de loops e não inclui as chamadas internas de ferramentas. Entre interações, o chat reutiliza perguntas e respostas finais; etapas internas de execuções antigas não são reinseridas. A memória não cria persistência adicional das variáveis do fluxo. Chamadas externas precisam fornecer o histórico aceito pela rota; uma execução isolada começa sem interações anteriores. O chat incorporado mantém seu limite de 100 interações por sessão; o validador de histórico aceita até 1.000 interações, sem corte silencioso.

## Configurações

A tela **Configurações** reúne o que os agentes podem usar:

- **ChatGPT** (principal): assinatura conectada por código de dispositivo pelo Codex App Server oficial, fixado em @openai/codex 0.155.1. O cartão mostra o percentual disponível e a próxima renovação de cada janela retornada por `account/rateLimits/read`. Atualiza a cada minuto e pelo botão Atualizar. São limites do uso pelo Codex, compartilhados com outras sessões da conta; ausência ou falha da consulta nunca aparece como saldo zero.
- **OpenRouter**: conexão em um clique (OAuth PKCE) com mais de 500 modelos de 80 provedores, mais a opção "Automático · OpenRouter" (o OpenRouter escolhe o modelo). O modelo é escolhido bloco a bloco; um bloco em "Automático · ChatGPT" nunca cai para o OpenRouter, e vice-versa. O gerador de fluxos usa o OpenRouter só quando o ChatGPT não está conectado.
- **Ferramentas no Agente** (catálogo no espírito do Flowise): busca na web (Tavily, SearchApi, Exa, Serper, SerpApi, Brave, Google Custom Search, SearXNG), conhecimento (arXiv, Wolfram Alpha), web e dados (ler página, requisição HTTP sem endereços internos, extrair JSON), utilidades (data e hora, calculadora) e fluxos (executar outro fluxo publicado). WhatsApp e ligações não são ferramentas do Agente: entram no fluxo completo por Implantar. As que precisam de chave pedem a credencial ali mesmo, uma vez para todos os fluxos. Servidores MCP nomeados são gerenciados dentro do Agente: adicionar, editar, autorizar, testar e remover. As ferramentas saíram da tela Configurações.
- **WhatsApp**: Z-API (QR Code), Meta oficial ou ZapperHub, conectados em Configurações. Z-API e ZapperHub exigem aceite dos termos com a marca StartSe, registrado por provedor, versão e data; a API recusa a gravação sem aceite e conexões antigas precisam aceitar antes de enviar ou processar mensagens. Meta oficial não exige esse aceite. Cada fluxo é vinculado ao número em **Implantar › WhatsApp**: mensagens recebidas em `/webhook/whatsapp?chave=…` executam o fluxo vinculado e a resposta volta pelo mesmo número; o endereço de avisos é cadastrado no provedor ao salvar (na Meta é colado no painel, com a mesma chave como valor de verificação).
- **ElevenLabs**: só a chave em Configurações. No chat de teste: ditado e conversa contínua por voz; a voz é escolhida nas configurações do fluxo, pelo título no cabeçalho. Ligações por voz ficam em **Implantar › Ligações**: agente de conversa, número, segredo do aviso, vínculo do fluxo que recebe a transcrição (aviso assinado em `/webhook/elevenlabs`) e "Ligar agora" para prospecção ativa.

## Base de Conhecimento

A tela inicial e o menu dão acesso à jornada de fontes, extração, revisão de fragmentos, Embeddings, Vector Store, Record Manager e teste de busca. Agente e LLM aceitam até 10 bases, em cards no padrão de Ferramentas. Cada card define a descrição de uso, as referências e ajustes de busca. O modelo recebe uma ferramenta por base e consulta as que considerar relevantes; os documentos só são recuperados quando a ferramenta é chamada. Os detalhes da etapa mostram as bases oferecidas e cada consulta aparece no histórico com entrada, saída, tempo e status. Veja [a configuração, os 20 extratores e os limites](KNOWLEDGE.md).

## Stack

Geração de mídia com chaves próprias: no bloco LLM, qualquer modelo da Replicate
informado como `empresa/modelo` (texto, imagens ou vídeo, conforme o modelo); em
Agente/LLM, Higgsfield e MuAPI para imagens. Entradas aceitas, resultados privados
e limitações de cancelamento estão em [MEDIA-PROVIDERS.md](MEDIA-PROVIDERS.md).

Next.js 16, React 19, TypeScript, Tailwind 4, React Flow, Drizzle e PostgreSQL. Cada usuário tem seu contexto privado; Redis notifica o worker sobre tarefas da fila persistida no PostgreSQL. Não há modo de conta única nem armazenamento SQLite. A arquitetura e a validação estão em [SAAS-PLAN.md](SAAS-PLAN.md). A IA principal usa login ChatGPT pelo Codex App Server oficial; o OpenRouter é configurado por usuário.

## Rodar localmente

```sh
npm ci
npm run dev
```

Use Node 24 e configure as variáveis de `.env.example`, com PostgreSQL e Redis disponíveis. Execute `npm run worker` em outro processo com o mesmo ambiente. O cadastro exige confirmação de e-mail e aprovação do beta ou convite; não existe conta administrativa automática. Clique em **Conectar ChatGPT**, copie o código e conclua o login no endereço oficial da OpenAI. A conta precisa ter acesso ao Codex e autenticação por dispositivo habilitada.

```sh
npm test
npm run lint
npm run build
```

## Rodar com Docker

Configure `.env` com `APP_URL=http://localhost:3019`, chave mestra, senhas do
PostgreSQL/Redis e Resend, conforme [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md).

Plano beta: até 1000 execuções reais por mês e 5 fluxos por conta
(`LIMITE_EXECUCOES_MES`, `LIMITE_FLUXOS`). Ao atingir um limite, a interface
convida a fazer parte do AI Action (https://pages.startse.com/ai-action), plano
sem esses limites liberado pelo administrador. **Minha conta** (`/minha-conta`,
no menu do nome de usuário) mostra nome, e-mail, uso do mês e permite alterar
a senha em contas com senha; contas só com Google não têm senha.

```sh
docker compose up --build
```

Abra `http://localhost:3019`. O Compose local usa os mesmos quatro serviços do
Coolify. Os volumes `dados`, `postgres-dados` e `redis-dados` preservam os arquivos,
banco e notificações. Guarde a `CHAVE_MESTRA` do ambiente junto aos backups;
sem ela as credenciais cifradas não podem ser recuperadas.

## Deploy e integrações

O deploy atual usa Docker Compose no Coolify, com PostgreSQL, Redis e worker.
Siga [DEPLOY-COOLIFY.md](DEPLOY-COOLIFY.md); o fluxo antigo de publicação da suíte
no Render não se aplica a este repositório.

As APIs privadas `/api/flows` e `/api/runs` exigem sessão de uma conta verificada
com acesso ao beta. Criar uma execução retorna HTTP 202; o worker processa a fila
e a interface consulta o progresso. Fluxos, extração e indexação compartilham
uma vaga por usuário; o total simultâneo, o tamanho da fila e o tempo por
execução são configuráveis (`EXECUCOES_SIMULTANEAS`, `FILA_LIMITE_USUARIO`,
`FILA_LIMITE_TOTAL`, `LIMITE_EXECUCAO_SEGUNDOS`; veja DEPLOY-COOLIFY.md).
Enquanto espera na fila, `GET /api/runs/[id]` inclui `queue` (posição, vagas e
workers ativos); com `?after=<updatedAt>` responde 204 quando nada mudou.
`GET /api/runs/[id]/events` acompanha a execução por Server-Sent Events
(eventos `run`, `end` e `error`), alimentado por LISTEN/NOTIFY do PostgreSQL; o
editor usa o stream e volta ao polling quando ele não está disponível. O POST
de execução aceita `runId` (UUID v4) como chave de idempotência.

O chat incorporado usa tickets vinculados ao proprietário e à conversa, anexos
privados e a mesma fila dos fluxos. Veja [EMBED-TENANTS.md](EMBED-TENANTS.md).
MCP e o webhook de fluxos também usam chave privada da conta e a fila compartilhada;
o POST HTTP retorna 202 e o resultado é consultado pelo identificador da execução.
Veja [INTEGRATION-TENANTS.md](INTEGRATION-TENANTS.md).

WhatsApp e ElevenLabs também usam chaves por usuário, eventos deduplicados e
a fila compartilhada. Recadastre as URLs exibidas em Configurações/Implantar;
a Meta exige o segredo do aplicativo para validar os avisos. Respostas pelo
WhatsApp são enviadas pelo worker e têm recibo no histórico, sem repetição
automática de envios incertos. Veja [CHANNEL-TENANTS.md](CHANNEL-TENANTS.md).
Os webhooks de WhatsApp e ElevenLabs ainda estão em migração. Não habilite esses
canais em produção até concluir as pendências de
[SAAS-PLAN.md](SAAS-PLAN.md). Os módulos herdados de formulários públicos,
rotinas e histórico genérico de resultados foram removidos por não terem
consumidores neste produto. A tela Execuções continua disponível por usuário.

### Dados entre blocos

- `{{input}}`: entrada original. Nos campos do editor aparece como `{{Conversa}}`.
- `{{last}}`: saída da última etapa. Nos campos do editor aparece como `{{Etapa anterior}}`; `{{state.approval}}` aparece como `{{Decisão da aprovação}}`. As chaves em inglês continuam valendo no motor, em arquivos importados e no gerador, e podem ser digitadas à mão.
- `{{nodes.identificador}}`: saída mais recente daquele bloco. Nos campos do editor essa referência aparece pelo nome do bloco (`{{Analista}}`); o id continua gravado no fluxo, então renomear o bloco não quebra nada e nomes repetidos mantêm cada id por posição.
- `{{state.nome}}`: variável compartilhada; Inicialização aceita um objeto JSON com valores de texto.
- `{{currentDateTime}}`: data e hora atuais no horário de Brasília (ex.: "terça-feira, 13 de outubro de 2026 às 15:36 (horário de Brasília)"), resolvidas na hora da execução. Nos campos do editor aparece como `{{Data e hora atual}}`.

Referências ausentes interrompem a execução com diagnóstico. Após aprovação, `state.approval` contém `yes` ou `no`; para reutilizar o texto anterior, referencie o bloco que o produziu. Argumentos de ferramentas precisam resultar em JSON válido após interpolação.

HTTP usa um endereço fixo definido pelo autor do fluxo, sem interpolação a
partir da entrada. Não insira segredos em instruções, endereços, corpos ou
arquivos exportados. A revisão dos acessos a serviços internos ainda está
pendente antes da abertura do beta.

## ChatGPT e persistência

A conexão usa [Codex App Server](https://developers.openai.com/codex/app-server)
e autenticação por código de dispositivo. Cada usuário tem sua própria conexão;
o processo não herda credenciais da máquina. Sem conexão, a execução real é
recusada. Somente as ferramentas selecionadas no bloco são oferecidas ao agente.

PostgreSQL persiste contas, configurações cifradas, credenciais, fluxos, execuções
e conhecimento por usuário. Arquivos locais usam `DATA_DIR/users/<user_id>`.
A sessão ChatGPT fica cifrada no PostgreSQL, com trava compartilhada entre app e
worker. O arquivo nativo só existe em uma área temporária privada, em memória no
Docker, e é removido ao encerrar a operação. Veja [CHATGPT-SESSIONS.md](CHATGPT-SESSIONS.md).

As variáveis atuais estão em `.env.example`. PostgreSQL e `CHAVE_MESTRA` são
obrigatórios; credenciais de IA e ferramentas pertencem a cada usuário e não
são herdadas de chaves globais do ambiente. Não existe bypass de autenticação
para desenvolvimento ou capturas.

## Recorte em relação ao Flowise

Implementação própria simplificada, sem copiar código do Flowise. Não é um fork nem importa arquivos nativos do Flowise: importação/exportação usa `build-agentflows/v1`. Não inclui Chatflows, Agentflows v1, marketplace, código arbitrário no servidor do app, iteração de listas, execução paralela ou memória entre conversas. Cada execução tem estado próprio e percorre um caminho por vez. O limite é 60 blocos, 120 conexões, 150 etapas e 20 passagens por bloco de repetição. Operações externas já iniciadas podem concluir mesmo se a execução for cancelada; o cancelamento impede novos blocos.

## Estrutura

- `components/FlowEditor.tsx`: quadro, paleta, cabeçalho e histórico.
- `components/flow/`: bloco (`AgentNode`), conexão (`AgentEdge`) e linha de conexão no estilo Agentflow V2.
- `components/NodeDialog.tsx`: edição do bloco, com referências e ferramentas por clique.
- `components/ChatPopup.tsx`: chat de teste em popover; "Expandir" o transforma em modal grande (mesmo componente, cabeçalho próprio).
- `components/GeneratorDialog.tsx`: gerador de fluxos por IA.
- `components/IntegrationDialog.tsx`: publicação e opções de implantação.
- `components/RunView.tsx`: resultado, etapas e aprovação (página de execução).
- `lib/flow-types.ts`: blocos, grafo e contratos.
- `lib/flow-graph.ts`: saídas por tipo, validação de conexão e layout automático.
- `lib/flow-generator.ts`: geração de fluxo pelo ChatGPT (ou OpenRouter) e validação da resposta.
- `lib/conexoes.ts`, `components/Connections.tsx`, `app/api/conexoes/`: tela e rotas de Configurações.
- `lib/openrouter.ts`: execução pelo OpenRouter com ferramentas.
- `lib/tools.ts`: ferramentas prontas e catálogo dos servidores MCP.
- `lib/whatsapp.ts`, `app/webhook/whatsapp/`: canal WhatsApp.
- `lib/elevenlabs.ts`, `app/webhook/elevenlabs/`, `app/api/voz/`: voz e ligações.
- `components/ReferenceField.tsx`: autocompletar de referências com `{{`.
- `lib/flow-store.ts`: validação, versões, persistência e checkpoints.
- `lib/flow-runtime.ts`: motor, IA, ferramentas e HTTP.
- `lib/ferramentas.ts`: ferramentas expostas pelo MCP.
- `app/webhook/flows/[id]`: execução publicada, síncrona (lib/integration-wait.ts espera a conclusão por LISTEN ou consulta; `?wait=` em segundos). Sem `Authorization`, responde só a fluxos publicados com acesso HTTP público (padrão); com `Bearer`, usa a chave da conta. `lib/http-access.ts` guarda a escolha por fluxo (`GET/PUT /api/flows/[id]/acesso`).
- `lib/flow-runtime.test.ts`: testes de comportamento com serviços simulados.

## Implantar: acesso HTTP (aba cURL)

A aba traz o bloco **Requisição HTTP**: o endereço da API com "Copiar link", o método, o tipo de envio e os campos aceitos. O envio é `multipart/form-data` com o campo `input` (texto, obrigatório, até 20 mil caracteres) e, opcionalmente, até cinco arquivos no campo `file` (10 MB cada, 20 MB no total; PNG, JPG, WebP, PDF, TXT, MD, CSV e JSON), que viram anexos da execução e exigem um bloco de IA no fluxo. JSON `{"input"}` continua aceito pelas integrações existentes. Os exemplos em cURL, JavaScript e Python já saem em multipart. A resposta é síncrona: o POST espera a execução terminar e devolve `200` com `id`, `status` (completed, failed ou waiting, quando há aprovação pendente) e `output`; se a execução passar do limite de tempo (LIMITE_EXECUCAO_SEGUNDOS mais 15 s), volta `202` com `queued`/running e o resultado pode ser consultado com `GET ?runId=`. `?wait=0` (ou um número de segundos) encurta a espera. O Conector MCP continua assíncrono, com consultar_execucao. O campo opcional `session` (até 100 caracteres) identifica a conversa: sem ele, o servidor gera um id e o devolve em `session`; reenviado nas próximas chamadas, a execução recebe as interações concluídas anteriores dessa sessão (as 50 mais recentes) como histórico, e os blocos com memória ligada as usam. Sem o campo, cada chamada segue sendo uma conversa nova, como antes. O executar_fluxo do MCP aceita o mesmo campo. Na aba, o endereço com "Copiar link" fica visível e os demais detalhes da requisição ficam num bloco recolhível.

Em Implantar › Integrações › cURL, o seletor **Acesso** define como o endereço `/webhook/flows/<id>` responde. **Público** é o padrão: qualquer sistema com o endereço executa o fluxo publicado e consulta o resultado, sem chave, e os exemplos (cURL, JavaScript, Python) saem sem o cabeçalho `Authorization`. **Com autenticação** exige a chave de acesso da conta; só nesse modo a seção **Chave de acesso** (gerar, copiar, revogar) aparece na aba cURL. O Conector MCP sempre usa a chave. A escolha é salva por fluxo na conta; fluxos não publicados não respondem ao público, e as chamadas públicas têm os mesmos limites por endereço e por conta das chamadas com chave. Como o modo público permite executar o fluxo a quem tiver o endereço, prefira o modo com autenticação para fluxos com ferramentas ou custos sensíveis.

## Referência visual e validação

A experiência foi estudada diretamente no [Flowise Agentflows v2](https://github.com/FlowiseAI/Flowise/tree/9291856d1ea4a4ceea9f8fef8ce14f4f6c81e8eb/packages/ui/src/views/agentflowsv2): biblioteca em grade/lista, editor em tela inteira, blocos compactos com as mesmas cores, alças e conexões com gradiente, paleta flutuante com gerador por IA, diálogo de edição, minimapa, chat em popover e diálogo de implantação com abas. O canvas usa `@xyflow/react` (sucessor do `reactflow` do Flowise); o MUI não entra porque a suíte não usa bibliotecas de UI, e o visual é reproduzido em CSS próprio. Os componentes são próprios; não é uma reprodução integral do Flowise. O plano e o diagnóstico estão em `PLANO.md`.

Os testes cobrem 45 comportamentos: motor, protocolo ChatGPT com subprocesso simulado, regras de conexão e layout do grafo, gerador de fluxos, OpenRouter com ferramentas, conexões, catálogo de ferramentas, WhatsApp (três provedores e aviso recebido) e ElevenLabs (fala, transcrição, ligação e aviso assinado), todos com serviços simulados. O binário oficial foi validado até a leitura de conta sem autenticação. Execução real com assinatura exige conectar uma conta e não é coberta por esses testes automatizados.

## Ferramentas e credenciais (0.5.0)

O seletor do agente oferece apenas estas 19 ferramentas, em ordem alfabética e com ícones locais: Agent as a Tool, Arxiv, Brave Search MCP, BraveSearch, Browserless MCP, Calculator, Code Interpreter by E2B, Composio, CurrentDateTime, Custom MCP, Exa AI, Github MCP, Microsoft Teams, OpenAPI Toolkit, Postgres MCP, Search API, Tavily API, Web Scraper Tool e WolframAlpha. Integrações anteriores permanecem executáveis para preservar fluxos salvos.

**Adicionar ferramenta** cria uma linha com busca digitando no próprio seletor. **Parâmetros** reúne apenas as configurações da ferramenta escolhida: credencial, fluxo publicado (Agent as a Tool), fuso horário (CurrentDateTime) ou ações permitidas (MCP, Composio e OpenAPI). A credencial existente pode ser editada pelo ícone ao lado do seletor. **Criar nova credencial** abre um formulário com nome e campos do serviço; segredos salvos não são reapresentados. Feche o bloco e salve o fluxo para persistir as alterações.

O ChatGPT mantém o host de ferramentas habilitado para despachar funções próprias e MCP, com terminal e execução livre de código desativados. Quando o agente tem ferramentas configuradas, a busca nativa fica desativada para que a integração escolhida seja usada. Agentes e blocos LLM sem ferramentas ou bases configuradas mantêm a busca nativa. Cada chamada configurada é registrada antes de iniciar e atualizada com resultado, duração e estado (`running`, `completed` ou `failed`), incluindo falhas devolvidas ao modelo. O chat e os detalhes da execução exibem esses estados.

Nos conjuntos de ferramentas novos, nenhuma ação fica autorizada antes da seleção. Atualize as ações após conectar a credencial e marque as que o agente pode usar. Agent as a Tool fixa o fluxo escolhido, sem permitir ao modelo substituir o destino; encadeamentos têm limite de cinco chamadas aninhadas. A Composio permite selecionar aplicativo, conta conectada e ações; as chamadas usam a API v3 com a versão retornada na definição da ação.

Brave Search MCP e Postgres MCP executam servidores locais instalados como dependências, com credenciais isoladas e encerramento da sessão após cada consulta/chamada. Github MCP e Browserless usam os endpoints oficiais remotos. Custom MCP conecta servidores HTTP/SSE por URL e token opcional. O build standalone inclui os pacotes dos servidores locais. Os ícones vieram da referência Flowise; veja `public/tool-icons/NOTICE.md`.

Em **Credenciais**, é possível buscar, criar, editar e excluir conexões. Há várias contas por serviço, e cada cartão guarda apenas o ID da conta escolhida. Credenciais nomeadas ficam cifradas no PostgreSQL e vinculadas ao usuário; respostas de API, navegador e exportação do fluxo não recebem os segredos. Deixar uma chave em branco ao editar preserva o valor salvo. A execução usa a conta selecionada em um contexto assíncrono isolado, inclusive na renovação OAuth, sem alterar a conexão global nem herdar campos faltantes de outras contas. A exclusão é recusada enquanto a credencial está referenciada por um fluxo salvo, uma execução em andamento ou uma base de conhecimento. Chaves de embedding existentes são migradas automaticamente; a base guarda o ID da conexão e a execução resolve a chave cifrada atual. Se o endereço de uma conexão mudar, selecione-a novamente na base e reindexe.

Com `OPENAI_CHAVE_COMPARTILHADA` no ambiente, as contas que entraram por convite veem a credencial **StartSe OpenAI API (free tier)** (nos embeddings, **StartSe OpenAI Embedding API**) por 72 horas após o resgate (lib/shared-credential.ts): primeira da lista, somente leitura, com a data de fim exibida; a chave é lida do ambiente na hora da chamada e nunca copiada para o banco nem enviada ao navegador. Ao terminar o prazo ela some e os blocos que a escolheram param com a data do fim. Veja "Credencial compartilhada" em DEPLOY-COOLIFY.md.

As configurações anteriores continuam disponíveis como **Conexão padrão existente**. Fluxos sem seleção explícita mantêm esse acesso. Conexões vindas do ambiente ficam protegidas contra edição e remoção pela tela; é possível cadastrar uma nova credencial independente. Remover uma ferramenta do agente não exclui sua credencial.

| Serviço | Configuração e comportamento |
| --- | --- |
| Buscadores | Chaves dos respectivos provedores; Google Custom Search também pede `cx`; SearXNG pede a URL da instância com JSON habilitado. |
| Google Workspace | Token OAuth com os escopos das ações desejadas: `gmail.readonly`/`gmail.send`, `calendar`, `drive.readonly`, `spreadsheets`. Para renovação automática, informe também refresh token, client ID e client secret. Sem renovação, atualize o token quando expirar. Gmail lista/lê/envia; Calendar lista/cria/atualiza; Drive lista/lê texto/exporta documentos como texto; Sheets lê/atualiza/adiciona linhas. |
| Microsoft 365 | Token OAuth delegado: `Mail.Read`/`Mail.Send` para Outlook; `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` e `ChannelMessage.Send` para Teams. Renovação opcional com refresh token (`offline_access`), aplicativo e diretório. As permissões podem exigir consentimento do administrador. |
| Browserless MCP | Token do Browserless, servidor oficial `https://mcp.browserless.io/mcp`. Resolve as ferramentas publicadas pelo servidor antes da execução. |
| Slack MCP | Token OAuth de um aplicativo habilitado para o MCP oficial `https://mcp.slack.com/mcp`. Não usa bot token legado. |
| E2B | Chave E2B; Python ou JavaScript executam em sandbox remoto criado por chamada, encerrado em `finally`, com duração máxima de 60 segundos. Credenciais do aplicativo não entram no sandbox. |
| OpenAPI Toolkit | URL pública de uma especificação OpenAPI 3 em JSON e Bearer opcional. Expande operações GET/POST/PUT/PATCH/DELETE, parâmetros de caminho/consulta e corpo JSON. Aceita referências locais; YAML e referências externas/circulares não são suportados. |
| Read File / Write File | Texto de até 1 MB em `DATA_DIR/tool-files`, compartilhado entre agentes. Caminhos relativos; traversal e links simbólicos recusados. Não acessa banco, sessão ChatGPT nem arquivos do projeto. |
| Request Get / Request Post | GET e POST JSON para endereços públicos, sem redirecionamento. |
| Web Browser | Extrai o texto HTML de páginas públicas para análise do agente; páginas que exigem JavaScript usam Browserless MCP. |

Browserless, Slack e OpenAPI são conjuntos de ferramentas: selecioná-los disponibiliza suas operações ao agente. Os servidores MCP personalizados continuam permitindo selecionar cada ferramenta individualmente. Nenhuma credencial é copiada para o grafo.

Validação da versão: testes de protocolo e contratos HTTP/MCP com respostas controladas, testes do motor com dois agentes usando a mesma ferramenta, isolamento de arquivos, aceite, lint, build e navegação Playwright em desktop/celular. Não foram usados tokens reais de serviços pagos. O comportamento externo depende das permissões e disponibilidade de cada conta.

Referências: [limites pelo Codex App Server](https://learn.chatgpt.com/docs/app-server), [Gmail](https://developers.google.com/workspace/gmail/api/reference/rest), [Google Calendar](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Microsoft Teams](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0), além dos adaptadores locais do Flowise.

## Cartões de ferramentas e servidores (0.6.0)

- **Adicionar ferramenta** cria um cartão com seletor pesquisável, ícone e parâmetros recolhidos. A mesma credencial pode ser reutilizada por outros agentes; os segredos nunca são devolvidos ao navegador.
- **Conectar serviço por MCP** cria outro cartão. Escolha uma conexão existente ou **Cadastrar novo servidor…** e informe nome, endereço e código de acesso, ou autorize a conta após salvar. É possível adicionar vários servidores ao mesmo agente.
- Cada servidor apresenta suas próprias ações com descrição, busca, seleção individual, **Selecionar todas**, **Desmarcar todas** e **Atualizar ações**. A consulta e os erros são independentes por servidor. Adicionar ou trocar a conexão não autoriza ações automaticamente.
- A lixeira retira o cartão e suas permissões apenas deste agente. **Editar conexão › Excluir conexão compartilhada** exige confirmação porque afeta todos os agentes que usam aquele servidor.
- As seleções sobrevivem ao fechamento e à reabertura do fluxo, inclusive servidores adicionados sem nenhuma ação autorizada. Se um serviço estiver fora do ar ou uma ação desaparecer, a seleção anterior continua visível como indisponível até ser removida explicitamente.
- Fluxos anteriores continuam compatíveis: `config.tools` mantém as permissões usadas pelo motor. `config.toolCards` contém identificadores, organização dos cartões e o ID da credencial escolhida, sem segredos. Depois de fechar o bloco, use **Salvar** no editor para persistir o fluxo.

Validação: 64 testes de comportamento e contratos, lint, build de produção e verificadores de padrão/jargão. Navegação com Playwright em desktop, tema escuro e celular (390 px), usando dados temporários e dois servidores MCP locais: inclusão e recolhimento, campos obrigatórios, falha/repetição da gravação de credencial, ações homônimas com seleção independente, indisponibilidade e recuperação, persistência ao reabrir e servidor sem ações selecionadas. Serviços externos pagos não foram utilizados.

## Chat, anexos e Configurações (0.7.0)

O chat, Adicionar blocos, o histórico e o menu Mais ações fecham ao clicar fora ou pressionar Esc. Diálogos do cabeçalho também fecham pelo fundo externo. O rascunho do chat, incluindo anexos já preparados, continua disponível ao reabrir durante a edição do fluxo. Recarregar ou sair da página encerra esse rascunho.

O compositor tem campo que cresce com a mensagem, botão de envio, anexos e microfone quando a voz está configurada. Enter envia; Shift+Enter quebra a linha. Use o botão de anexar, arraste arquivos para o campo ou cole imagens/arquivos. É possível enviar apenas anexos; nesse caso, o pedido é “Analise os anexos enviados.” Erros antes da criação da execução preservam o rascunho para nova tentativa.

- Imagens: PNG, JPG e WebP estático, até 40 megapixels. O arquivo é decodificado e validado antes de ser aceito.
- Documentos: PDF com texto extraível (até 100 páginas), TXT, MD, CSV e JSON em UTF-8. O conteúdo é extraído e enviado como texto a cada bloco de IA; PDFs digitalizados precisam ser enviados como imagens das páginas. Documentos com senha, binários e vazios são recusados.
- Limites: 5 arquivos, 10 MB por arquivo, 20 MB por mensagem; 60 mil caracteres por documento e 100 mil somados. Conteúdo excedente é recusado, sem corte silencioso.
- Todos os blocos LLM/Agente alcançáveis precisam aceitar imagens para que uma mensagem com imagens seja executada. A interface indica os blocos a revisar; o servidor valida novamente antes das etapas. O OpenRouter automático exige escolher um modelo específico com suporte a imagens. O aplicativo não troca o modelo nem ignora a imagem para conseguir executar.
- A simulação aceita somente texto digitado. A mensagem com anexos exige conexão real e ao menos um bloco de IA. Documentos e imagens são incluídos em cada bloco de IA do fluxo; não são propagados automaticamente a outros fluxos chamados por ferramentas ou aos canais externos.

Arquivos ficam privados em `DATA_DIR/chat-attachments/`, associados ao fluxo e acessíveis pela sessão administrativa. `chat_attachments` guarda metadados e texto extraído; a execução guarda apenas metadados. Arquivos usados são preservados para o histórico. Arquivos não enviados expiram após 24 horas e são removidos no próximo upload. Inclua esses dados nos backups do volume. O limite do proxy permite o arquivo de 10 MB mais o formulário; o endpoint aplica seu próprio limite durante a leitura.

A antiga tela Conexões passa a se chamar **Configurações**, em `/configuracoes`; `/conexoes` redireciona preservando o retorno da autorização. Modelos de IA têm cartões compactos, limites da assinatura ficam em uma seção expansível e os canais apresentam a configuração sob demanda. O seletor mantém os modelos OpenRouter agrupados por provedor, sem campo de busca. O rodapé discreto da sidebar acompanha a versão do pacote.

Contratos: [imagens e modalidades no Codex App Server](https://learn.chatgpt.com/docs/app-server), [imagens no OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding) e [modalidades do catálogo OpenRouter](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

Validação desta versão: 191 testes automatizados, lint, build de produção e verificadores de padrão/jargão. Navegação em desktop, celular e tema escuro com clique externo/Esc, rascunhos, upload real, prévias, colagem, arrastar/soltar, recusa de imagem incompatível e recuperação de falha no envio. O servidor standalone foi verificado com autenticação, PDF, download privado, arquivo de 10 MB, rejeição de excesso e vínculo de anexo entre fluxos. As respostas dos provedores foram controladas; nenhuma conta paga foi usada.

## Conversa por voz (0.8.0)

O compositor deixa de exibir o aviso permanente dos limites de anexos, o nome do provedor no rodapé e a opção **Ouvir respostas**. As regras de anexos e modelos compatíveis continuam sendo validadas; erros aparecem quando necessários. O botão com ondas inicia a conversa por voz; o microfone separado mantém o ditado de uma mensagem para revisão antes de enviar.

1. Conecte um modelo de IA e a ElevenLabs em **Configurações**.
2. Clique no título do fluxo para abrir **Configurações do fluxo**. Escolha a **Voz do fluxo** e salve. A escolha fica no servidor, acompanha duplicação/exportação/importação e vale ao reabrir em outro navegador. A preferência antiga do navegador é recuperada, quando disponível, até ser salva no fluxo.
3. Abra o chat, pressione **Iniciar conversa por voz** e permita o microfone. Fale normalmente e faça uma pausa de cerca de um segundo: o áudio é transcrito, executa o fluxo escolhido e a resposta é falada. Ao terminar, o app volta a ouvir automaticamente. É possível digitar durante a conversa.
4. Use o microfone para silenciar/reativar a captura. Fale durante a resposta ou toque na esfera para interromper a fala; o botão de fechar encerra a conversa. Fechar o chat, pressionar Esc, sair da página ou deixar a aba oculta também libera o microfone e interrompe a reprodução. Nunca há retomada automática do microfone ao reabrir.

A esfera acompanha a atividade e mostra escuta, processamento, resposta, silenciamento e erros. Se o fluxo exigir aprovação humana, a voz pausa e apresenta **Voltar ao chat para aprovar**; nenhuma aprovação é inferida da fala. Uma falha de envio preserva o texto reconhecido para nova tentativa. Encerrar a voz não desfaz ações de uma execução já iniciada: ela continua registrada no histórico, mas sua resposta não será falada após o encerramento.

Cada mensagem falada continua executando os blocos e ferramentas do próprio fluxo, com o provedor escolhido por bloco. A conversa inclui as últimas seis execuções reais concluídas desta sessão, exclusivamente do mesmo fluxo, para perguntas de continuidade. O contexto é limitado a 1.000 caracteres da pergunta e 4.000 da resposta por troca, com indicação de corte; o pedido atual permanece separado e o contexto usado é registrado na execução. Conversas digitadas fora do modo de voz mantêm o comportamento anterior.

A captura usa MediaRecorder e Web Audio, com cancelamento de eco e supressão de ruído solicitados ao navegador. A pausa dispara a transcrição ElevenLabs; depois vêm a execução do fluxo e a síntese da resposta, em trechos para não cortar respostas longas. É uma conversa automática por turnos: a latência depende dessas etapas, sem substituir o fluxo por um agente externo. Cada fala tem até 45 segundos; ao atingir esse tempo, o trecho capturado é enviado para análise e a escuta retorna após a resposta. Áudio bruto é transitório; perguntas e respostas permanecem no histórico. O uso de transcrição e fala segue a conta ElevenLabs conectada.

O microfone exige HTTPS (ou localhost), permissão e suporte do navegador a MediaRecorder/Web Audio. A detecção de pausa e a interrupção por voz dependem do microfone, do ruído ambiente e do cancelamento de eco do navegador; tocar na esfera oferece interrupção direta. Referências: [captura e permissão no navegador](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [formatos de gravação](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static) e [transcrição ElevenLabs](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

Validação da versão: 85 testes automatizados, lint, build e verificadores de padrão/jargão. Playwright em desktop, celular e tema escuro, usando MediaRecorder/Web Audio reais com entrada sintética: vários turnos, contexto, voz salva, pausa, silenciamento, interrupção por fala/toque, clique externo/Esc, permissão negada ou concedida tarde, resposta tardia, falha de execução e de síntese. As respostas de IA e ElevenLabs foram controladas; não houve uso de contas pagas nem gravação do microfone da pessoa.

A página **Execuções** pagina no servidor em lotes de 20, 50 ou 100 registros, com filtro de status e total. A listagem traz apenas resumos; entrada completa, grafo, saída e etapas são carregados ao abrir o detalhe. O menu mostra a versão beta abaixo da marca, troca de tema ao lado de Workspace e o nome/iniciais da conta local, com saída pelo menu do perfil.
