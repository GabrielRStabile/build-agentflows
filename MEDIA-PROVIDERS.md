# Geração de mídia por usuário

Em **Configurações → Geração de imagens**, salve a chave da sua conta na Replicate,
Higgsfield ou MuAPI. Higgsfield recebe a credencial completa, incluindo `ID:segredo`
quando fornecido. Salvar a chave não valida seu saldo nem gera uma cobrança.
As chaves ficam cifradas no PostgreSQL com o proprietário vinculado à cifragem;
não há chave global de ambiente para esses provedores.

| Provedor | Bloco | Modelo | Entrada | Saída |
| --- | --- | --- | --- | --- |
| Replicate | LLM | Campo aberto `empresa/modelo` (ex.: `google/nano-banana`) | Texto e, se o modelo aceitar, imagens | Texto, imagens ou vídeo |
| Higgsfield | Agente ou LLM | `higgsfield-ai/soul/v2/standard` (Soul 2) | Texto | Imagem |
| MuAPI | Agente ou LLM | `nano-banana-2` | Texto | Imagem |

### Replicate

No bloco **LLM**, escolha Replicate e digite o nome do modelo como aparece na
Replicate, em letras minúsculas. A Replicate não aparece na lista do **Agente**,
que depende de ferramentas e de um modelo de texto; agentes salvos antes com
Nano Banana continuam funcionando. O nome é validado ao fechar o bloco.

Antes de qualquer cobrança, a execução lê o modelo em `GET /v1/models/{empresa}/{modelo}`
(gratuito). Um nome inexistente falha nesse passo. O schema de entrada define os campos:

- a descrição vai em `prompt` (ou `text`, `input`, `message`, `question`);
- as instruções vão em `system_prompt` quando o modelo tem esse campo; senão, antecedem a descrição;
- imagens anexadas vão no primeiro campo de imagem reconhecido (`image_input`,
  `input_images`, `images`, `reference_images`, `image`, `input_image`, `image_url`,
  `start_image`, `first_frame_image`); um campo único recebe só uma imagem;
- `output_format` é `png` quando o modelo oferece essa opção.

Modelos sem campo de texto, ou que não recebem imagens quando há anexos, são
recusados antes do envio. Outros parâmetros ficam no padrão do modelo.

A solicitação usa `POST /v1/predictions` com `version: empresa/modelo`, forma dos
modelos oficiais. Se a Replicate recusar com 404 ou 422 (nenhuma solicitação criada),
ela é refeita uma vez com `empresa/modelo:versão`, forma exigida para modelos da
comunidade. Respostas incertas continuam sem reenvio.

O schema de saída define o resultado: URLs viram arquivos privados (PNG/JPEG/WebP
ou vídeo MP4/WebM, validados pelos bytes); listas de texto são concatenadas; objetos
viram um bloco JSON. Imagens e vídeos aparecem no chat e no histórico (vídeo com
player e suporte a `Range`), cada um com o link "Abrir em nova aba"; no chat
incorporado há botão de download.

### Imagens de entrada

Soul 2 e Nano Banana 2 nesta integração não recebem imagens de entrada. Para editar
uma imagem, use um modelo da Replicate que receba imagens e anexe-a à conversa.
Até cinco referências e 6 MB combinados são enviados como data URIs; os arquivos
continuam privados na aplicação. O provedor selecionado recebe o prompt e as
referências para processar a geração, conforme sua política de retenção.

As instruções, a mensagem da etapa e o texto dos documentos anexados formam a
descrição, limitada a 20 mil caracteres. A memória pode usar todas as mensagens
ou uma janela recente; modelos de mídia não resumem memória, executam ferramentas
ou consultam bases. Prepare a descrição em um bloco de texto anterior quando
precisar dessas capacidades. A aplicação rejeita configurações incompatíveis
antes de executar. Não é necessário conectar ChatGPT para um fluxo que só usa
esses modelos; fluxos mistos exigem as conexões selecionadas em cada bloco.

## Resultados e limites

A execução passa pela mesma fila: uma tarefa ativa por usuário e duas globais,
compartilhadas com fluxos, extração e indexação. Fluxos com um modelo de mídia têm
até 10 minutos (`MEDIA_RUN_MS`), incluindo as demais etapas, para comportar vídeos
de 4 a 5 minutos; os demais fluxos mantêm três minutos. A Replicate recebe
`Cancel-After: 10m`. O chat incorporado usa o limite configurado (até 15 minutos) e
o worker encerra qualquer tarefa após 15 minutos. O worker registra o identificador da
solicitação antes de consultar seu resultado. O chat e o histórico exibem esse
identificador para consulta no painel do provedor.

Imagens e vídeos prontos são baixados no servidor, validados e salvos como anexos
privados do fluxo; envios de usuário continuam sem aceitar vídeos. A saída é Markdown com `/api/attachments/{id}`, visível no chat e no
histórico com a sessão do dono. Links temporários do provedor não são usados como
armazenamento. Cada arquivo tem até 10 MB, PNG/JPEG/WebP estático e 40 megapixels;
uma resposta aceita até cinco arquivos e 20 MB. O armazenamento compartilha a cota
de 100 MB ou 2.000 anexos por usuário. Remover o fluxo libera os arquivos.

`{{last}}` e `{{nodes.id}}` passam o Markdown aos blocos seguintes. Eles não
transformam automaticamente esse link em uma nova imagem de entrada; para outra
edição, baixe e anexe o resultado à mensagem. No chat incorporado, o download
exige ticket e vínculo com a conversa que gerou a imagem; veja
[EMBED-TENANTS.md](EMBED-TENANTS.md). MCP/webhook de fluxos retornam o Markdown;
baixar a URL privada exige a sessão do dono. Os canais WhatsApp/ElevenLabs ainda
não recebem acesso aos anexos privados.

Não há repetição automática de submissões após resposta incerta. Cancelar
interrompe o acompanhamento local e tenta cancelar na Replicate/Higgsfield.
Higgsfield só aceita cancelamento enquanto aguarda na fila. MuAPI não documenta
cancelamento público para esses endpoints. Em caso de interrupção, a tarefa
externa pode continuar e ser cobrada: consulte o identificador no painel antes
de repetir. Uma queda do worker segue a política da fila, sem repetir efeitos
externos. Gravações após perda da autorização do job são recusadas.

Chamadas autenticadas usam origens fixas e não seguem redirecionamentos. URLs de
resultado precisam ser HTTPS; o download bloqueia endereços privados, fixa a
resolução DNS, limita bytes e verifica redirecionamentos. A chave Replicate só
acompanha downloads de `replicate.delivery` e seus subdomínios. As outras chaves
nunca são encaminhadas a URLs de resultado.

## Validação e contratos

`lib/media-provider.test.ts` usa respostas controladas para os três contratos:
autenticação, envio, polling, imagem de referência, falhas, cancelamento, respostas
inválidas, limites e submissão única. `lib/saas-media.test.ts` integra o adaptador
com sessão, credencial cifrada, persistência, download HTTP por proprietário e
recusa de worker sem autorização. A suíte roda em PGlite e PostgreSQL servidor.
`npm run test:docker` verifica também credenciais e anexos privados após recriar
os containers. Não foram usadas chaves reais de serviços pagos; disponibilidade,
saldo e geração real nessas contas permanecem sem confirmação.

Contratos oficiais consultados em 29/09/2026 (Replicate revisada em 13/10/2026):

- [Replicate HTTP API](https://replicate.com/docs/reference/http), [execução de todos os modelos por `/v1/predictions`](https://replicate.com/changelog/2025-08-05-run-all-models-with-the-same-api-endpoint), [Nano Banana](https://replicate.com/google/nano-banana/api/schema), [arquivos de entrada](https://replicate.com/docs/topics/predictions/input-files) e [saídas](https://replicate.com/docs/topics/predictions/output-files).
- [Higgsfield Soul 2](https://open.higgsfield.ai/models/higgsfield-ai/soul/v2/standard/api-reference) e [ciclo da solicitação](https://docs.higgsfield.ai/docs/concepts/requests).
- [MuAPI HTTP API](https://muapi.ai/docs/api-reference) e [OpenAPI](https://api.muapi.ai/openapi.json).
