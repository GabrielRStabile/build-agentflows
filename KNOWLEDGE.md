# Base de Conhecimento

Acesso pela tela inicial ou pelo menu **Base de Conhecimento**. A implementação segue a jornada do Document Store do Flowise, com código próprio e a interface do Build Agentflows.

## Jornada

1. **Criar base:** dê um nome e uma descrição para identificar o conteúdo.
2. **Documentos:** escolha uma fonte, configure a conexão ou envie os arquivos e clique em **Extrair e revisar**. O botão salva a configuração e inicia a extração, que não gera embeddings.
3. **Revisar fragmentos:** pesquise, edite o texto e os metadados ou remova trechos. A divisão pode ser recursiva ou por separador, com tamanho e sobreposição configuráveis. Reextrair substitui os fragmentos da fonte, inclusive suas edições manuais.
4. **Embeddings:** escolha Gemini, OpenAI, VoyageAI ou Ollama, modelo e conexão compartilhada no menu Credenciais. Essa conexão é independente do modelo do Agente. Uma assinatura ChatGPT não é usada como credencial de embeddings.
5. **Vector Store:** escolha Faiss local ou um dos dez serviços remotos descritos na [comparação de provedores](KNOWLEDGE-FLOWISE.md). Cada base e cada geração têm isolamento próprio.
6. **Record Manager:** use o registro interno ou Postgres para reaproveitar embeddings da indexação anterior. O reaproveitamento exige texto, provedor, endereço, modelo e preparação iguais. Metadados editados permanecem associados ao trecho, mesmo quando seu vetor é reaproveitado.
7. **Indexar base:** a nova geração só fica disponível após a conclusão. O histórico informa quantos embeddings foram gerados e reaproveitados. Alterações nas fontes e na configuração de indexação exigem nova indexação antes de consultar. Top K, similaridade mínima, filtro e estratégia de distância são aplicados ao salvar, sem reindexar.
8. **Testar consulta:** digite uma pergunta para ver conteúdo, origem, metadados e pontuação dos trechos encontrados. Top K e similaridade mínima seguem os padrões salvos na etapa Vector Store. Deixe os campos de ajuste em branco para herdar ou preencha para substituir apenas neste teste.
9. **Agente e LLM:** em Conhecimento, use **Adicionar base de conhecimento** para criar cards como os de Ferramentas. Selecione a base e descreva o conteúdo, por que é útil e quando consultar; a descrição da base é sugerida e pode ser adaptada ao bloco. Cada base vira uma ferramenta independente, com busca somente quando o modelo a chama. Ative **Retornar documentos de origem** em cada card para acrescentar suas referências à resposta. Top K e similaridade mínima herdam a base; Ajustar consulta permite substituí-los por card. O limite é 10 bases distintas por bloco.
10. **Verificação:** cada chamada aparece como **Conhecimento: nome da base**, com consulta, resultado, duração e estado. Os detalhes do Agente/LLM mostram as bases oferecidas ao modelo, suas descrições e os trechos recuperados. Sem chamada, não há busca nem referências automáticas. Referências descrevem resultados recuperados, não garantem que todos tenham sido usados na redação.

Fluxos antigos com uma única `knowledgeBase` continuam válidos e também recebem uma ferramenta, usando a descrição da base. Editar seus cards salva a nova lista. Remover o último card impede que o vínculo antigo seja reativado. É preciso usar um modelo com suporte a chamadas de ferramentas para consultar as bases.

## Extratores (ordem alfabética)

| Opção | Configuração e comportamento |
| --- | --- |
| Apify Website Content Crawler | URL, chave Apify e limite; executa o ator `apify/website-content-crawler`, acompanha o resultado e lê o dataset. |
| Cheerio Web Scraper | URL, seletor CSS opcional e limite; HTML estático, links do mesmo domínio e remoção de scripts/navegação. Não executa JavaScript do site. |
| Csv File | Arquivo `.csv`, cabeçalho na primeira linha e coluna de conteúdo opcional; um documento por linha. |
| Custom Document Loader | JavaScript e variáveis JSON executados em sandbox remoto E2B, com chave própria. Retorne `[{ pageContent: "texto", metadata: {} }]`; as variáveis ficam em `input`. O código não acessa o processo nem as credenciais do app. |
| Docx File | Arquivos `.docx`. |
| FireCrawl | URL e chave; extrai a página pelo endpoint de scrape em Markdown. |
| Github | Organização/repositório, branch, caminho opcional, limite e token para repositório privado. Preserva o endereço de cada arquivo; importa formatos textuais, não binários. |
| Google Drive | ID de arquivo **ou** pasta e token OAuth com permissão de leitura; exporta documentos, planilhas e apresentações nativos e baixa arquivos compatíveis. Pastas consideram os arquivos diretamente contidos, sem recursão. |
| Google Sheets | ID da planilha, intervalo e token OAuth de leitura; preserva a posição da linha no intervalo. |
| JSON File | Arquivo `.json`, objeto ou lista, com caminho opcional como `dados.itens`. |
| Microsoft Excel | Arquivos `.xlsx` e `.ods`. |
| Microsoft Power Point | Arquivos `.pptx` e `.odp`, incluindo notas. |
| Microsoft Word | Arquivos `.docx` e `.odt`. |
| PDF File | Texto por página, preservando número da página. Documentos digitalizados precisam de reconhecimento de texto prévio. |
| Plain Text | Texto digitado ou colado. |
| S3 | Bucket, região, chave do objeto e credenciais AWS; token de sessão opcional. Usa parsers locais dos formatos compatíveis. |
| S3 Directory | Bucket, região, prefixo e limite; lista objetos e usa os mesmos parsers de S3. |
| SearchAPI For Web Search | Pesquisa e chave; importa título, resumo e referência dos resultados orgânicos do Google. |
| Spider Document Loaders | URL, chave e limite; rastreamento em Markdown. |
| TextFile | Arquivos `.txt`, `.md`, `.markdown` e `.log`. |

Tokens OAuth Google são informados na fonte e precisam ser atualizados quando expirarem. Esta configuração não inicia um novo consentimento OAuth nem usa as antigas rotas `/api/setup/oauth` desativadas do app. Serviços externos continuam exigindo contas e permissões próprias.

## Persistência, erros e limites

- A base, suas fontes, fragmentos, vetores e histórico ficam no PostgreSQL, separados por usuário. Credenciais e arquivos de entrada são cifrados por conta/base/recurso. Índices FAISS ficam em diretórios privados de `DATA_DIR/users/<user_id>`, compartilhados entre web e worker.
- As rotas `/api/knowledge/**` são administrativas e passam pela sessão existente. Nenhuma fonte ou credencial é publicada junto com a exportação do grafo: o grafo guarda somente os identificadores das bases, descrições de uso e opções de consulta.
- Upload de até 20 arquivos de até 10 MB cada, somando 20 MB por envio. Cada conta armazena até 50 MB em arquivos das bases (`LIMITE_ARMAZENAMENTO_MB`), visível em Minha conta. Documento remoto de até 10 MB, até 5 milhões de caracteres por extração, 10.000 documentos/fragmentos por fonte e 10.000 fragmentos por base. Fontes remotas com limite aceitam de 1 a 100 documentos e avisam quando pode haver conteúdo adicional.
- Fragmentos de 100 a 8.000 caracteres; sobreposição menor que o tamanho. Busca de até 20.000 caracteres, com 1 a 20 resultados e pontuação mínima entre -1 e 1.
- Cada extração/indexação tem limite de 10 minutos. Uma trava persistente impede operações concorrentes na mesma base; a expiração em 15 minutos permite recuperar um processo interrompido. O índice novo só substitui o anterior depois de completo.
- Falhas de serviços aparecem na fonte ou no histórico. Credenciais e corpos de erro de provedores não entram nessas mensagens. Não há retorno silencioso a uma busca por palavras quando embeddings falham.
- Excluir uma fonte remove seus vetores locais e do serviço configurado; a base fica pendente de indexação. Excluir uma base vinculada a um Agente ou LLM é recusado, com orientação para remover o vínculo.
- Índices anteriores são removidos após a troca. Limpeza que falhou fica registrada e pode ser repetida pela interface. A limpeza processa até cinco gerações por tentativa. Os índices antigos nunca entram na consulta ativa.
- Fontes HTTP exigem endereços públicos e fixam a conexão no endereço DNS validado. Servidores de embeddings e bancos vetoriais configurados pelo usuário podem usar rede privada, para instalações locais. Ao mudar de serviço, a credencial anterior não é encaminhada ao novo endereço.

## Contratos e verificação

Os testes em `lib/knowledge.test.ts` exercitam arquivos PDF, DOCX, XLSX e PPTX reais, CSV/JSON/texto, fragmentação, metadados, criptografia, isolamento, travas, falhas, reindexação, exclusão e recuperação. Os provedores externos são testados com respostas controladas, incluindo os contratos HTTP OpenAI, Ollama e Qdrant, conectores cloud, SDK S3, sandbox E2B e RAG com ChatGPT/OpenRouter. Não consomem credenciais nem serviços pagos reais.

Contratos de referência: [embeddings OpenAI](https://developers.openai.com/api/docs/guides/embeddings), [Ollama embed](https://docs.ollama.com/api/embed), [Firecrawl scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape) e implementação local do [Document Store Flowise](https://github.com/FlowiseAI/Flowise/tree/main/packages/ui/src/views/docstore).

Validação visual: biblioteca, catálogo dos 20 extratores, extração e revisão, configuração nas três etapas, indexação, consulta, histórico, edição/reindexação e seleção no Agente; desktop, 390 px e tema escuro. Os artefatos temporários da verificação ficam fora do repositório.

## Fontes e credenciais na versão 0.13.0

Arraste arquivos para a área de upload ou clique nela para selecionar. O nome da fonte usa o primeiro arquivo, incluindo a extensão; os demais arquivos continuam identificados na lista e nos metadados. **Extrair e revisar** salva os campos e inicia a extração. **Revisar** abre o modal amplo com busca, edição e exclusão dos trechos. **Reextrair** exibe progresso enquanto processa.

Em Embeddings, selecione ou crie uma conexão do menu **Credenciais**. As chaves existentes são migradas sem alteração da revisão da base. Editar a chave atualiza o acesso das bases vinculadas; alterar o endereço requer reaplicar a conexão e reindexar. O app impede excluir credenciais em uso. Ollama pode funcionar sem autenticação. Consulte [os quatro provedores, onze bancos e recursos atuais](KNOWLEDGE-FLOWISE.md).

## Refinamentos da versão 0.14.0

- **Busca:** configure Top K (1–20, padrão 4) e similaridade mínima (-1 a 1). Faiss e Postgres aceitam um filtro JSON de igualdade por propriedades, incluindo objetos aninhados: `{"area":"suporte","origem":{"idioma":"pt"}}`. Todos os campos precisam corresponder. Sem operadores, listas ou variáveis. O filtro é aplicado antes do Top K.
- **Faiss:** o armazenamento é administrado pelo app, com uma pasta por base e versão. Desde a versão 0.14.1, o caminho não aparece como campo na interface. Não há importação de índices externos do Flowise.
- **Postgres:** escolha conexão por host/banco/porta/SSL e credencial reutilizável, ou mantenha uma string de conexão cifrada. A credencial PostgreSQL contém usuário e senha, pode ser criada/editada na própria etapa ou em Credenciais e serve também ao Record Manager. SSL usa validação do certificado; cadeias privadas podem ser fornecidas pela configuração de confiança do servidor Node.
- **Tabelas:** o prefixo opcional (até 22 caracteres) recebe um sufixo de base/geração. O app não reutiliza tabelas existentes do Flowise. Schema deve existir; extensão pgvector e permissão para criar/remover tabelas são necessárias. Coluna de conteúdo padrão `content`; lote padrão 100, configurável de 1 a 1.000. Tempos limite de conexão e consulta são configuráveis nos campos de conexão.
- **Ranking Postgres:** cosseno, distância euclidiana e produto interno definem a ordem. A pontuação exibida e o limiar continuam em similaridade de cosseno; portanto a pontuação pode não aparecer em ordem decrescente quando outra estratégia está selecionada.
- **Embeddings OpenAI:** dimensões opcionais entre 1 e o tamanho original em text-embedding-3-small/large; float ou base64 no transporte. Base64 é convertido em vetores numéricos antes da indexação. Trocar dimensões requer reindexar e impede reutilização incompatível. O SQL gerado para Supabase usa a dimensão escolhida.
