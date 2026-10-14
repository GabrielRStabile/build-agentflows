# Histórico de versões

## 0.37.0 — 14/10/2026

- Referência a um bloco do fluxo que não executou nesta execução (outro caminho da Condição, etapa posterior) passa a valer vazio em vez de interromper a execução. A etapa registra quais blocos citados não executaram, visível no modal da etapa. Referência a bloco apagado continua falhando, com a mensagem "aponta para um bloco que não existe mais neste fluxo".
- Limite de uso dos fornecedores de API (429): quando a resposta informa quanto esperar (cabeçalho Retry-After ou "try again in 11.5s", como no plano gratuito do Groq), o motor espera e repete a mesma chamada, até três tentativas e 60 segundos por espera, dentro do tempo da execução. Sem essa indicação, ou com espera maior, o erro aparece como antes com a resposta do fornecedor. Não há troca de modelo nem de fornecedor.

## 0.36.0 — 14/10/2026

- LLM e Agente com OpenAI: novo parâmetro **Esforço de raciocínio** (none, minimal, low, medium, high, xhigh, max; em branco mantém o padrão) nos modelos de raciocínio (o-série e gpt-5 em diante), enviado como `reasoning_effort`. O gpt-6-luna só aceita ferramentas em Chat Completions com `none`: no Agente, com o campo em branco, o motor aplica `none` sozinho; com outro nível escolhido, o bloco é recusado antes de chamar a OpenAI. Fluxos salvos sem o campo seguem como antes.
- Erros de OpenAI, Anthropic, Google e Groq mostram a explicação devolvida pelo fornecedor ("Resposta do fornecedor: …") em vez de só a mensagem genérica por status, inclusive ao listar modelos.

## 0.35.0 — 14/10/2026

- Endereço publicado e MCP: campo opcional `session` para continuar a mesma conversa. Sem ele, o servidor gera um id e o devolve na resposta; reenviado, a nova chamada recebe as interações concluídas anteriores dessa sessão como histórico, que os blocos com memória ligada usam. Ids inválidos são recusados; sessões são isoladas por conta e por fluxo. Chamadas sem o campo continuam funcionando como antes. Detalhes da requisição e exemplos atualizados em Implantar › cURL.

## 0.34.0 — 14/10/2026

- Endereço publicado (`/webhook/flows/<id>`): a resposta passa a ser síncrona. O POST espera a execução terminar e devolve `200` com `id`, `status` e `output` (waiting quando há aprovação pendente); só volta `202` com `queued`/running se a execução passar do limite de tempo, e `?wait=0` responde na hora. O Conector MCP segue assíncrono.
- Implantar › cURL: sem o parágrafo explicativo e sem o botão Copiar ao lado do título; o endereço com "Copiar link" fica visível e os demais detalhes da requisição ficam em "Detalhes da requisição", recolhido por padrão. Exemplos atualizados para a resposta síncrona.

## 0.33.0 — 14/10/2026

- Implantar › cURL: o endereço publicado aceita `multipart/form-data` com o campo `input` e até cinco arquivos em `file`, que viram anexos da execução (JSON `{"input"}` continua aceito). Novo bloco **Requisição HTTP** com o endereço da API e botão "Copiar link", método, tipo de envio, campos, autenticação e formato da resposta. Os exemplos em cURL, JavaScript e Python usam multipart.
- Editor: a seleção de texto volta a aparecer nos campos Instruções e Mensagem do LLM/Agente quando há referências destacadas (o fundo da seleção não era pintado com o texto transparente).
- Modal da etapa: Instruções e Memória abrem recolhidas; a Entrada mostra a troca em turnos, com só "Usuário" e "Assistente" em negrito e o conteúdo como texto sem formatação.

## 0.32.0 — 14/10/2026

- Implantar › cURL: seletor **Acesso** com "Público" (padrão) e "Com autenticação". No modo público o endereço `/webhook/flows/<id>` executa fluxos publicados sem chave e os exemplos saem sem o cabeçalho Authorization; no modo com autenticação a chave da conta continua obrigatória e só então a seção Chave de acesso (gerar, copiar, revogar) aparece na aba. O Conector MCP segue sempre com chave. A escolha é salva por fluxo (GET/PUT /api/flows/[id]/acesso). Fluxos não publicados não respondem ao público.

## 0.31.3 — 14/10/2026

- Transcrição da etapa: o rótulo "Pessoa" passa a "Usuário" na Entrada e no texto enviado ao ChatGPT (App Server).
- Modal da etapa: a memória enviada ao modelo (resumo e mensagens anteriores) aparece em um bloco recolhível "Memória", no mesmo formato das Instruções e logo abaixo delas, com o JSON formatado. A Entrada mostra só a troca da etapa (Usuário, Assistente, Usuário). O que o modelo recebe não mudou.

## 0.31.2 — 14/10/2026

- LLM e Agente: no primeiro bloco com Mensagem (opcional) e memória ligada, o modelo responde primeiro à conversa do chat e só então recebe a Mensagem como pergunta seguinte, com o histórico dessa troca. A Entrada da etapa mostra Usuário, Assistente e Usuário; os tokens somam as duas chamadas. Blocos seguintes continuam em uma chamada, com o resultado anterior no papel da resposta.

## 0.31.1 — 14/10/2026

- LLM e Agente: no primeiro bloco com Mensagem (opcional) e memória ligada, a conversa do chat vai ao modelo como mensagem da pessoa, seguida da Mensagem, em vez de ficar só como "dados de contexto" na memória. A Entrada da etapa mostra essa transcrição.
- Modal da etapa: as Instruções aparecem abertas acima de Entrada e Saída, em vez de um item recolhido no fim.

## 0.31.0 — 13/10/2026

- LLM e Agente: a Mensagem (opcional) é enviada como a pergunta seguinte de uma conversa. Com memória ligada e um resultado anterior, o modelo recebe a conversa como primeira pergunta, o resultado da etapa anterior como primeira resposta e a Mensagem como a nova pergunta (papéis reais no OpenRouter, OpenAI e Anthropic; transcrição "Usuário:"/"Assistente:" no ChatGPT). Turnos citados por referência não se repetem. O editor mostra o papel `user` ao lado do campo e explica o envio.
- Chat de teste: o botão Limpar conversa fica vermelho no canvas e no modal expandido.
- Editor: os ícones de desfazer e refazer foram redesenhados e deixam de aparecer preenchidos nos controles do canvas.

## 0.30.2 — 13/10/2026

- Chat de teste: o botão da conversa por voz fica oculto enquanto a voz não está configurada (ElevenLabs em Configurações). Antes ele aparecia e abria as configurações do fluxo.

## 0.30.1 — 13/10/2026

- Chat de teste expandido: o modal cresce até 1600×1000 e as mensagens, a tela vazia e o campo de envio ocupam toda a largura disponível (antes limitada a 900 px). O campo de mensagem aceita até seis linhas antes de rolar; a bolha da pessoa fica em até 70% da largura.

## 0.30.0 — 13/10/2026

- Nova referência `{{currentDateTime}}`: data e hora atuais em português, no horário de Brasília, resolvidas na hora da execução. Aparece ao digitar `{{` em qualquer campo (inclusive LLM e Agente) como "Data e hora atual" e é mostrada como `{{Data e hora atual}}`. O gerador de fluxos conhece a referência.
- Validação: 365 testes gerais, lint e build sem erros.

## 0.29.0 — 13/10/2026

- Referências nativas em português nos campos do editor: `{{input}}` aparece como `{{Conversa}}`, `{{last}}` como `{{Etapa anterior}}` e `{{state.approval}}` como `{{Decisão da aprovação}}`, no autocompletar, no destaque colorido e no texto. O fluxo continua gravando as chaves do motor, que seguem aceitas quando digitadas à mão e em arquivos importados. Blocos com um desses nomes seguem pelo id. Placeholders e textos de ajuda atualizados.
- Validação: 365 testes gerais, lint e build sem erros.

## 0.28.0 — 13/10/2026

- Chat de teste: enquanto a execução roda, a bolha mostra o bloco em andamento (nome, tipo e ferramenta em uso) com o indicador de carregamento, em vez dos resultados parciais de cada etapa. A resposta aparece só ao terminar; execuções com falha mostram apenas o erro. Os detalhes de cada etapa seguem em "Etapas executadas".
- Validação: 364 testes gerais, lint e build sem erros.

## 0.27.1 — 13/10/2026

- O menu de referências `{{…}}` não é mais cortado pelo diálogo em blocos com poucos campos (ex.: Resposta): ele é posicionado em coordenadas da janela, acompanha rolagem e redimensionamento e abre para cima quando falta espaço abaixo.

## 0.27.0 — 13/10/2026

- Referências a blocos aparecem pelo nome nos campos do editor (`{{Analista}}` em vez de `{{nodes.a1}}`), no autocompletar, no destaque colorido e ao inserir. O fluxo continua gravando o id: renomear o bloco atualiza o campo sozinho, e nomes repetidos entre blocos mantêm o id de cada ocorrência pela posição no texto. Nomes iguais a referências nativas (input, last, fluxo.x…) ou com chaves seguem pelo id.
- Validação: 364 testes gerais, lint e build sem erros.

## 0.26.0 — 13/10/2026

- Bloco Repetir sem setas de saída: o destino é escolhido pelo nome dentro do bloco (campo "Voltar para", antes do máximo de repetições) e aparece como etiqueta no canvas. Novo campo "Mensagem ao atingir o limite", com referências `{{…}}`, entregue como resultado quando o limite chega sem concluir; em branco, mantém o resultado anterior.
- Motor: Repetir volta ao destino enquanto há passagens e encerra a execução no limite, como Agente/LLM terminal. A validação exige um destino válido (nem o próprio bloco, nem Início ou Resposta), considera o destino alcançável e aceita Repetir como fim de caminho.
- Conexões nunca formam ciclo. Fluxos antigos são migrados ao abrir o editor e ao validar: a seta Repetir vira o destino escolhido e a seta Concluir é removida; blocos que vinham depois de Concluir ficam soltos até serem reconectados ou removidos.
- Gerador de fluxos atualizado para o novo formato (target, limit, limitMessage) e tolerante a setas de loop na resposta.
- Validação: 361 testes gerais, lint e build sem erros.

## 0.25.0 — 13/10/2026

- Chat de teste: "Expandir" abre um modal grande centralizado sobre o editor (fundo escurecido, cabeçalho com Limpar conversa, Reduzir e Fechar), em vez de só alargar o painel lateral. Esc e clique no fundo voltam ao painel; rascunho, anexos e conversa por voz são preservados porque o mesmo componente continua montado.
- Diálogos dos blocos: selecionar texto num campo e soltar o mouse fora do diálogo não o fecha mais; só um clique iniciado e concluído no fundo fecha.
- Validação: 359 testes gerais, lint e build sem erros.

## 0.24.0 — 13/10/2026

- Referências `{{…}}` coloridas nos campos dos blocos (Instruções, Mensagem, critérios da Condição, Novo valor): roxo quando a referência existe no fluxo e vermelho com sublinhado quando não existe. `state.<variável>` vale como `fluxo.<variável>`, como no motor, que passa a compartilhar a mesma regra de leitura.
- Abrir um bloco não coloca mais o foco no campo de nome do cabeçalho.
- Diálogo Implantar: a aba Integrações abre em cURL.
- Minha conta: o cartão do AI Action ganha "Conhecer o programa" (landing) e "Garantir minha vaga" (checkout com o cupom já aplicado).
- Validação: 359 testes gerais, lint e build sem erros; alinhamento da camada de destaque conferido no Chromium com a folha de estilos real, nos temas claro e escuro.

## 0.23.0 — 13/10/2026

- Diálogo Implantar sem cabeçalho: apenas o botão de fechar, fixo no canto enquanto o conteúdo rola. O componente Modal passa a aceitar esse modo (título opcional, nome do diálogo por `label` para leitores de tela).
- Aba "Developer" renomeada para "cURL". Nas abas cURL e Conector MCP, o exemplo (Execute seu fluxo / Conecte seu assistente) vem primeiro e a Chave de acesso fica abaixo.
- Validação: 355 testes gerais, lint e build sem erros.

## 0.22.0 — 13/10/2026

- Preparação para turmas grandes (150 pessoas testando ao mesmo tempo): análise, tabela de dimensionamento e perfil de ambiente em DEPLOY-COOLIFY.md ("Prática com 150 pessoas"). O Compose parametriza memória, CPUs, PIDs e tempo de parada do worker e do app; cada vaga ChatGPT custa cerca de 40 PIDs, e o limite anterior de 256 bloqueava a sexta execução simultânea.
- Posição na fila: enquanto a execução aguarda um worker, o chat, o histórico e o bloco Início mostram "Na fila · N execuções à frente", "começa em instantes" ou "aguardando o processador" (nenhum worker ativo), com a explicação de que não é preciso enviar de novo. `GET /api/runs/[id]` devolve `queue` calculado na leitura.
- Acompanhamento leve: `GET /api/runs/[id]?after=` responde 204 sem corpo quando nada mudou; a espera pelo POST usa o resumo paginado; reabrir o fluxo busca a conversa em uma requisição (`?ids=`); o painel de execuções pede 30 itens; testar sem alteração não repete o salvamento.
- Envio idempotente: o editor escolhe o identificador da execução (`runId`) e, em erro de rede ou 502/503/504, repete sem criar uma segunda execução; aprovar duas vezes mostra o estado atual em vez de erro.
- Limite de execução configurável (`LIMITE_EXECUCAO_SEGUNDOS`, padrão 180 s) aplicado ao motor, ao turno do ChatGPT e à drenagem do worker.
- ChatGPT: o número de conexões por processo acompanha `EXECUCOES_SIMULTANEAS` (antes fixo em 4, abaixo das 6 vagas padrão); dentro de uma tarefa, a sessão espera até 15 s por uma requisição web curta; tempo limite da etapa explicado como tal; limite de uso, sessão expirada, rede e tarefa grande demais explicados em português com o detalhe original.
- Acompanhamento por push: `GET /api/runs/[id]/events` envia a execução por Server-Sent Events a cada mudança anunciada pelo PostgreSQL (LISTEN/NOTIFY no commit), com uma única conexão de escuta por processo web; o editor e o histórico usam o stream e voltam ao polling (`?after=`) se ele não abrir em 5 s ou cair. Fim do polling a cada 2 s por pessoa.
- Worker: reivindica no instante do aviso do Redis (BLPOP de 1 s) em vez de esperar o próximo ciclo; gravações de progresso não revalidam credenciais e bases (uma referência removida durante a execução não a derruba); logs JSON `tarefa_iniciada`/`tarefa_concluida` com espera e duração, sem conteúdo do usuário. `GET /api/health` inclui o estado da fila e `workerAlive`.
- Validação: testes gerais com PGlite, lint e build sem erros; Redis real não disponível nesta máquina (o script `test:redis` cobre a espera bloqueante quando `REDIS_SERVER` estiver definido).

## 0.21.0 — 13/10/2026

- LLM com modelo de imagem ou vídeo: o campo Instruções vira PROMPT, já preenchido com `{{input}}`; Mensagem (opcional), memória e bases de conhecimento ficam ocultas e o que foi configurado antes de escolher o modelo é ignorado.
- Replicate como ferramenta do Agente, com a mesma credencial do bloco LLM: a tela verifica o modelo e informa se ele é multimodal (recebe imagens de referência, como `google/nano-banana-pro`) ou só texto. O resultado aparece abaixo da resposta do agente.
- Custo por etapa e total da execução, exibido somente quando o provedor o informa (OpenRouter). A Replicate não informa valor; o identificador da solicitação fica nos detalhes da etapa.
- Chat mais limpo: mídia abre em nova aba por um ícone discreto e as solicitações de mídia saíram do chat. A Entrada dos detalhes da etapa de mídia mostra o prompt enviado; no LLM, o rótulo passa a ser "Instruções".
- Correção: após aprovar ou rejeitar, o chat e o canvas acompanham a execução até o fim, sem ficar presos em "Em execução".
- Validação: 330 testes gerais, teste de mídia com PostgreSQL, build e lint sem erros; aprovação, PROMPT de mídia, chat, detalhes da etapa e ferramenta Replicate verificados no navegador em pilha Docker isolada, com respostas controladas e sem credenciais reais.

## 0.20.0 — 13/10/2026

- Minha conta: convite do AI Action antes do Perfil, com o cupom exclusivo `JOURNEY2ACTION` e botão para copiar.
- Limite de armazenamento das bases de conhecimento: até 50 MB em arquivos por conta (`LIMITE_ARMAZENAMENTO_MB`), exibido em Limites de uso. Cada arquivo pode ter até 10 MB (até 20 arquivos e 20 MB por envio).
- Validação: 326 testes gerais (PGlite), build e lint sem erros; Minha conta verificada no navegador em desktop e celular (ordem dos blocos, cópia do cupom e medidor de armazenamento).

## 0.19.0 — 13/10/2026

- Replicate aberta no bloco LLM: campo `empresa/modelo` no lugar da lista; o schema do modelo define a entrada e o resultado (texto, imagens ou vídeo MP4/WebM). Modelos oficiais rodam pelo nome e os da comunidade pela versão. A Replicate não aparece mais na lista do Agente; agentes salvos continuam funcionando.
- Fluxos com modelo de mídia têm até 10 minutos de execução, para vídeos de 4 a 5 minutos.
- Chat e histórico mostram imagens e vídeos gerados com o link "Abrir em nova aba"; anexos respondem a `Range` para tocar e avançar vídeos.
- Corrigido o bloqueio de endereços: no Node 24 todo IPv4 público era tratado como privado, impedindo o download de resultados de mídia e de fontes da Base de Conhecimento.
- Referências como `{{input}}`, `{{last}}` e `{{nodes.x}}` nas instruções ou na mensagem não duplicam mais o conteúdo que o motor acrescenta sozinho (mensagem automática, memória e Aprovação).
- Ao abrir o chat de teste, o canvas se ajusta para o último bloco (Resposta) não ficar coberto pelo painel.
- Nova credencial de modelo direto na lista de credenciais, sem botão separado.
- Plano beta com até 1000 execuções reais por mês e 5 fluxos por conta (`LIMITE_EXECUCOES_MES`, `LIMITE_FLUXOS`); contas AI Action são ilimitadas. Uso mensal em `usage_months`, contado na mesma transação que enfileira a execução.
- Ao atingir um limite, diálogo convida a fazer parte do AI Action; Novo Fluxo Agêntico avisa antes de abrir o editor.
- Minha conta no menu do nome de usuário: nome, e-mail, forma de acesso, uso do mês e alteração de senha (contas com senha), encerrando as outras sessões.
- Aviso de conexão do ChatGPT na tela inicial só aparece depois de confirmar que a conta não está conectada.
- Validação: 325 testes gerais (PGlite), build e lint sem erros; navegador com app, worker, PostgreSQL e Redis temporários e a API da Replicate simulada (vídeo de 4,5 minutos, imagem, nova aba e bloco Resposta visível).

## 0.18.0 — 08/10/2026

- Aplicação exclusivamente multi-tenant com PostgreSQL/Drizzle; removidos armazenamento SQLite, fallbacks globais e aliases de conexões da primeira versão.
- Configurações, credenciais, fluxos, conhecimento, anexos e arquivos exigem contexto autenticado do usuário. Registro interno de conhecimento renomeado com migração das bases/índices existentes.
- Corrigida a comparação de configurações JSONB para que mudanças apenas na busca não invalidem vetores. Testes migrados para contas e bancos isolados.
- Telas de entrada e acesso ao beta revisadas: logo Agentflows no login, cadastro e sidebar, link de convite preservado e resgatado automaticamente, e animação suave de conexões no fundo do login e cadastro (estática com movimento reduzido).
- Novo favicon e ícone para tela inicial de celulares.
- Credenciais e seleção de fornecedores e modelos centralizadas; limites da assinatura no cartão do ChatGPT.
- Limites de fila e execução configuráveis por ambiente; worker conclui execuções em andamento ao reiniciar.
- Validação: 307 testes gerais, 104 com PostgreSQL servidor, build e lint sem erros; Docker com dois workers, limites por usuário, reinício/volumes e navegador desktop/celular.

## 0.17.1 — 25/09/2026

- Removido o acesso à Base de Conhecimento da tela Fluxo Agêntico.
- Paginação exibida somente quando a lista contém mais de uma página.

## 0.17.0 — 25/09/2026

- Chat de teste com badges por chunk retornado, abrindo o conteúdo completo e sua origem em um modal. O texto consultado fica preservado na execução, respeitando referências habilitadas por base.
- Badges das ferramentas efetivamente chamadas abrem os detalhes de entrada, saída, tempo e status, incluindo falhas e chamadas repetidas. Visualização restrita ao chat de teste.

## 0.16.1 — 25/09/2026

- Modal de saída simplificado: removido Continuar editando e botão Salvar e sair renomeado para Salvar.

## 0.16.0 — 25/09/2026

- Agente e LLM com múltiplas bases em cards no padrão de Ferramentas, descrição de uso, referências e parâmetros de consulta por base.
- Cada base é oferecida ao modelo como ferramenta independente; busca sob demanda, inclusive em configurações antigas, e registros de entrada, saída, duração e bases disponíveis nos detalhes da execução.
- Ícones compactos das ferramentas no bloco Agente, com nomes no tooltip e indicador de conhecimento no Agente/LLM.

## 0.15.0 — 25/09/2026

- Record Manager com limpeza nenhuma, incremental ou completa, identificação automática ou chave de metadados e retenção aplicada às consultas.
- Exclusão de base com ícones e botão vermelhos, confirmação pelo nome e fechamento pelo header, sem botão Cancelar.
- Validação da limpeza de índices locais ao migrar Faiss para Postgres e excluir a base, incluindo recuperação de falhas e isolamento entre bases.

## 0.14.2 — 25/09/2026

- Endereço do serviço de embeddings movido para Opções avançadas, mantendo os padrões dos provedores e as conexões já configuradas.

## 0.14.1 — 25/09/2026

- Campo Local do índice removido da configuração do Faiss; o armazenamento continua sendo administrado automaticamente por base e versão.

## 0.14.0 — 25/09/2026

- Busca configurável por base: Top K, similaridade mínima e herança no teste e no Agente, com substituição opcional. Alterar apenas a busca mantém os vetores publicados e não exige reindexação.
- Faiss exibe o caminho da geração publicada, preservando isolamento por base/versão. Faiss e Postgres filtram metadados antes de selecionar os resultados.
- Postgres com credencial compartilhada de usuário/senha, host, banco, porta, SSL com validação de certificado, tempos limite e compatibilidade com strings de conexão existentes. Vector Store e Record Manager reutilizam a credencial; senhas não são devolvidas à interface.
- Postgres permite prefixo de tabela, coluna de conteúdo, lote de gravação e estratégias cosseno, euclidiana ou produto interno. Tabelas continuam isoladas por geração; a pontuação mínima é sempre similaridade de cosseno.
- OpenAI Embeddings permite reduzir dimensões dos modelos text-embedding-3 e escolher float/base64. A troca de dimensões invalida o reaproveitamento dos vetores antigos.
- Regressão com Faiss nativo, pgvector real, filtros, credenciais, reindexação e limpeza; comparação detalhada da jornada com o Flowise em KNOWLEDGE-FLOWISE.md.

## 0.13.3 — 25/09/2026

- Ícone de exclusão das bases de conhecimento em vermelho, à direita do status no cabeçalho do card.

## 0.13.2 — 25/09/2026

- Seção Agentflows renomeada para Fluxo Agêntico, com navegação, busca e ações usando a mesma nomenclatura.
- Contador ao lado da busca removido, preservando o alinhamento dos controles.

## 0.13.1 — 25/09/2026

- Histórico valida a resposta paginada antes de atualizar a tela, impedindo erro ao acessar `items.length` em retornos inválidos ou estados antigos preservados pelo Fast Refresh.
- Falhas de carregamento exibem aviso e nova tentativa automática, sem apresentar resultados vazios ou totais incorretos.
- Testes de regressão para respostas legadas, campos ausentes, itens malformados e paginação.

## 0.13.0 — 25/09/2026

- Upload de fontes por arrastar e soltar, teclado ou clique em toda a área; nome automático igual ao primeiro arquivo. Extrair e revisar salva a configuração, sem campo de nome nem botão adicional de salvar no modal.
- Revisão de fragmentos em modal amplo, mantendo busca, metadados e edição; reextração com indicador de andamento; confirmação de exclusão com botão vermelho e ícone, sem Cancelar.
- Menu Credenciais entre Base de Conhecimento e Configurações, com ferramentas e os quatro provedores de embedding. Conexões reutilizáveis por base, migração automática das chaves existentes, rotação de chaves e bloqueio de exclusão enquanto vinculadas.
- Badge discreto com versão beta abaixo da marca, tema por ícone ao lado de Workspace, cadeado em Credenciais e perfil com iniciais, nome real da sessão e opção de sair.
- Execuções com paginação e filtro no SQLite, 20/50/100 itens por página e detalhes carregados sob demanda. O contrato anterior utilizado pelo editor permanece compatível.
- Testes de credenciais/migração, execução com chave atualizada, nomes de arquivo, paginação acima de 100 registros, payload reduzido e autenticação do perfil.

## 0.12.0 — 25/09/2026

- Seletores de fontes, embeddings, bancos vetoriais e Record Managers com logos do Flowise, busca e layout adaptado aos temas do projeto.
- Quatro provedores únicos de embeddings: Google Gemini, OpenAI, VoyageAI e Ollama, com modelos predefinidos, dimensões automáticas, processamento em lotes e preparação adequada de documentos e consultas.
- Integrações de indexação, busca e exclusão com Chroma, Elasticsearch, Faiss nativo, MongoDB Atlas, Pinecone, Postgres, Qdrant, Weaviate, Supabase, SingleStore e OpenSearch. Faiss é o padrão das novas bases; configurações anteriores permanecem compatíveis.
- Record Manager Postgres com tabela/namespace configuráveis, além do SQLite; conexões cifradas e limpeza por geração, inclusive depois de trocar o destino.
- Comparação com as principais funcionalidades do Flowise em [KNOWLEDGE-FLOWISE.md](KNOWLEDGE-FLOWISE.md), com requisitos e diferenças de cada integração.
- Validação com Postgres/pgvector e Chroma reais, SQL de preparação Supabase, Faiss nativo no Docker Alpine, contratos das APIs/drivers e revisão visual em desktop e celular. Serviços externos sem credenciais foram validados por contrato, sem homologação em contas reais.

## 0.11.0 — 25/09/2026

- Base de Conhecimento na tela inicial e na navegação, seguindo a jornada Document Store do Flowise: fontes, extração, revisão dos fragmentos, Embeddings, Vector Store, Record Manager e teste de consulta.
- Vinte opções de extração em ordem alfabética, com campos por serviço, envio de arquivos, credenciais cifradas, divisão configurável e metadados por fonte ou fragmento.
- Embeddings OpenAI/API compatível e Ollama; vetores persistidos no app ou no Qdrant; Record Manager SQLite opcional para reaproveitar embeddings sem duplicar conteúdo.
- Indexação com histórico e progresso, substituição atômica do índice, isolamento por base, limpeza de índices anteriores e recuperação de operações interrompidas.
- Agente permite selecionar a base, ajustar a consulta e escolher se a resposta retorna as referências encontradas. A recuperação funciona com ChatGPT e OpenRouter.
- Testes de extração, arquivos reais, contratos dos serviços, persistência, busca, reindexação, exclusão, falhas e execução nos dois motores; revisão visual no navegador em desktop, celular e tema escuro.

## 0.10.0 — 25/09/2026

- Configurações > Credenciais usa o mesmo seletor com busca, nomes e ícones do bloco Agente, limitado às ferramentas que precisam de credencial. Conexões antigas continuam editáveis.
- Ações de editar e excluir credenciais usam ícones; o botão Salvar domínios fica alinhado à direita.
- Etapas do chat e do histórico abrem um modal com status, duração, entrada, saída e instruções do agente, seguindo os temas claro e escuro.
- Tokens informados pelo ChatGPT e OpenRouter aparecem por etapa, incluindo entrada, saída, cache e raciocínio; consumo parcial e dados indisponíveis são identificados.
- Respostas renderizam Markdown com listas, links, tabelas e blocos de código, sem executar HTML.
- Corrigido o despacho de ferramentas nativas e MCP no ChatGPT; agentes com ferramentas configuradas priorizam essas integrações sobre a busca nativa.
- Chamadas de ferramentas registram argumentos, resultado, duração, execução em andamento e falhas, inclusive no cancelamento.

## 0.9.5 — 24/09/2026

- Modal de IA com criação do zero e edição conversacional do fluxo atual, incluindo alterações ainda não salvas.
- Ajustes pontuais preservam blocos, configurações, posições e conexões não envolvidos no pedido, com prévia e aplicação explícita no canvas.
- Conversa permite refinar a proposta em sequência e mantém a prévia anterior quando uma solicitação falha.
- Atualizações de variáveis em Agente e LLM usam cartões como os do Início, com exclusão por ícone e prevenção de variáveis duplicadas.
- Novo valor oferece referências por clique, teclado e touch, mantendo o formato `{{...}}` e dispensando o botão de usar a resposta do agente.
- Check do nome do bloco aparece somente durante a edição e fica oculto após a confirmação.

## 0.9.4 — 24/09/2026

- Geração com IA alterna mensagens durante a espera e mostra o tempo decorrido.
- Condições com critérios adicionáveis, comparadores de texto e número e saídas numeradas; o primeiro critério atendido define o caminho.
- Última saída automática quando nenhum critério é atendido, com mínimo de duas saídas e preservação dos fluxos antigos Sim/Não.
- Remover um critério elimina somente a conexão correspondente, preservando as demais e o caminho automático.
- Geração por IA e execução compatíveis com condições de múltiplas saídas.
- Hover e foco visíveis no header, com áreas iguais para Implantar e Configurações e alvos ampliados no touch.

## 0.9.3 — 24/09/2026

- Novos fluxos abrem sem nome e sem gravação automática, apenas com Início centralizado; o primeiro salvamento pede o nome.
- Salvar preserva blocos, posições e conexões, inclusive fluxos em construção. A validação de execução aparece no chat.
- Salvamento atualiza a v1 usada pelos testes e integrações, sem ação separada de publicação.
- Nome editável no header, asterisco para alterações pendentes, ações no menu de configurações e botão Salvar por ícone, com confirmação destacada.
- Opções dos blocos acessíveis por hover, clique e toque; Agente e LLM com textos mais discretos e avisos de conexão corrigidos.
- Geração com IA simplificada, campo de descrição ampliado e progresso transmitido pelo servidor, com animação de blocos e conclusão após validação.
- Integrações agrupadas, geração de chave de acesso no próprio painel e cópia com feedback.
- Chat no site com modos simples e detalhado, localhost permitido por padrão sem domínios definidos e instalação com feedback de cópia.
- Preview do chat abre em nova aba e oferece o script de instalação; controles de domínio reutilizados nas configurações.

## 0.9.2 — 24/09/2026

- Conexões sempre visíveis; seta de saída no hover do bloco, com acesso permanente no touch e alvos de toque ampliados.
- Chat sem simulação ou exemplos, com botão Conectar ChatGPT abaixo da apresentação quando nenhum motor está conectado.
- Campo de mensagem com uma linha inicial, crescimento até três linhas e rolagem para textos maiores.
- Modais de blocos aplicam alterações ao fechar ou clicar fora, mantendo a validação e removendo os botões Salvar e Cancelar.
- Variáveis do Início separadas em cartões com exclusão por ícone.
- Agente e LLM com seleção de modelo, indicação de conexão e menos avisos.
- Pesquisa web do ChatGPT ativa automaticamente para Agente e LLM, incluindo fluxos existentes.

## 0.9.1 — 24/09/2026

- Pontos de saída sempre visíveis, linhas com maior contraste e área de entrada ampliada para conectar blocos.
- Dicas distinguem saídas já conectadas de saídas disponíveis.

## 0.9.0 — 24/09/2026

- Chat incorporado com retomada da conversa, eventos da página, captura de tela, aprovação humana e cancelamento.
- Execuções persistentes com limite de tempo e revisão de tarefas interrompidas.
- Início com nome fixo, editor de variáveis e referências `{{fluxo.NomeVariavel}}`, preservando `{{state.nome}}`.
- Atualização de variáveis ao concluir Agente/LLM e resposta direta em etapas terminais.
- Modelo como primeiro campo e pesquisa web opcional na conexão ChatGPT.
- Domínios autorizados em Configurações > Segurança, aplicados ao acesso e ao iframe.
- Compose para Coolify com volume persistente e documentação de instalação.

## 0.5.0 — 20/09/2026

- Conexões com quatro cartões alinhados: ChatGPT, OpenRouter, WhatsApp e ElevenLabs.
- Aceite dos termos StartSe para Z-API e ZapperHub, com registro e validação no servidor.
- Limites da assinatura ChatGPT: percentual disponível, janela e próxima renovação, pelo protocolo oficial.
- Chat com limpar, expandir e fechar no topo, sem cabeçalho duplicado. Exemplos e simulação somem com IA conectada.
- Catálogo com todas as 24 ferramentas solicitadas, seleção independente por agente e credenciais reutilizáveis entre agentes e fluxos.
- Gestão de credenciais e servidores dentro do Agente; remoção explicita o impacto sobre os demais agentes.
- Google Workspace e Microsoft 365 por credenciais OAuth; renovação opcional. Browserless e Slack pelo SDK MCP oficial; E2B em sandbox remoto. Arquivos confinados à pasta dos agentes e operações OpenAPI 3 em JSON.
