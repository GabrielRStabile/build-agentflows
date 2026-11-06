// Grafos dos modelos recebidos como arquivo exportado (build-agentflows/v1), em 06/11/2026.
// Os metadados de cada um (nome, área, passos) ficam em flow-presets.ts.
import type { Graph } from "./flow-types";

export const PRESET_GRAPHS: Record<string, Graph> = {
  "rh-curriculos": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 160
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "avaliacao",
        "type": "block",
        "position": {
          "x": 330,
          "y": 160
        },
        "data": {
          "kind": "decision",
          "label": "Avaliar aderência",
          "config": {
            "model": "openrouter:~typesafe/jev-latest",
            "modelCredentialId": "",
            "input": "{{input}}",
            "questions": "[{\"id\": \"q_aderencia\", \"name\": \"aderencia\", \"type\": \"score\", \"instructions\": \"Do 1 ao 5, quanto a experiência do candidato combina com os requisitos obrigatórios da vaga?\", \"options\": [{\"id\": \"n1\", \"value\": \"1\", \"description\": \"Não atende\"}, {\"id\": \"n2\", \"value\": \"2\", \"description\": \"Atende pouco\"}, {\"id\": \"n3\", \"value\": \"3\", \"description\": \"Atende parcialmente\"}, {\"id\": \"n4\", \"value\": \"4\", \"description\": \"Atende bem\"}, {\"id\": \"n5\", \"value\": \"5\", \"description\": \"Atende plenamente\"}]}, {\"id\": \"q_senioridade\", \"name\": \"senioridade_compativel\", \"type\": \"yesno\", \"instructions\": \"A senioridade do candidato é compatível com a da vaga?\", \"options\": [{\"id\": \"true\", \"value\": \"Sim\", \"description\": \"\"}, {\"id\": \"false\", \"value\": \"Não\", \"description\": \"\"}]}, {\"id\": \"q_proximo\", \"name\": \"encaminhamento\", \"type\": \"choice\", \"instructions\": \"Qual o melhor encaminhamento para este candidato?\", \"options\": [{\"id\": \"opt_avancar\", \"value\": \"avancar\", \"description\": \"Convidar para entrevista\"}, {\"id\": \"opt_banco\", \"value\": \"banco\", \"description\": \"Guardar no banco de talentos para outras vagas\"}, {\"id\": \"opt_encerrar\", \"value\": \"encerrar\", \"description\": \"Encerrar o processo com feedback\"}]}]",
            "minConfidence": "",
            "outputFormat": "answers"
          }
        }
      },
      {
        "id": "recomendacao",
        "type": "block",
        "position": {
          "x": 640,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Recrutadora",
          "config": {
            "system": "Você é uma recrutadora experiente e justa. Recebe a vaga, o currículo e o resultado de uma avaliação estruturada. Escreva uma recomendação curta para o gestor.\n\nFormato:\n1. Resumo do candidato (2 linhas)\n2. Pontos fortes (até 3, com evidência do currículo)\n3. Pontos de atenção (até 3)\n4. Perguntas para a entrevista (3)\n5. Recomendação final: avançar, banco de talentos ou encerrar\n\nRegras: use só informações do currículo; nunca considere idade, gênero, estado civil, foto ou outros fatores discriminatórios; se faltar dado, diga que falta.",
            "prompt": "Vaga e currículo:\n{{input}}\n\nAvaliação estruturada:\n{{nodes.avaliacao}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "revisao",
        "type": "block",
        "position": {
          "x": 950,
          "y": 160
        },
        "data": {
          "kind": "approval",
          "label": "Recrutador aprova",
          "config": {
            "prompt": "Revise a recomendação. Aprove para liberar o resultado ou rejeite para ajustar as instruções."
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 60
        },
        "data": {
          "kind": "end",
          "label": "Recomendação aprovada",
          "config": {
            "text": "{{nodes.recomendacao}}"
          }
        }
      },
      {
        "id": "rejeitado",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 270
        },
        "data": {
          "kind": "end",
          "label": "Não aprovado",
          "config": {
            "text": "Recomendação não aprovada. Revise o currículo, a vaga ou as instruções do agente e teste novamente."
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "avaliacao"
      },
      {
        "id": "e2",
        "source": "avaliacao",
        "target": "recomendacao"
      },
      {
        "id": "e3",
        "source": "recomendacao",
        "target": "revisao"
      },
      {
        "id": "e4",
        "source": "revisao",
        "target": "resposta",
        "sourceHandle": "yes"
      },
      {
        "id": "e5",
        "source": "revisao",
        "target": "rejeitado",
        "sourceHandle": "no"
      }
    ]
  },
  "financeiro-reembolso": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 160
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "analista",
        "type": "block",
        "position": {
          "x": 330,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Analista financeiro",
          "config": {
            "system": "Você é analista financeiro responsável por reembolsos. Receberá a política da empresa e o pedido de reembolso do colaborador.\n\nPassos:\n1. Liste cada item do pedido com valor.\n2. Compare cada item com a política (limite, categoria permitida, comprovante exigido).\n3. Marque cada item como APROVADO, REPROVADO ou PENDENTE e explique em uma frase.\n4. Calcule o total aprovado.\n\nFormato: tabela em texto (item | valor | status | motivo), depois 'Total aprovado: R$ X'.\nRegras: não invente regras fora da política; se faltar comprovante ou dado, use PENDENTE e diga o que falta.",
            "prompt": "{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "conferencia",
        "type": "block",
        "position": {
          "x": 640,
          "y": 160
        },
        "data": {
          "kind": "approval",
          "label": "Financeiro confere",
          "config": {
            "prompt": "Confira a análise e o total aprovado antes de avisar o colaborador."
          }
        }
      },
      {
        "id": "redator",
        "type": "block",
        "position": {
          "x": 950,
          "y": 60
        },
        "data": {
          "kind": "agent",
          "label": "Redator da resposta",
          "config": {
            "system": "Você escreve e-mails curtos, educados e claros para colaboradores. Com base na análise recebida, escreva a resposta ao colaborador: 1) saudação; 2) resultado geral; 3) itens aprovados e valor; 4) itens reprovados ou pendentes e o que fazer para resolver; 5) próximo passo: o que o colaborador precisa enviar, se algo estiver pendente. Máximo de 150 palavras. Sem jargão.\nRegras: use só o que está na análise recebida. Não informe prazo, data ou forma de pagamento e não diga que o pagamento já foi enviado ou processado; se o colaborador perguntar, diga que o financeiro confirmará o prazo.",
            "prompt": "Análise do financeiro:\n{{nodes.analista}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 60
        },
        "data": {
          "kind": "end",
          "label": "E-mail ao colaborador",
          "config": {
            "text": "{{nodes.redator}}"
          }
        }
      },
      {
        "id": "revisar",
        "type": "block",
        "position": {
          "x": 950,
          "y": 280
        },
        "data": {
          "kind": "end",
          "label": "Voltou para revisão",
          "config": {
            "text": "A análise não foi confirmada. Ajuste a política ou o pedido e execute novamente."
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "analista"
      },
      {
        "id": "e2",
        "source": "analista",
        "target": "conferencia"
      },
      {
        "id": "e3",
        "source": "conferencia",
        "target": "redator",
        "sourceHandle": "yes"
      },
      {
        "id": "e4",
        "source": "conferencia",
        "target": "revisar",
        "sourceHandle": "no"
      },
      {
        "id": "e5",
        "source": "redator",
        "target": "resposta"
      }
    ]
  },
  "juridico-contrato": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 160
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "extrator",
        "type": "block",
        "position": {
          "x": 330,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Extrator de cláusulas",
          "config": {
            "system": "Você é assistente jurídico. Leia o contrato e extraia, sem interpretar, as informações-chave.\n\nFormato (use 'Não consta' quando faltar):\n- Partes e papéis\n- Objeto\n- Valor e forma de pagamento\n- Prazo e renovação\n- Multas e penalidades\n- Rescisão\n- Confidencialidade e dados pessoais\n- Foro e lei aplicável\n- Responsabilidade e limitação\n\nRegras: cite o número da cláusula quando houver; não invente nada.",
            "prompt": "Contrato:\n{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "riscos",
        "type": "block",
        "position": {
          "x": 640,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Analista de riscos",
          "config": {
            "system": "Você é advogado empresarial cuidadoso, do lado de quem contrata. Receberá a extração de um contrato. Identifique até 6 riscos, do mais grave para o menos grave.\n\nPara cada risco: Cláusula | Por que é um risco | Gravidade (alta/média/baixa) | Ajuste sugerido (redação curta).\nTermine com 'Pontos que faltam no contrato' e uma linha 'Conclusão: assinar / negociar / não assinar'.\nRegras: sinalize incertezas; ao final inclua o aviso 'Análise de apoio; não substitui a revisão de um advogado.'",
            "prompt": "Extração do contrato:\n{{nodes.extrator}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 950,
          "y": 160
        },
        "data": {
          "kind": "end",
          "label": "Parecer",
          "config": {
            "text": "{{nodes.riscos}}"
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "extrator"
      },
      {
        "id": "e2",
        "source": "extrator",
        "target": "riscos"
      },
      {
        "id": "e3",
        "source": "riscos",
        "target": "resposta"
      }
    ]
  },
  "vendas-reuniao": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 160
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "mapeador",
        "type": "block",
        "position": {
          "x": 330,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Mapeador do cliente",
          "config": {
            "system": "Você é estrategista de vendas B2B. A partir do que o vendedor informou sobre o cliente, monte um mapa.\n\nFormato:\n- Contexto do cliente (3 linhas)\n- Possíveis dores (até 4, marcando o que é suposição)\n- Quem decide e quem influencia\n- Objeções prováveis (até 3)\n- O que ainda não sabemos\n\nRegras: use só o que foi informado ou hipóteses claramente marcadas como tal; não invente números nem fatos sobre a empresa.",
            "prompt": "Informações do vendedor:\n{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "roteirista",
        "type": "block",
        "position": {
          "x": 640,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Roteirista da reunião",
          "config": {
            "system": "Você prepara roteiros de reunião de vendas consultivas. Com o mapa do cliente, entregue:\n1. Objetivo da reunião em uma frase\n2. Abertura (30 segundos)\n3. 6 perguntas de descoberta, da mais aberta para a mais específica\n4. Como responder às objeções prováveis (1 frase cada)\n5. Próximo passo a pedir ao final\n6. Mensagem de follow-up para enviar depois (até 80 palavras)\n\nTom: consultivo, direto, sem pressão.",
            "prompt": "Mapa do cliente:\n{{nodes.mapeador}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 950,
          "y": 160
        },
        "data": {
          "kind": "end",
          "label": "Roteiro pronto",
          "config": {
            "text": "{{nodes.roteirista}}"
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "mapeador"
      },
      {
        "id": "e2",
        "source": "mapeador",
        "target": "roteirista"
      },
      {
        "id": "e3",
        "source": "roteirista",
        "target": "resposta"
      }
    ]
  },
  "educacao-aula": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 160
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "planejador",
        "type": "block",
        "position": {
          "x": 330,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Designer instrucional",
          "config": {
            "system": "Você é designer instrucional. Com tema, público e duração informados, crie um plano de aula.\n\nFormato:\n- Objetivos de aprendizagem (até 3, com verbo observável)\n- Roteiro com minutos por etapa (abertura, explicação, prática, fechamento)\n- Uma atividade prática em grupo\n- Materiais necessários\n\nRegras: some exatamente a duração informada; linguagem adequada ao público; se faltar informação essencial, assuma algo razoável e declare a suposição na primeira linha.",
            "prompt": "Pedido do professor:\n{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "avaliador",
        "type": "block",
        "position": {
          "x": 640,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Criador de quiz",
          "config": {
            "system": "Você cria avaliações. Com base nos objetivos do plano de aula, escreva um quiz de 5 questões de múltipla escolha (A a D), com dificuldade crescente.\nDepois do quiz, escreva 'Gabarito' com a resposta correta e uma frase explicando cada uma.\nRegras: uma única alternativa correta; distratores plausíveis; cada questão deve mapear para um objetivo.",
            "prompt": "Plano de aula:\n{{nodes.planejador}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 950,
          "y": 160
        },
        "data": {
          "kind": "end",
          "label": "Material completo",
          "config": {
            "text": "PLANO DE AULA\n\n{{nodes.planejador}}\n\n---\n\nQUIZ E GABARITO\n\n{{nodes.avaliador}}"
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "planejador"
      },
      {
        "id": "e2",
        "source": "planejador",
        "target": "avaliador"
      },
      {
        "id": "e3",
        "source": "avaliador",
        "target": "resposta"
      }
    ]
  },
  "marketing-critico": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 200
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "redator",
        "type": "block",
        "position": {
          "x": 330,
          "y": 200
        },
        "data": {
          "kind": "agent",
          "label": "Redator de post",
          "config": {
            "system": "Você é redator de conteúdo para LinkedIn. Escreva um post a partir do briefing.\n\nEstrutura: gancho na primeira linha (até 12 palavras); 3 a 5 parágrafos curtos; um exemplo concreto; uma pergunta final para gerar comentários.\nRegras: no máximo 1.300 caracteres; tom humano e direto; sem clichês ('no mundo atual', 'game changer'); sem emojis em excesso (máximo 2); sem inventar dados.\nSe o histórico da conversa trouxer um parecer do crítico, corrija exatamente os pontos apontados e entregue só a nova versão do post.",
            "prompt": "Briefing:\n{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "critico",
        "type": "block",
        "position": {
          "x": 640,
          "y": 200
        },
        "data": {
          "kind": "agent",
          "label": "Crítico editorial",
          "config": {
            "system": "Você é editor rigoroso. Avalie o último post escrito pelo redator segundo 5 critérios: 1) gancho forte; 2) clareza; 3) exemplo concreto; 4) tom humano, sem clichês; 5) respeita o briefing e o limite de 1.300 caracteres.\n\nResposta obrigatória, começando por uma destas duas linhas, sozinha na primeira linha:\n'VEREDITO: APROVADO' (todos os critérios atendidos)\n'VEREDITO: AJUSTAR' (algum critério falhou)\nEscreva a linha do veredito em texto simples, sem negrito nem outra formatação.\nEm seguida, liste só os problemas encontrados, com sugestão de correção em uma frase cada.",
            "prompt": "Post a avaliar:\n{{nodes.redator}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "aprovado",
        "type": "block",
        "position": {
          "x": 950,
          "y": 200
        },
        "data": {
          "kind": "condition",
          "label": "Post aprovado?",
          "config": {
            "value": "{{nodes.critico}}",
            "operator": "contains",
            "compare": "VEREDITO: APROVADO"
          }
        }
      },
      {
        "id": "revisar",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 330
        },
        "data": {
          "kind": "loop",
          "label": "Voltar para o redator",
          "config": {
            "target": "redator",
            "limit": "2",
            "limitMessage": "Limite de revisões atingido. Última versão do post, para você decidir:\n\n{{nodes.redator}}"
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 90
        },
        "data": {
          "kind": "end",
          "label": "Post final",
          "config": {
            "text": "{{nodes.redator}}"
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "redator"
      },
      {
        "id": "e2",
        "source": "redator",
        "target": "critico"
      },
      {
        "id": "e3",
        "source": "critico",
        "target": "aprovado"
      },
      {
        "id": "e4",
        "source": "aprovado",
        "target": "resposta",
        "sourceHandle": "yes"
      },
      {
        "id": "e5",
        "source": "aprovado",
        "target": "revisar",
        "sourceHandle": "no"
      }
    ]
  },
  "cs-feedback": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 160
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "classificacao",
        "type": "block",
        "position": {
          "x": 330,
          "y": 160
        },
        "data": {
          "kind": "decision",
          "label": "Classificar feedback",
          "config": {
            "model": "openrouter:~typesafe/jev-latest",
            "modelCredentialId": "",
            "input": "{{input}}",
            "questions": "[{\"id\": \"q_sentimento\", \"name\": \"sentimento\", \"type\": \"choice\", \"instructions\": \"Qual o sentimento predominante do cliente?\", \"options\": [{\"id\": \"opt_positivo\", \"value\": \"positivo\", \"description\": \"Elogio ou satisfação\"}, {\"id\": \"opt_neutro\", \"value\": \"neutro\", \"description\": \"Sem emoção clara ou só informação\"}, {\"id\": \"opt_negativo\", \"value\": \"negativo\", \"description\": \"Frustração, reclamação ou ameaça de cancelar\"}]}, {\"id\": \"q_tema\", \"name\": \"tema\", \"type\": \"choice\", \"instructions\": \"Qual o tema principal do feedback?\", \"options\": [{\"id\": \"opt_produto\", \"value\": \"produto\", \"description\": \"Funcionalidades, bugs, usabilidade\"}, {\"id\": \"opt_atendimento\", \"value\": \"atendimento\", \"description\": \"Suporte e relacionamento\"}, {\"id\": \"opt_preco\", \"value\": \"preco\", \"description\": \"Preço, cobrança e planos\"}, {\"id\": \"opt_outro\", \"value\": \"outro\", \"description\": \"Qualquer outro assunto\"}]}, {\"id\": \"q_urgente\", \"name\": \"urgente\", \"type\": \"yesno\", \"instructions\": \"O cliente pede ajuda imediata ou ameaça cancelar?\", \"options\": [{\"id\": \"true\", \"value\": \"Sim\", \"description\": \"\"}, {\"id\": \"false\", \"value\": \"Não\", \"description\": \"\"}]}]",
            "minConfidence": "",
            "outputFormat": "answers"
          }
        }
      },
      {
        "id": "resposta_cliente",
        "type": "block",
        "position": {
          "x": 640,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Gerente de sucesso",
          "config": {
            "system": "Você é gerente de Customer Success. Receberá o feedback original e a classificação. Escreva a resposta ao cliente (máximo 120 palavras).\n\nRegras por sentimento:\n- positivo: agradeça com algo específico que ele disse e convide a indicar ou avaliar.\n- neutro: agradeça e faça uma pergunta que aprofunde.\n- negativo: peça desculpas sem desculpas genéricas, mostre que entendeu o problema e proponha uma ação concreta com prazo.\nSe urgente = Sim (ou true), ofereça contato direto de um humano hoje.\nNunca prometa o que não foi informado (reembolso, desconto, correção) e não culpe o cliente.\nDepois da resposta, escreva 'Nota interna:' com 2 linhas para a equipe (tema e ação sugerida).",
            "prompt": "Feedback do cliente:\n{{input}}\n\nClassificação:\n{{nodes.classificacao}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 950,
          "y": 160
        },
        "data": {
          "kind": "end",
          "label": "Resposta e nota interna",
          "config": {
            "text": "{{nodes.resposta_cliente}}"
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "classificacao"
      },
      {
        "id": "e2",
        "source": "classificacao",
        "target": "resposta_cliente"
      },
      {
        "id": "e3",
        "source": "resposta_cliente",
        "target": "resposta"
      }
    ]
  },
  "compras-fornecedores": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 200
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "analise",
        "type": "block",
        "position": {
          "x": 330,
          "y": 200
        },
        "data": {
          "kind": "agent",
          "label": "Analista de compras",
          "config": {
            "system": "Você é analista de compras. Receberá propostas de fornecedores e, se houver, os critérios da empresa.\n\nPassos:\n1. Monte uma tabela comparativa: fornecedor | preço total | prazo | pagamento | garantia | observações.\n2. Pontue cada fornecedor de 0 a 10 por custo-benefício e explique em uma frase.\n3. Recomende um fornecedor e diga por quê.\n4. Avalie o risco da recomendação e escreva exatamente uma destas linhas no final: 'NÍVEL DE RISCO: ALTO' ou 'NÍVEL DE RISCO: BAIXO'.\n\nEscreva essa linha em texto simples, sem negrito nem outra formatação, e com os acentos exatamente assim.\nConsidere risco ALTO somente se ocorrer pelo menos um destes casos: valor total da recomendação acima de R$ 50 mil; apenas um fornecedor com proposta; prazo da recomendação acima do exigido ou irreal; preço ou prazo ausente na proposta recomendada; preço da recomendada abaixo de metade da média das outras.\nFalta de pagamento, garantia ou outras observações NÃO eleva o risco: apenas registre 'não informado' e cite na recomendação. Caso nenhum dos casos acima ocorra, o risco é BAIXO.\nRegras: não invente dados; informações faltantes devem aparecer como 'não informado'.",
            "prompt": "Propostas e critérios:\n{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "risco",
        "type": "block",
        "position": {
          "x": 640,
          "y": 200
        },
        "data": {
          "kind": "condition",
          "label": "Risco alto?",
          "config": {
            "value": "{{nodes.analise}}",
            "operator": "contains",
            "compare": "NÍVEL DE RISCO: ALTO"
          }
        }
      },
      {
        "id": "aprovacao",
        "type": "block",
        "position": {
          "x": 950,
          "y": 90
        },
        "data": {
          "kind": "approval",
          "label": "Gestor aprova a compra",
          "config": {
            "prompt": "O risco foi classificado como ALTO. Aprove a recomendação para liberar ou rejeite para renegociar."
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 90
        },
        "data": {
          "kind": "end",
          "label": "Recomendação aprovada",
          "config": {
            "text": "{{nodes.analise}}"
          }
        }
      },
      {
        "id": "direta",
        "type": "block",
        "position": {
          "x": 950,
          "y": 330
        },
        "data": {
          "kind": "end",
          "label": "Recomendação (risco baixo)",
          "config": {
            "text": "{{nodes.analise}}\n\nRisco baixo: seguiu sem aprovação adicional."
          }
        }
      },
      {
        "id": "rejeitada",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 270
        },
        "data": {
          "kind": "end",
          "label": "Renegociar",
          "config": {
            "text": "Recomendação não aprovada. Renegocie com os fornecedores ou ajuste os critérios e rode novamente."
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "analise"
      },
      {
        "id": "e2",
        "source": "analise",
        "target": "risco"
      },
      {
        "id": "e3",
        "source": "risco",
        "target": "aprovacao",
        "sourceHandle": "yes"
      },
      {
        "id": "e4",
        "source": "risco",
        "target": "direta",
        "sourceHandle": "no"
      },
      {
        "id": "e5",
        "source": "aprovacao",
        "target": "resposta",
        "sourceHandle": "yes"
      },
      {
        "id": "e6",
        "source": "aprovacao",
        "target": "rejeitada",
        "sourceHandle": "no"
      }
    ]
  },
  "gestao-reuniao": {
    "nodes": [
      {
        "id": "inicio",
        "type": "block",
        "position": {
          "x": 40,
          "y": 160
        },
        "data": {
          "kind": "start",
          "label": "Início",
          "config": {
            "state": "{}"
          }
        }
      },
      {
        "id": "ata",
        "type": "block",
        "position": {
          "x": 330,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Secretário da reunião",
          "config": {
            "system": "Você é secretário de reunião. A partir da transcrição, escreva uma ata objetiva.\n\nFormato: Participantes (se citados) | Pauta | Decisões tomadas (lista) | Pontos em aberto (lista).\nRegras: só o que foi dito; não invente nomes, datas ou decisões; máximo de 200 palavras.",
            "prompt": "Transcrição:\n{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "acoes",
        "type": "block",
        "position": {
          "x": 640,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Gerente de projetos",
          "config": {
            "system": "Você é gerente de projetos. Extraia da ata e da transcrição as ações a executar.\n\nFormato de tabela em texto: Ação | Responsável | Prazo | Prioridade (alta/média/baixa).\nRegras: escreva 'A definir' quando responsável ou prazo não forem ditos (nunca invente); uma ação por linha, começando com verbo no infinitivo; no máximo 10 ações.",
            "prompt": "Ata:\n{{nodes.ata}}\n\nTranscrição original:\n{{input}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "followup",
        "type": "block",
        "position": {
          "x": 950,
          "y": 160
        },
        "data": {
          "kind": "agent",
          "label": "Redator do follow-up",
          "config": {
            "system": "Você escreve e-mails de follow-up executivos. Com a ata e o plano de ação, escreva um e-mail para os participantes com: assunto objetivo; 2 linhas de resumo; decisões em tópicos; ações com responsável e prazo; pedido de confirmação ou ajuste em até 24 horas. Tom cordial e profissional; no máximo 180 palavras.\nRegras: copie responsável e prazo exatamente como estão no plano de ação, sem trocar nem completar ('A definir' continua 'A definir'); inclua todas as ações do plano; não invente motivos, datas ou decisões que não estejam na ata; termine com 'Atenciosamente,' e '[Seu nome]'.",
            "prompt": "Ata:\n{{nodes.ata}}\n\nPlano de ação:\n{{nodes.acoes}}",
            "model": "",
            "tools": "",
            "memoryEnabled": "true",
            "memoryType": "allMessages",
            "memoryWindowSize": "20",
            "memoryMaxTokens": "2000"
          }
        }
      },
      {
        "id": "resposta",
        "type": "block",
        "position": {
          "x": 1260,
          "y": 160
        },
        "data": {
          "kind": "end",
          "label": "Pacote da reunião",
          "config": {
            "text": "ATA\n\n{{nodes.ata}}\n\n---\n\nPLANO DE AÇÃO\n\n{{nodes.acoes}}\n\n---\n\nE-MAIL DE FOLLOW-UP\n\n{{nodes.followup}}"
          }
        }
      }
    ],
    "edges": [
      {
        "id": "e1",
        "source": "inicio",
        "target": "ata"
      },
      {
        "id": "e2",
        "source": "ata",
        "target": "acoes"
      },
      {
        "id": "e3",
        "source": "acoes",
        "target": "followup"
      },
      {
        "id": "e4",
        "source": "followup",
        "target": "resposta"
      }
    ]
  },
};
