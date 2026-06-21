#!/usr/bin/env python3
# ============================================================
# gerar_docx.py — Gera resposta à notificação com formatação
# do template oficial Sankhya S.A. (baseado na BUQ Care)
# Padrões mapeados:
#   - Corpo: Roboto 12pt (sz=24), justificado, cor 2E3C4F
#   - Títulos de seção: Roboto 12pt bold, centralizado
#   - Identificação partes: Roboto 10pt, alinhado à direita
#   - Labels (NOTIFICADA/NOTIFICANTE): Roboto 10pt bold, direita
#   - Referência: Roboto 12pt bold+normal misto, justificado
# ============================================================

import sys, os, shutil, zipfile, re, argparse

def esc(t):
    return (t.replace('&','&amp;').replace('<','&lt;')
             .replace('>','&gt;').replace('"','&quot;'))

def p_corpo(texto, bold=False, pid=None):
    """Parágrafo de corpo — Roboto 12pt, justificado."""
    b = '<w:b w:val="1"/><w:bCs w:val="1"/>' if bold else ''
    pid_attr = f'w14:paraId="{pid}"' if pid else ''
    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:line="276" w:lineRule="auto"/>
        <w:jc w:val="both"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          {b}<w:color w:val="2E3C4F"/>
          <w:sz w:val="24"/><w:szCs w:val="24"/>
        </w:rPr>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          {b}<w:color w:val="2E3C4F"/>
          <w:sz w:val="24"/><w:szCs w:val="24"/>
          <w:rtl w:val="0"/>
        </w:rPr>
        <w:t xml:space="preserve">{esc(texto)}</w:t>
      </w:r>
    </w:p>'''

def p_titulo(texto, pid=None):
    """Título de seção — Roboto 12pt bold, centralizado."""
    pid_attr = f'w14:paraId="{pid}"' if pid else ''
    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:before="160" w:after="160" w:line="276" w:lineRule="auto"/>
        <w:jc w:val="center"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          <w:b w:val="1"/><w:bCs w:val="1"/>
          <w:color w:val="2E3C4F"/>
          <w:sz w:val="24"/><w:szCs w:val="24"/>
        </w:rPr>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          <w:b w:val="1"/><w:bCs w:val="1"/>
          <w:color w:val="2E3C4F"/>
          <w:sz w:val="24"/><w:szCs w:val="24"/>
          <w:rtl w:val="0"/>
        </w:rPr>
        <w:t xml:space="preserve">{esc(texto)}</w:t>
      </w:r>
    </w:p>'''

def p_direita(texto, bold=False, sz=20, pid=None):
    """Parágrafo alinhado à direita — identificação das partes (10pt)."""
    b = '<w:b w:val="1"/><w:bCs w:val="1"/>' if bold else ''
    pid_attr = f'w14:paraId="{pid}"' if pid else ''
    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:line="276" w:lineRule="auto"/>
        <w:jc w:val="right"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          {b}<w:color w:val="2E3C4F"/>
          <w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>
        </w:rPr>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          {b}<w:color w:val="2E3C4F"/>
          <w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>
          <w:rtl w:val="0"/>
        </w:rPr>
        <w:t xml:space="preserve">{esc(texto)}</w:t>
      </w:r>
    </w:p>'''

def p_vazio(pid=None):
    pid_attr = f'w14:paraId="{pid}"' if pid else ''
    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:line="276" w:lineRule="auto"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          <w:color w:val="2E3C4F"/>
          <w:sz w:val="24"/><w:szCs w:val="24"/>
        </w:rPr>
      </w:pPr>
      <w:r><w:rPr><w:rtl w:val="0"/></w:rPr></w:r>
    </w:p>'''

def p_misto(partes, alinhamento='both', sz=24, pid=None):
    """Parágrafo com runs de negrito/normal misturados."""
    pid_attr = f'w14:paraId="{pid}"' if pid else ''
    runs = ''
    for texto, bold in partes:
        if not texto: continue
        b = '<w:b w:val="1"/><w:bCs w:val="1"/>' if bold else ''
        runs += f'''<w:r>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          {b}<w:color w:val="2E3C4F"/>
          <w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>
          <w:rtl w:val="0"/>
        </w:rPr>
        <w:t xml:space="preserve">{esc(texto)}</w:t>
      </w:r>'''
    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:line="276" w:lineRule="auto"/>
        <w:jc w:val="{alinhamento}"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:hAnsi="Roboto"/>
          <w:color w:val="2E3C4F"/>
          <w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>
        </w:rPr>
      </w:pPr>
      {runs}
    </w:p>'''

# Marcadores que indicam alinhamento à direita no texto da IA
PADROES_DIREITA = [
    r'^(NOTIFICAD[AO]:?)$',
    r'^(NOTIFICANTE:?)$',
    r'^SANKHYA S\.A',
    r'^(Av\.|Rua |Avenida |R\. |BR |Rod\.|Rodovia )',
    r'^CEP\s',
    r'^CNPJ\s',
    r'^\w.*\/\w{2},\s*CEP',   # Cidade/UF, CEP
]

PADROES_TITULO = [
    r'^\d+\.\s+[A-Z]',        # "1. Resumo" "2. Dos Fatos"
    r'^Considerações Finais',
    r'^RESPOSTA À NOTIFICAÇÃO',
    r'^CONTRANOTIFICAÇÃO',
]

PADROES_DATA = [
    r'^Uberlândia',
    r'^\w+/\w+,\s+\d+\s+de\s+\w+\s+de\s+\d{4}',
]

def classificar_linha(linha):
    """Retorna ('direita'|'titulo'|'data'|'corpo'), bold."""
    t = linha.strip()
    if not t:
        return 'vazio', False
    for pat in PADROES_DIREITA:
        if re.match(pat, t):
            bold = bool(re.match(r'^(NOTIFICAD[AO]|SANKHYA)', t))
            return 'direita', bold
    for pat in PADROES_TITULO:
        if re.match(pat, t):
            return 'titulo', True
    for pat in PADROES_DATA:
        if re.match(pat, t):
            return 'corpo', False
    return 'corpo', False

def texto_para_xml(texto):
    # Remove separadores --- que a IA pode gerar
    texto = re.sub(r'\n\s*---+\s*\n', '\n', texto)
    # Colapsa múltiplas linhas em branco consecutivas em uma única
    texto = re.sub(r'\n{3,}', '\n\n', texto)

    linhas = texto.split('\n')
    paragrafos = []
    pid = 1
    ultima_foi_vazia = False

    for linha in linhas:
        t = linha.strip()
        pid_hex = f'{pid:08X}'
        pid += 1

        if not t:
            # Permite apenas UMA linha vazia consecutiva
            if not ultima_foi_vazia:
                paragrafos.append(p_vazio(pid=pid_hex))
                ultima_foi_vazia = True
            continue

        ultima_foi_vazia = False

        # Remove título redundante que já está no cabeçalho
        if re.match(r'^\*?\*?RESPOSTA À NOTIFICAÇÃO EXTRAJUDICIAL\*?\*?$', t, re.IGNORECASE):
            continue
        if re.match(r'^\*?\*?CONTRANOTIFICAÇÃO EXTRAJUDICIAL\*?\*?$', t, re.IGNORECASE):
            continue

        # Detecta negrito **...**
        tem_negrito = '**' in t
        tipo, bold_default = classificar_linha(t)

        if tem_negrito:
            partes_raw = re.split(r'\*\*(.+?)\*\*', t)
            partes = [(p, i % 2 == 1) for i, p in enumerate(partes_raw) if p]
            alinhamento = 'right' if tipo == 'direita' else ('center' if tipo == 'titulo' else 'both')
            sz = 20 if tipo == 'direita' else 24
            paragrafos.append(p_misto(partes, alinhamento=alinhamento, sz=sz, pid=pid_hex))
        elif tipo == 'titulo':
            paragrafos.append(p_titulo(t, pid=pid_hex))
        elif tipo == 'direita':
            # Linhas de identificação das partes — fonte 10pt (sz=20)
            sz = 20
            bold = bold_default or bool(re.match(r'^(NOTIFICAD[AO]:?|SANKHYA)', t))
            paragrafos.append(p_direita(t, bold=bold, sz=sz, pid=pid_hex))
        else:
            paragrafos.append(p_corpo(t, bold=bold_default, pid=pid_hex))

    return '\n'.join(paragrafos)

def gerar_docx(texto, caminho_template, caminho_saida):
    shutil.copy2(caminho_template, caminho_saida)

    with zipfile.ZipFile(caminho_saida, 'r') as z:
        original = z.read('word/document.xml').decode('utf-8')
        arquivos = {n: z.read(n) for n in z.namelist()}

    # Extrai sectPr e abertura do document
    match_sect = re.search(r'<w:sectPr\b.*?</w:sectPr>', original, re.DOTALL)
    sect_pr = match_sect.group(0) if match_sect else ''
    match_doc = re.search(r'(<w:document\b[^>]*>)', original)
    abertura = match_doc.group(1) if match_doc else '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">'

    novos_paras = texto_para_xml(texto)

    novo_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + abertura + '\n'
        + '  <w:background w:color="FFFFFF"/>\n'
        + '  <w:body>\n'
        + novos_paras + '\n'
        + '    ' + sect_pr + '\n'
        + '  </w:body>\n'
        + '</w:document>'
    )

    arquivos['word/document.xml'] = novo_xml.encode('utf-8')

    with zipfile.ZipFile(caminho_saida, 'w', zipfile.ZIP_DEFLATED) as z:
        for nome, conteudo in arquivos.items():
            z.writestr(nome, conteudo)

    return caminho_saida

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', required=True)
    parser.add_argument('saida')
    parser.add_argument('template', nargs='?', default='template_notificacao.docx')
    args = parser.parse_args()

    with open(args.file, 'r', encoding='utf-8') as f:
        texto = f.read()

    if not os.path.exists(args.template):
        print(f'Template não encontrado: {args.template}')
        sys.exit(1)

    gerar_docx(texto, args.template, args.saida)
    print(f'Documento gerado: {args.saida}')
