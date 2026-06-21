// ============================================================
// MÓDULO 3 — Central de Notificações Extrajudiciais
// Sankhya S.A. — Departamento Jurídico
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Porta do servidor
const PORT = process.env.PORT || 3003;

// Caminhos principais
const DADOS_DIR = path.join(__dirname, 'dados');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLICO_DIR = path.join(__dirname, 'publico');
const REGISTROS_FILE = path.join(DADOS_DIR, 'registros.json');

// Garante que os diretórios existem
[DADOS_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Inicializa banco de dados JSON se não existir
if (!fs.existsSync(REGISTROS_FILE)) {
  fs.writeFileSync(REGISTROS_FILE, JSON.stringify([]));
}

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

// Lê os registros do banco JSON
function lerRegistros() {
  try {
    return JSON.parse(fs.readFileSync(REGISTROS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// Salva registros no banco JSON
function salvarRegistros(registros) {
  fs.writeFileSync(REGISTROS_FILE, JSON.stringify(registros, null, 2));
}

// Calcula prazo de 15 dias a partir da data de recebimento
function calcularPrazo(dataRecebimento) {
  const data = new Date(dataRecebimento);
  data.setDate(data.getDate() + 15);
  return data.toISOString().split('T')[0];
}

// Define status do semáforo com base no prazo
function calcularSemaforo(dataVencimento) {
  const hoje = new Date();
  const vencimento = new Date(dataVencimento);
  const diffDias = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));

  if (diffDias < 0) return 'vencido';
  if (diffDias <= 3) return 'vermelho';
  if (diffDias <= 7) return 'amarelo';
  return 'verde';
}

// Formata data para exibição em português
function formatarData(dataStr) {
  if (!dataStr) return '';
  const meses = ['janeiro','fevereiro','março','abril','maio','junho',
                 'julho','agosto','setembro','outubro','novembro','dezembro'];
  const d = new Date(dataStr + 'T12:00:00');
  return `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

// Extrai corpo de requisição multipart (upload de arquivo)
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) return resolve({ fields: {}, file: null });

      const boundary = '--' + boundaryMatch[1];
      const boundaryBuf = Buffer.from(boundary);
      const parts = [];
      let start = 0;

      // Divide o body pelos boundaries
      while (true) {
        const idx = body.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) parts.push(body.slice(start, idx - 2));
        start = idx + boundaryBuf.length + 2;
      }

      const fields = {};
      let file = null;

      parts.forEach(part => {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = part.slice(0, headerEnd).toString();
        const content = part.slice(headerEnd + 4);

        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);

        if (!nameMatch) return;
        const name = nameMatch[1];

        if (filenameMatch) {
          file = {
            fieldname: name,
            originalname: filenameMatch[1],
            buffer: content,
            mimetype: header.match(/Content-Type: (.+)/)?.[1]?.trim() || ''
          };
        } else {
          fields[name] = content.toString().trim();
        }
      });

      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}

// Extrai texto de arquivo DOCX ou PDF usando ferramentas do sistema
function extrairTextoArquivo(filePath, mimetype, originalname) {
  try {
    const ext = path.extname(originalname).toLowerCase();

    if (ext === '.pdf') {
      // Usa pdftotext para PDFs
      const result = execSync(`pdftotext "${filePath}" -`, { encoding: 'utf8', timeout: 30000 });
      return result;
    } else if (ext === '.docx' || ext === '.doc') {
      // Usa extract-text para DOCX
      const result = execSync(`extract-text "${filePath}"`, { encoding: 'utf8', timeout: 30000 });
      return result;
    } else {
      return fs.readFileSync(filePath, 'utf8');
    }
  } catch (err) {
    console.error('Erro ao extrair texto:', err.message);
    return null;
  }
}

// ============================================================
// FUNÇÕES DE IA — ANTHROPIC API
// ============================================================

// Analisa a notificação recebida e extrai dados estruturados
async function analisarNotificacao(textoNotificacao) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Você é um assistente jurídico especializado da Sankhya S.A., empresa de software ERP.
Analise a notificação extrajudicial abaixo e extraia as informações em JSON.

NOTIFICAÇÃO:
${textoNotificacao}

Retorne APENAS um objeto JSON válido, sem markdown, sem explicações, com esta estrutura exata:
{
  "nomeNotificante": "razão social completa de quem enviou a notificação",
  "cnpjNotificante": "CNPJ do notificante ou vazio se não encontrado",
  "enderecoNotificante": "endereço completo do notificante ou vazio",
  "tipoNotificacao": "um dos seguintes: FALHA_SOFTWARE | RESCISAO_CONTRATO | COBRANCA_INDEVIDA | TECNOLOGIA_DESCONTINUADA | ESCOPO_PERSONALIZACAO | OUTRO",
  "temaResumido": "tema em até 10 palavras",
  "resumoNotificacao": "resumo dos fatos e exigências em 3 a 5 frases",
  "exigencias": "o que o notificante está pedindo/exigindo",
  "pontosCriticos": "principais argumentos que precisam ser refutados ou tratados na resposta",
  "dataNotificacao": "data da notificação no formato YYYY-MM-DD ou vazio se não encontrada",
  "numeroContrato": "número do contrato ou proposta comercial se mencionado, ou vazio"
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const texto = response.content[0].text.trim();
  // Remove possíveis marcadores de código
  const limpo = texto.replace(/```json|```/g, '').trim();
  return JSON.parse(limpo);
}

// Gera a minuta de resposta completa com base na análise
async function gerarMinutaResposta(dadosAnalise, dataResposta, numeroFlow, nomeAdvogado, setorSolicitante) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const tiposDescricao = {
    FALHA_SOFTWARE: 'falhas ou problemas no sistema Sankhya OM',
    RESCISAO_CONTRATO: 'pedido de rescisão ou distrato contratual',
    COBRANCA_INDEVIDA: 'contestação de cobranças ou valores',
    TECNOLOGIA_DESCONTINUADA: 'descontinuidade tecnológica e readequação contratual',
    ESCOPO_PERSONALIZACAO: 'demandas fora do escopo contratado ou pedidos de personalização',
    OUTRO: 'tema diverso'
  };

  const descricaoTipo = tiposDescricao[dadosAnalise.tipoNotificacao] || 'tema diverso';

  const prompt = `Você é advogado sênior da Sankhya S.A. e precisa redigir uma resposta formal à notificação extrajudicial descrita abaixo.

DADOS DA NOTIFICAÇÃO:
- Notificante: ${dadosAnalise.nomeNotificante}
- CNPJ: ${dadosAnalise.cnpjNotificante || 'não informado'}
- Endereço: ${dadosAnalise.enderecoNotificante || 'não informado'}
- Tipo: ${descricaoTipo}
- Resumo: ${dadosAnalise.resumoNotificacao}
- Exigências: ${dadosAnalise.exigencias}
- Pontos críticos a tratar: ${dadosAnalise.pontosCriticos}
- Número de contrato/proposta: ${dadosAnalise.numeroContrato || 'não mencionado'}

DADOS DA RESPOSTA:
- Data: ${dataResposta}
- Flow: ${numeroFlow}
- Advogado responsável: ${nomeAdvogado}
- Setor solicitante: ${setorSolicitante}

INSTRUÇÕES DE REDAÇÃO:
1. Redija em português jurídico formal, claro e objetivo
2. Siga EXATAMENTE esta estrutura:
   - Cabeçalho com data e título "RESPOSTA À NOTIFICAÇÃO EXTRAJUDICIAL" (ou "CONTRANOTIFICAÇÃO EXTRAJUDICIAL" se for resposta a uma contranotificação)
   - Identificação completa da Notificada (SANKHYA S.A., CNPJ 26.314.062/0001-61, Avenida Marcos de Freitas Costa, nº 369, Bairro Daniel Fonseca, CEP 38.400-328, Uberlândia/MG)
   - Identificação do Notificante com seus dados
   - Referência ao tema
   - Seção "1. Resumo da Notificação" — descreva em apertada síntese o que o notificante alega
   - Seção "2. Dos Fatos" — resposta detalhada e fundamentada da Sankhya, refutando argumentos indevidos e reconhecendo pontos cabíveis
   - Seção final "Considerações Finais e Proposta de Solução" — encaminhamento construtivo, disponibilidade para solução amigável
   - Fechamento com local (Uberlândia/MG), data e "SANKHYA S.A."
3. Tom: firme na defesa dos interesses da Sankhya, mas sempre respeitoso e com proposta de solução
4. A Sankhya NUNCA admite falha sem antes contextualizar e apresentar os fatos favoráveis
5. Sempre terminar com disposição para resolver amigavelmente

Retorne APENAS o texto da resposta, sem explicações adicionais. Use **negrito** para títulos e nomes das partes.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

// ============================================================
// GERAÇÃO DO DOCUMENTO WORD
// ============================================================

async function gerarDocumentoWord(textoMinuta, nomeArquivo) {
  // Instala docx se necessário
  try {
    require.resolve('docx');
  } catch {
    execSync('npm install docx', { cwd: __dirname });
  }

  const {
    Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel
  } = require('docx');

  // Processa o texto da minuta em parágrafos
  const linhas = textoMinuta.split('\n');
  const children = [];

  for (const linha of linhas) {
    const texto = linha.trim();
    if (!texto) {
      children.push(new Paragraph({ children: [new TextRun('')], spacing: { after: 120 } }));
      continue;
    }

    // Detecta negrito: **texto**
    const runs = [];
    const partes = texto.split(/\*\*(.+?)\*\*/g);
    for (let i = 0; i < partes.length; i++) {
      if (!partes[i]) continue;
      if (i % 2 === 1) {
        // É negrito
        runs.push(new TextRun({ text: partes[i], bold: true, font: 'Arial', size: 24 }));
      } else {
        runs.push(new TextRun({ text: partes[i], font: 'Arial', size: 24 }));
      }
    }

    children.push(new Paragraph({
      children: runs,
      spacing: { after: 160 },
      alignment: AlignmentType.JUSTIFIED
    }));
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Arial', size: 24 } }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  const outputPath = path.join(DADOS_DIR, nomeArquivo);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

// ============================================================
// ROTEADOR HTTP
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // Cabeçalhos CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ── Arquivos estáticos ──
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(PUBLICO_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (method === 'GET' && pathname.startsWith('/publico/')) {
    const filePath = path.join(__dirname, pathname);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const tipos = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': tipos[ext] || 'text/plain' });
      return res.end(fs.readFileSync(filePath));
    }
  }

  // ── API: Lista de advogados ──
  if (method === 'GET' && pathname === '/api/advogados') {
    const advogados = [
      'Ana Clara', 'Bernardo', 'Diogo', 'Luis Marimon',
      'Luiza Delben', 'Luiza Calabria', 'Monique', 'Vinícius'
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(advogados));
  }

  // ── API: Listar registros (dashboard) ──
  if (method === 'GET' && pathname === '/api/registros') {
    const registros = lerRegistros();
    // Atualiza semáforo dinamicamente
    const atualizados = registros.map(r => ({
      ...r,
      semaforo: calcularSemaforo(r.dataVencimento)
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(atualizados));
  }

  // ── API: Buscar registro por ID ──
  if (method === 'GET' && pathname.startsWith('/api/registros/')) {
    const id = pathname.split('/')[3];
    const registros = lerRegistros();
    const registro = registros.find(r => r.id === id);
    if (!registro) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erro: 'Registro não encontrado' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(registro));
  }

  // ── API: Download do documento gerado ──
  if (method === 'GET' && pathname.startsWith('/api/download/')) {
    const nomeArquivo = decodeURIComponent(pathname.split('/api/download/')[1]);
    const filePath = path.join(DADOS_DIR, nomeArquivo);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404); return res.end('Arquivo não encontrado');
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${nomeArquivo}"`
    });
    return res.end(fs.readFileSync(filePath));
  }

  // ── API: Deletar registro (apenas admin) ──
  if (method === 'POST' && pathname === '/api/deletar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { id, email } = JSON.parse(body);
      if (email !== 'vinicius.sousa@sankhya.com.br') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Acesso negado' }));
      }
      let registros = lerRegistros();
      const registro = registros.find(r => r.id === id);
      if (registro?.arquivoGerado) {
        const fp = path.join(DADOS_DIR, registro.arquivoGerado);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      registros = registros.filter(r => r.id !== id);
      salvarRegistros(registros);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ── API: Atualizar status de uma notificação ──
  if (method === 'POST' && pathname === '/api/atualizar-status') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { id, status } = JSON.parse(body);
      const registros = lerRegistros();
      const idx = registros.findIndex(r => r.id === id);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Não encontrado' }));
      }
      registros[idx].status = status;
      salvarRegistros(registros);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // ── API: ANÁLISE — recebe upload e faz análise IA ──
  if (method === 'POST' && pathname === '/api/analisar') {
    try {
      const { fields, file } = await parseMultipart(req);

      // Valida campos obrigatórios
      if (!fields.email || !fields.dataRecebimento) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Campos obrigatórios ausentes' }));
      }

      let textoNotificacao = '';

      if (file && file.buffer.length > 0) {
        // Salva arquivo temporariamente
        const tmpPath = path.join(UPLOADS_DIR, `tmp_${Date.now()}${path.extname(file.originalname)}`);
        fs.writeFileSync(tmpPath, file.buffer);
        textoNotificacao = extrairTextoArquivo(tmpPath, file.mimetype, file.originalname);
        fs.unlinkSync(tmpPath);
      } else if (fields.textoManual) {
        textoNotificacao = fields.textoManual;
      }

      if (!textoNotificacao) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erro: 'Não foi possível extrair o texto da notificação' }));
      }

      // Chama a IA para análise
      const analise = await analisarNotificacao(textoNotificacao);
      analise.dataRecebimento = fields.dataRecebimento;
      analise.setorSolicitante = fields.setorSolicitante || '';
      analise.nomeAdvogado = fields.nomeAdvogado || '';
      analise.textoCompleto = textoNotificacao;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(analise));

    } catch (err) {
      console.error('Erro na análise:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erro: err.message }));
    }
  }

  // ── API: CONFIRMAR — gera documento e salva registro ──
  if (method === 'POST' && pathname === '/api/confirmar') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const dados = JSON.parse(body);
        const { analise, numeroFlow, nomeAdvogado, setorSolicitante, dataRecebimento } = dados;

        // Valida campos obrigatórios
        if (!numeroFlow || !nomeAdvogado) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erro: 'Flow e advogado responsável são obrigatórios' }));
        }

        // Data da resposta = hoje
        const hoje = new Date();
        const dataResposta = formatarData(hoje.toISOString().split('T')[0]);

        // Gera a minuta de resposta com IA
        const textoMinuta = await gerarMinutaResposta(
          analise, dataResposta, numeroFlow, nomeAdvogado, setorSolicitante
        );

        // Gera o arquivo Word
        const nomeArquivo = `Resposta_${analise.nomeNotificante.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40)}_${Date.now()}.docx`;
        await gerarDocumentoWord(textoMinuta, nomeArquivo);

        // Calcula prazo e cria registro
        const dataVencimento = calcularPrazo(dataRecebimento);
        const id = `NOT_${Date.now()}`;

        const registro = {
          id,
          numeroFlow,
          nomeNotificante: analise.nomeNotificante,
          cnpjNotificante: analise.cnpjNotificante || '',
          tipoNotificacao: analise.tipoNotificacao,
          temaResumido: analise.temaResumido,
          resumoNotificacao: analise.resumoNotificacao,
          dataRecebimento,
          dataVencimento,
          dataResposta: hoje.toISOString().split('T')[0],
          nomeAdvogado,
          setorSolicitante: setorSolicitante || '',
          semaforo: calcularSemaforo(dataVencimento),
          status: 'minuta_gerada',
          arquivoGerado: nomeArquivo,
          criadoEm: new Date().toISOString()
        };

        const registros = lerRegistros();
        registros.unshift(registro);
        salvarRegistros(registros);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id, nomeArquivo, textoMinuta }));

      } catch (err) {
        console.error('Erro ao confirmar:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: err.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ erro: 'Rota não encontrada' }));
});

server.listen(PORT, () => {
  console.log(`✅ Módulo 3 — Central de Notificações rodando na porta ${PORT}`);
});
