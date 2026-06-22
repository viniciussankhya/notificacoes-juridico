// ============================================================
// MÓDULO 3 — Central de Notificações Extrajudiciais
// Sankhya S.A. — Departamento Jurídico
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Busboy = require('busboy');

const PORT = process.env.PORT || 3003;

const DADOS_DIR = path.join(__dirname, 'dados');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLICO_DIR = path.join(__dirname, 'publico');
const REGISTROS_FILE = path.join(DADOS_DIR, 'registros.json');

[DADOS_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

if (!fs.existsSync(REGISTROS_FILE)) {
  fs.writeFileSync(REGISTROS_FILE, JSON.stringify([]));
}

// Banco de exemplos aprovados pelo jurídico
const EXEMPLOS_FILE = path.join(DADOS_DIR, 'exemplos_aprovados.json');
if (!fs.existsSync(EXEMPLOS_FILE)) {
  fs.writeFileSync(EXEMPLOS_FILE, JSON.stringify([]));
}

function lerExemplos() {
  try { return JSON.parse(fs.readFileSync(EXEMPLOS_FILE, 'utf8')); }
  catch { return []; }
}

function salvarExemplos(ex) {
  fs.writeFileSync(EXEMPLOS_FILE, JSON.stringify(ex, null, 2));
}

// Busca os 2 exemplos aprovados mais recentes do mesmo tipo de notificação
function buscarExemplosRelevantes(tipoNotificacao) {
  const todos = lerExemplos();
  return todos
    .filter(e => e.tipoNotificacao === tipoNotificacao)
    .sort((a, b) => new Date(b.aprovadoEm) - new Date(a.aprovadoEm))
    .slice(0, 2);
}

// ── Helpers ──
function lerRegistros() {
  try { return JSON.parse(fs.readFileSync(REGISTROS_FILE, 'utf8')); }
  catch { return []; }
}

function salvarRegistros(r) {
  fs.writeFileSync(REGISTROS_FILE, JSON.stringify(r, null, 2));
}

function calcularPrazo(dataRecebimento) {
  const d = new Date(dataRecebimento + 'T12:00:00');
  d.setDate(d.getDate() + 15);
  return d.toISOString().split('T')[0];
}

function calcularSemaforo(dataVencimento) {
  const hoje = new Date();
  const venc = new Date(dataVencimento + 'T12:00:00');
  const diff = Math.ceil((venc - hoje) / (1000 * 60 * 60 * 24));
  if (diff < 0) return 'vencido';
  if (diff <= 3) return 'vermelho';
  if (diff <= 7) return 'amarelo';
  return 'verde';
}

function formatarData(dataStr) {
  const meses = ['janeiro','fevereiro','março','abril','maio','junho',
                 'julho','agosto','setembro','outubro','novembro','dezembro'];
  const d = new Date(dataStr + 'T12:00:00');
  return `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

// ── Parse multipart com Busboy (robusto) ──
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let file = null;
    const extraFiles = []; // subsídios
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('file', (name, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (name === 'arquivo') {
          file = { fieldname: name, originalname: filename, buffer: buf, mimetype: mimeType };
        } else if (name.startsWith('subsidio_')) {
          extraFiles.push({ fieldname: name, originalname: filename, buffer: buf, mimetype: mimeType });
        }
      });
    });

    bb.on('close', () => resolve({ fields, file, extraFiles }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

// ── Extrai texto de PDF ou DOCX ──
function extrairTextoArquivo(filePath, originalname) {
  try {
    const ext = path.extname(originalname).toLowerCase();
    if (ext === '.pdf') {
      return execSync(`pdftotext "${filePath}" -`, { encoding: 'utf8', timeout: 30000 });
    } else if (ext === '.docx' || ext === '.doc') {
      return execSync(`extract-text "${filePath}"`, { encoding: 'utf8', timeout: 30000 });
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('Erro extração:', err.message);
    return null;
  }
}

// ── IA: Analisa notificação e extrai TODOS os dados ──
async function analisarNotificacao(textoNotificacao, textosSubsidios = []) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Limita tamanho dos inputs para não estourar contexto nem truncar o JSON de saída
  const textoLimitado = textoNotificacao.slice(0, 6000);
  const subsidiosLimitados = textosSubsidios.map(s => s.slice(0, 1500));

  const blocoSubsidios = subsidiosLimitados.length > 0
    ? `\n\nSUBSÍDIOS ENVIADOS PELA UNIDADE:\n${subsidiosLimitados.join('\n\n')}`
    : '';

  const prompt = `Você é um assistente jurídico especializado da Sankhya S.A., empresa de software ERP.
Analise a notificação extrajudicial abaixo e extraia as informações em JSON.
${blocoSubsidios ? 'Use os subsídios para enriquecer a análise dos pontos críticos.' : ''}

NOTIFICAÇÃO:
${textoLimitado}
${blocoSubsidios}

IMPORTANTE: Retorne APENAS um objeto JSON válido e completo. Todos os campos de texto devem ser CURTOS (máximo 3 frases cada). Não use aspas duplas dentro dos valores — use aspas simples se necessário.

{
  "nomeNotificante": "razão social completa",
  "cnpjNotificante": "CNPJ ou vazio",
  "enderecoNotificante": "endereço completo ou vazio",
  "tipoNotificacao": "FALHA_SOFTWARE | RESCISAO_CONTRATO | COBRANCA_INDEVIDA | TECNOLOGIA_DESCONTINUADA | ESCOPO_PERSONALIZACAO | OUTRO",
  "submotivoRescisao": "só para RESCISAO_CONTRATO: ATRASO_IMPLANTACAO | FALHA_SLA | ESCOPO_NAO_ENTREGUE | INSATISFACAO_ATENDIMENTO | DIVERGENCIA_COMERCIAL | LGPD_DADOS | OUTRO. Caso contrário vazio.",
  "submotivoRescisaoDetalhe": "só para rescisão: uma frase com o motivo específico. Caso contrário vazio.",
  "temaResumido": "tema em até 8 palavras",
  "resumoNotificacao": "resumo em até 3 frases",
  "exigencias": "o que o notificante pede em até 2 frases",
  "pontosCriticos": "principais argumentos a refutar em até 3 frases",
  "dataNotificacao": "YYYY-MM-DD ou vazio",
  "numeroContrato": "número do contrato ou vazio"
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  // Extrai e limpa o JSON da resposta
  let texto = response.content[0].text.trim().replace(/```json|```/g, '').trim();

  // Garante fechamento do JSON caso tenha sido truncado
  if (!texto.endsWith('}')) {
    // Tenta fechar o JSON truncado de forma segura
    const ultimaVirgulaOuChave = texto.lastIndexOf(',');
    const ultimaCitacaoFechada = texto.lastIndexOf('"');
    if (ultimaCitacaoFechada > ultimaVirgulaOuChave) {
      // Último campo está completo — só fecha o objeto
      texto = texto + '}';
    } else {
      // Último campo está incompleto — remove e fecha
      texto = texto.substring(0, ultimaVirgulaOuChave) + '}';
    }
  }

  try {
    return JSON.parse(texto);
  } catch (e) {
    // Fallback: extrai campos individualmente com regex
    const extrair = (campo) => {
      const m = texto.match(new RegExp(`"${campo}"\\s*:\\s*"([^"]*)"`)  );
      return m ? m[1] : '';
    };
    return {
      nomeNotificante: extrair('nomeNotificante') || 'Não identificado',
      cnpjNotificante: extrair('cnpjNotificante'),
      enderecoNotificante: extrair('enderecoNotificante'),
      tipoNotificacao: extrair('tipoNotificacao') || 'OUTRO',
      submotivoRescisao: extrair('submotivoRescisao'),
      submotivoRescisaoDetalhe: extrair('submotivoRescisaoDetalhe'),
      temaResumido: extrair('temaResumido') || 'Análise parcial — revisar manualmente',
      resumoNotificacao: extrair('resumoNotificacao') || 'Não foi possível extrair automaticamente.',
      exigencias: extrair('exigencias'),
      pontosCriticos: extrair('pontosCriticos'),
      dataNotificacao: extrair('dataNotificacao'),
      numeroContrato: extrair('numeroContrato'),
      textoCompleto: textoNotificacao
    };
  }
}

// ── IA: Gera minuta de resposta ──
async function gerarMinutaResposta(dadosAnalise, dataResposta, numeroFlow, nomeAdvogado, setorSolicitante) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tiposDesc = {
    FALHA_SOFTWARE: 'falhas ou problemas no sistema Sankhya OM',
    RESCISAO_CONTRATO: 'pedido de rescisão ou distrato contratual',
    COBRANCA_INDEVIDA: 'contestação de cobranças ou valores',
    TECNOLOGIA_DESCONTINUADA: 'descontinuidade tecnológica e readequação contratual',
    ESCOPO_PERSONALIZACAO: 'demandas fora do escopo contratado ou pedidos de personalização',
    OUTRO: 'tema diverso'
  };

  const blocoSubsidios = dadosAnalise.subsidiosTexto
    ? `\n\nSUBSÍDIOS DISPONÍVEIS (documentos enviados pela unidade como evidências):\n${dadosAnalise.subsidiosTexto.slice(0, 8000)}\n\nUse os subsídios acima para fundamentar a resposta com fatos concretos, datas, números de OS, e-mails, cronogramas e demais evidências. Cite-os de forma objetiva nos "Dos Fatos".`
    : '';

  // Busca exemplos aprovados do mesmo tipo para guiar estilo e qualidade
  const exemplos = buscarExemplosRelevantes(dadosAnalise.tipoNotificacao);
  const blocoExemplos = exemplos.length > 0
    ? `\n\nEXEMPLOS DE RESPOSTAS APROVADAS PELO JURÍDICO DA SANKHYA (mesmo tipo de notificação):\nEstes são textos reais revisados e aprovados pelos advogados. Use-os como referência de estilo, tom, estrutura e nível de detalhe — não os copie, mas produza algo coerente com esse padrão.\n\n${exemplos.map((e, i) => `--- Exemplo ${i + 1} (${e.temaResumido}) ---\n${e.textoAprovado}`).join('\n\n')}`
    : '';

  const prompt = `Você é advogado sênior da Sankhya S.A. e precisa redigir uma resposta formal à notificação extrajudicial descrita abaixo.

DADOS DA NOTIFICAÇÃO:
- Notificante: ${dadosAnalise.nomeNotificante}
- CNPJ: ${dadosAnalise.cnpjNotificante || 'não informado'}
- Endereço: ${dadosAnalise.enderecoNotificante || 'não informado'}
- Tipo: ${tiposDesc[dadosAnalise.tipoNotificacao] || 'tema diverso'}
- Resumo: ${dadosAnalise.resumoNotificacao}
- Exigências: ${dadosAnalise.exigencias}
- Pontos críticos: ${dadosAnalise.pontosCriticos}
- Número de contrato/proposta: ${dadosAnalise.numeroContrato || 'não mencionado'}

DADOS DA RESPOSTA:
- Data: ${dataResposta}
- Flow: ${numeroFlow}
- Advogado: ${nomeAdvogado}
- Setor solicitante: ${setorSolicitante}
${blocoSubsidios}
${blocoExemplos}

INSTRUÇÕES DE ESTRUTURA:
1. Estrutura obrigatória — siga EXATAMENTE esta ordem e formatação:

LINHA 1: data por extenso (ex: Uberlândia/MG, 21 de junho de 2026.)

LINHA 2 EM BRANCO

BLOCO NOTIFICADA (alinhado à direita, fonte pequena):
**NOTIFICADA:**
**SANKHYA S.A.,** CNPJ sob o nº 26.314.062/0001-61,
Av. Marcos de Freitas Costa, nº 369, Bairro Daniel Fonseca,
CEP 38.400-328, Uberlândia/MG.

LINHA EM BRANCO

BLOCO NOTIFICANTE (alinhado à direita, fonte pequena):
**NOTIFICANTE:**
**${dadosAnalise.nomeNotificante},** CNPJ sob o nº ${dadosAnalise.cnpjNotificante || ''},
[endereço do notificante em até 2 linhas]

LINHA EM BRANCO

**Referência:** [tema da notificação em uma linha]

**1. Resumo da Notificação**

[corpo da seção]

**2. Dos Fatos**

[corpo da seção]

**Considerações Finais e Proposta de Solução**

[corpo da seção]

**SANKHYA S.A.**

REGRAS OBRIGATÓRIAS DE FORMATAÇÃO:
- NÃO inclua o título "RESPOSTA À NOTIFICAÇÃO EXTRAJUDICIAL" — ele já está no cabeçalho do documento
- NÃO use --- (três hífens) em nenhum lugar do texto
- NÃO use linhas em branco duplas entre parágrafos — apenas uma linha em branco simples entre seções
- NÃO use travessões (—) no meio de frases
- NÃO use enumerações (i), (ii), (iii) dentro do texto

DIRETRIZES CRÍTICAS DE CONTEÚDO:

2. RESPOSTA DEFINITIVA, NÃO PROTELATÓRIA: A resposta deve ser conclusiva com os fatos disponíveis. Proibido prometer levantar documentação futura ou apresentar evidências posteriormente. Se não há subsídio para um argumento, omita-o.

3. ESTILO: linguagem direta, parágrafos corridos. Sem marcadores de IA como "É de rigor", "cumpre salientar de plano". Use conectivos naturais: "Inicialmente", "Além disso", "Por fim", "Ocorre que", "Nesse sentido".

4. TOM: firme na defesa, respeitoso, sempre com proposta de solução ao final.

5. SUBSÍDIOS: quando disponíveis, use fatos concretos (datas, OS, cronogramas) diretamente no texto como provas já existentes.

Retorne APENAS o texto da resposta. Use **negrito** para títulos, labels e nomes das partes.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

// ── Gera documento Word ──
async function gerarDocumentoWord(textoMinuta, nomeArquivo) {
  const outputPath = path.join(DADOS_DIR, nomeArquivo);
  const templatePath = path.join(__dirname, 'template_notificacao.docx');
  const scriptPath = path.join(__dirname, 'gerar_docx.py');

  // Usa o template oficial com papel timbrado se disponível
  if (fs.existsSync(templatePath) && fs.existsSync(scriptPath)) {
    // Salva o texto em arquivo temporário para evitar problemas com aspas no shell
    const tmpTxt = path.join(DADOS_DIR, `tmp_texto_${Date.now()}.txt`);
    fs.writeFileSync(tmpTxt, textoMinuta, 'utf8');

    try {
      execSync(
        `python3 "${scriptPath}" --file "${tmpTxt}" "${outputPath}" "${templatePath}"`,
        { cwd: __dirname, timeout: 30000 }
      );
      return outputPath;
    } catch (err) {
      console.error('Erro no python, usando fallback:', err.message);
    } finally {
      try { fs.unlinkSync(tmpTxt); } catch {}
    }
  }

  // Fallback: gera sem template (caso template não exista)
  const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
  const linhas = textoMinuta.split('\n');
  const children = [];
  for (const linha of linhas) {
    const texto = linha.trim();
    if (!texto) { children.push(new Paragraph({ children: [new TextRun('')] })); continue; }
    const runs = [];
    const partes = texto.split(/\*\*(.+?)\*\*/g);
    for (let i = 0; i < partes.length; i++) {
      if (!partes[i]) continue;
      runs.push(new TextRun({ text: partes[i], bold: i % 2 === 1, font: 'Roboto', size: 24 }));
    }
    children.push(new Paragraph({ children: runs, alignment: AlignmentType.JUSTIFIED }));
  }
  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1701, right: 1134, bottom: 1417, left: 1134 } } }, children }]
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

// ── Servidor HTTP ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Arquivos estáticos
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(PUBLICO_DIR, 'index.html')));
  }

  // API: advogados
  if (method === 'GET' && pathname === '/api/advogados') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([
      'Ana Clara','Bernardo','Diogo','Luis Marimon',
      'Luiza Delben','Luiza Calabria','Monique','Vinícius'
    ]));
  }

  // API: LOGIN — valida e-mail e retorna perfil
  if (method === 'POST' && pathname === '/api/login') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        const emailLower = (email || '').toLowerCase().trim();

        // Lista fechada do jurídico
        const juridico = [
          { nome: 'Ana Clara',      email: 'ana.oliveira@sankhya.com.br' },
          { nome: 'Bernardo',       email: 'bernardo.barachisio@sankhya.com.br' },
          { nome: 'Diogo',          email: 'diogo.oliveira@sankhya.com.br' },
          { nome: 'Luis Marimon',   email: 'luis.marimon@sankhya.com.br' },
          { nome: 'Luiza Delben',   email: 'luiza.delben@sankhya.com.br' },
          { nome: 'Luiza Calabria', email: 'luiza.calabria@sankhya.com.br' },
          { nome: 'Monique',        email: 'monique.silva@sankhya.com.br' },
          { nome: 'Vinícius',       email: 'vinicius.sousa@sankhya.com.br' },
          { nome: 'Giulia',         email: 'giulia.catharina@sankhya.com.br' },
          { nome: 'João Pesciotto', email: 'joao.pesciotto@ploomes.com' },
        ];

        // Verifica jurídico
        const membroJuridico = juridico.find(u => u.email === emailLower);
        if (membroJuridico) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, nome: membroJuridico.nome, perfil: 'juridico' }));
        }

        // Verifica se é e-mail @sankhya.com.br (unidade)
        if (emailLower.endsWith('@sankhya.com.br')) {
          // Extrai nome amigável do e-mail (ex: joao.silva → João Silva)
          const parteLocal = emailLower.split('@')[0];
          const nomeFormatado = parteLocal.split('.').map(p =>
            p.charAt(0).toUpperCase() + p.slice(1)
          ).join(' ');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, nome: nomeFormatado, perfil: 'unidade' }));
        }

        // E-mail não reconhecido
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'E-mail não autorizado. Use seu e-mail corporativo @sankhya.com.br.' }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Erro interno.' }));
      }
    });
    return;
  }

  // API: todos os usuários com perfil (juridico ou unidade)
  if (method === 'GET' && pathname === '/api/usuarios') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      // Lista fixa e fechada — apenas esses nomes têm acesso ao perfil Jurídico
      juridico: [
        { nome: 'Ana Clara',   email: 'ana.oliveira@sankhya.com.br',      cargo: 'Advogada' },
        { nome: 'Bernardo',    email: 'bernardo.barachisio@sankhya.com.br', cargo: 'Gerente Jurídico' },
        { nome: 'Diogo',       email: 'diogo.oliveira@sankhya.com.br',    cargo: 'Supervisor Jurídico' },
        { nome: 'Luis Marimon',email: 'luis.marimon@sankhya.com.br',      cargo: 'Diretor Jurídico' },
        { nome: 'Luiza Delben',email: 'luiza.delben@sankhya.com.br',      cargo: 'Advogada' },
        { nome: 'Luiza Calabria', email: 'luiza.calabria@sankhya.com.br', cargo: 'Advogada' },
        { nome: 'Monique',     email: 'monique.silva@sankhya.com.br',     cargo: 'Advogada' },
        { nome: 'Vinícius',    email: 'vinicius.sousa@sankhya.com.br',    cargo: 'Gerente Jurídico' },
        { nome: 'Giulia',      email: 'giulia.catharina@sankhya.com.br',  cargo: 'Estagiária' },
        { nome: 'João Pesciotto', email: 'joao.pesciotto@ploomes.com',    cargo: 'Estagiário' },
      ],
      unidades: [
        'AGILIDADE DTI',
        'ARQUITETURA DTI',
        'ASIS',
        'CENTRAL DE PROJETOS',
        'CENTRAL DELIVERY CENTER',
        'COMERCIAL',
        'COMPRAS',
        'CONTÁBIL',
        'DELIVERY CENTER CUSTOMIZAÇÕES',
        'DELIVERY CENTER SOP',
        'DEPARTAMENTO PESSOAL',
        'DESENVOLVIMENTO DTI',
        'EFICIÊNCIA OPERACIONAL',
        'ENDOMARKETING',
        'ESPRESSO',
        'ESTRATÉGIA',
        'FILIAL BELO HORIZONTE',
        'FILIAL BRASIL CENTRAL',
        'FILIAL ESPÍRITO SANTO',
        'FILIAL PAULISTA',
        'FILIAL PORTO ALEGRE',
        'FILIAL SÃO JOSÉ DOS CAMPOS',
        'FILIAL TRIÂNGULO MINEIRO',
        'FINANCEIRO',
        'INFRAESTRUTURA (FACILITIES)',
        'INTELIGÊNCIA DE MERCADO',
        'JURÍDICO',
        'M&A',
        'MANUTENCAO DTI',
        'MARKETING',
        'MEETIME',
        'MINDSIGHT',
        'NEPPO',
        'PLANEJAMENTO FINANCEIRO',
        'PLOOMES',
        'P.M.I',
        'PONTOTEL',
        'PRESIDÊNCIA',
        'PRODUTO DTI',
        'PROSPECÇÃO',
        'RECEITAS MATRIZ',
        'RELACIONAMENTO COM CLIENTES (CS/CX)',
        'SERVICE DESK SANKHYA',
        'TALENT ACQUISITION',
        'TI',
        'TREINAMENTO E DESENVOLVIMENTO (DHO)',
        'UNIVERSIDADE',
        'VIXTING',
      ]
    }));
  }

  // API: registros filtrados por unidade (para tela de acompanhamento)
  if (method === 'GET' && pathname.startsWith('/api/registros/unidade/')) {
    const unidade = decodeURIComponent(pathname.split('/api/registros/unidade/')[1]);
    const regs = lerRegistros()
      .filter(r => r.setorSolicitante === unidade)
      .map(r => ({ ...r, semaforo: calcularSemaforo(r.dataVencimento) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(regs));
  }

  // API: registros
  if (method === 'GET' && pathname === '/api/registros') {
    const regs = lerRegistros().map(r => ({ ...r, semaforo: calcularSemaforo(r.dataVencimento) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(regs));
  }

  // API: download
  if (method === 'GET' && pathname.startsWith('/api/download/')) {
    const nome = decodeURIComponent(pathname.split('/api/download/')[1]);
    const fp = path.join(DADOS_DIR, nome);
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${nome}"`
    });
    return res.end(fs.readFileSync(fp));
  }

  // API: deletar
  if (method === 'POST' && pathname === '/api/deletar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { id, email } = JSON.parse(body);
      if (email !== 'vinicius.sousa@sankhya.com.br') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Acesso negado' }));
      }
      let regs = lerRegistros();
      const reg = regs.find(r => r.id === id);
      if (reg?.arquivoGerado) {
        const fp = path.join(DADOS_DIR, reg.arquivoGerado);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      salvarRegistros(regs.filter(r => r.id !== id));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // API: atualizar status
  if (method === 'POST' && pathname === '/api/atualizar-status') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { id, status } = JSON.parse(body);
      const regs = lerRegistros();
      const idx = regs.findIndex(r => r.id === id);
      if (idx !== -1) { regs[idx].status = status; salvarRegistros(regs); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // API: ANALISAR — upload + subsídios + IA extrai tudo
  if (method === 'POST' && pathname === '/api/analisar') {
    try {
      const { fields, file, extraFiles } = await parseMultipart(req);

      let textoNotificacao = '';

      if (file && file.buffer && file.buffer.length > 0) {
        const tmpPath = path.join(UPLOADS_DIR, `tmp_${Date.now()}${path.extname(file.originalname)}`);
        fs.writeFileSync(tmpPath, file.buffer);
        textoNotificacao = extrairTextoArquivo(tmpPath, file.originalname) || '';
        try { fs.unlinkSync(tmpPath); } catch {}
      }

      if (!textoNotificacao && fields.textoManual) {
        textoNotificacao = fields.textoManual;
      }

      if (!textoNotificacao || textoNotificacao.trim().length < 20) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Não foi possível extrair o texto da notificação. Verifique o arquivo ou cole o texto manualmente.' }));
      }

      // Extrai texto dos subsídios
      const textosSubsidios = [];
      for (const sub of (extraFiles || [])) {
        if (sub.buffer && sub.buffer.length > 0) {
          const tmpPath = path.join(UPLOADS_DIR, `tmp_sub_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(sub.originalname)}`);
          fs.writeFileSync(tmpPath, sub.buffer);
          const texto = extrairTextoArquivo(tmpPath, sub.originalname);
          try { fs.unlinkSync(tmpPath); } catch {}
          if (texto && texto.trim().length > 20) {
            // Limita cada subsídio a 3000 chars para não estourar contexto
            textosSubsidios.push(`--- Subsídio: ${sub.originalname} ---\n${texto.slice(0, 3000)}`);
          }
        }
      }

      const analise = await analisarNotificacao(textoNotificacao, textosSubsidios);
      analise.textoCompleto = textoNotificacao;
      analise.subsidiosTexto = textosSubsidios.join('\n\n');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(analise));

    } catch (err) {
      console.error('Erro análise:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erro: err.message }));
    }
  }

  // API: CONFIRMAR — preenche dados e gera documento
  if (method === 'POST' && pathname === '/api/confirmar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const dados = JSON.parse(body);
        const { analise, numeroFlow, nomeAdvogado, setorSolicitante, dataRecebimento } = dados;

        if (!numeroFlow || !nomeAdvogado || !dataRecebimento) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erro: 'Flow, advogado e data de recebimento são obrigatórios' }));
        }

        const hoje = new Date();
        const dataResposta = formatarData(hoje.toISOString().split('T')[0]);
        const textoMinuta = await gerarMinutaResposta(analise, dataResposta, numeroFlow, nomeAdvogado, setorSolicitante);

        const nomeArquivo = `Resposta_${analise.nomeNotificante.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)}_${Date.now()}.docx`;
        await gerarDocumentoWord(textoMinuta, nomeArquivo);

        const dataVencimento = calcularPrazo(dataRecebimento);
        const id = `NOT_${Date.now()}`;

        const registro = {
          id, numeroFlow,
          nomeNotificante: analise.nomeNotificante,
          cnpjNotificante: analise.cnpjNotificante || '',
          tipoNotificacao: analise.tipoNotificacao,
          submotivoRescisao: analise.submotivoRescisao || '',
          submotivoRescisaoDetalhe: analise.submotivoRescisaoDetalhe || '',
          temaResumido: analise.temaResumido,
          resumoNotificacao: analise.resumoNotificacao,
          dataRecebimento, dataVencimento,
          dataResposta: hoje.toISOString().split('T')[0],
          nomeAdvogado,
          setorSolicitante: setorSolicitante || '',
          semaforo: calcularSemaforo(dataVencimento),
          status: 'minuta_gerada',
          arquivoGerado: nomeArquivo,
          criadoEm: new Date().toISOString()
        };

        const regs = lerRegistros();
        regs.unshift(registro);
        salvarRegistros(regs);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, nomeArquivo, textoMinuta }));

      } catch (err) {
        console.error('Erro confirmar:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: err.message }));
      }
    });
    return;
  }

  // API: APROVAR EXEMPLO — salva o texto editado como referência futura
  if (method === 'POST' && pathname === '/api/aprovar-exemplo') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { textoAprovado, tipoNotificacao, temaResumido, nomeAdvogado, registroId } = JSON.parse(body);

        if (!textoAprovado || !tipoNotificacao) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erro: 'Dados insuficientes' }));
        }

        const exemplos = lerExemplos();

        // Evita duplicata do mesmo registro
        const jaExiste = exemplos.find(e => e.registroId === registroId);
        if (jaExiste) {
          // Atualiza o exemplo existente com o texto mais recente
          jaExiste.textoAprovado = textoAprovado;
          jaExiste.aprovadoEm = new Date().toISOString();
          jaExiste.nomeAdvogado = nomeAdvogado;
        } else {
          exemplos.push({
            id: `EX_${Date.now()}`,
            registroId,
            tipoNotificacao,
            temaResumido: temaResumido || '',
            textoAprovado,
            nomeAdvogado,
            aprovadoEm: new Date().toISOString()
          });
        }

        salvarExemplos(exemplos);

        // Marca o registro como tendo exemplo aprovado
        const regs = lerRegistros();
        const idx = regs.findIndex(r => r.id === registroId);
        if (idx !== -1) { regs[idx].exemploAprovado = true; salvarRegistros(regs); }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, total: exemplos.filter(e => e.tipoNotificacao === tipoNotificacao).length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: err.message }));
      }
    });
    return;
  }

  // API: listar exemplos aprovados (para gestão futura)
  if (method === 'GET' && pathname === '/api/exemplos') {
    const exemplos = lerExemplos();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(exemplos));
  }

  // API: GERAR-WORD — recebe texto editado e gera novo docx
  if (method === 'POST' && pathname === '/api/gerar-word') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { textoEditado, nomeArquivo } = JSON.parse(body);
        if (!textoEditado || !textoEditado.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erro: 'Texto vazio' }));
        }
        const nomeBase = nomeArquivo.replace('.docx', '');
        const nomeNovo = `${nomeBase}_editado_${Date.now()}.docx`;
        await gerarDocumentoWord(textoEditado, nomeNovo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, nomeArquivo: nomeNovo }));
      } catch (err) {
        console.error('Erro gerar-word:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ erro: 'Rota não encontrada' }));
});

server.listen(PORT, () => {
  console.log(`✅ Módulo 3 — Central de Notificações rodando na porta ${PORT}`);
});
