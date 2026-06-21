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
    const bb = Busboy({ headers: req.headers });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('file', (name, stream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        file = {
          fieldname: name,
          originalname: filename,
          buffer: Buffer.concat(chunks),
          mimetype: mimeType
        };
      });
    });

    bb.on('close', () => resolve({ fields, file }));
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

  const texto = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(texto);
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

INSTRUÇÕES:
1. Português jurídico formal, claro e objetivo
2. Estrutura obrigatória:
   - Cabeçalho: local/data e título "RESPOSTA À NOTIFICAÇÃO EXTRAJUDICIAL"
   - Identificação da Notificada: SANKHYA S.A., CNPJ 26.314.062/0001-61, Av. Marcos de Freitas Costa, nº 369, Bairro Daniel Fonseca, CEP 38.400-328, Uberlândia/MG
   - Identificação do Notificante com seus dados
   - Referência ao tema
   - "1. Resumo da Notificação" — síntese do que o notificante alega
   - "2. Dos Fatos" — resposta detalhada e fundamentada
   - "Considerações Finais e Proposta de Solução" — encaminhamento construtivo
   - Fechamento: Uberlândia/MG, data e SANKHYA S.A.
3. Tom: firme na defesa, respeitoso, sempre com proposta de solução
4. Nunca admite falha sem contextualizar com fatos favoráveis
5. Sempre encerra com disposição para resolução amigável

Retorne APENAS o texto da resposta. Use **negrito** para títulos e nomes das partes.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

// ── Gera documento Word ──
async function gerarDocumentoWord(textoMinuta, nomeArquivo) {
  try { require.resolve('docx'); }
  catch { execSync('npm install docx', { cwd: __dirname }); }

  const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');

  const linhas = textoMinuta.split('\n');
  const children = [];

  for (const linha of linhas) {
    const texto = linha.trim();
    if (!texto) {
      children.push(new Paragraph({ children: [new TextRun('')], spacing: { after: 120 } }));
      continue;
    }
    const runs = [];
    const partes = texto.split(/\*\*(.+?)\*\*/g);
    for (let i = 0; i < partes.length; i++) {
      if (!partes[i]) continue;
      runs.push(new TextRun({ text: partes[i], bold: i % 2 === 1, font: 'Arial', size: 24 }));
    }
    children.push(new Paragraph({
      children: runs,
      spacing: { after: 160 },
      alignment: AlignmentType.JUSTIFIED
    }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 24 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
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

  // API: ANALISAR — upload + IA extrai tudo
  if (method === 'POST' && pathname === '/api/analisar') {
    try {
      const { fields, file } = await parseMultipart(req);

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

      const analise = await analisarNotificacao(textoNotificacao);
      analise.textoCompleto = textoNotificacao;

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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ erro: 'Rota não encontrada' }));
});

server.listen(PORT, () => {
  console.log(`✅ Módulo 3 — Central de Notificações rodando na porta ${PORT}`);
});
