#!/usr/bin/env python3
# ============================================================
# gerar_docx.py — Gera resposta à notificação com formatação
# do template oficial Sankhya S.A.
# Uso: python3 gerar_docx.py "texto da minuta" "saida.docx"
# ============================================================

import sys
import os
import shutil
import zipfile
import re
import xml.etree.ElementTree as ET
from pathlib import Path

# ── Namespaces Word ──
NS = {
    'w':   'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'w14': 'http://schemas.microsoft.com/office/word/2010/wordml',
    'r':   'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}

def esc(texto):
    """Escapa caracteres especiais XML."""
    return (texto
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;'))

def paragrafo_xml(texto, negrito=False, centralizado=False, tamanho=24, pid=None, espacamento_depois=0):
    """
    Gera XML de um parágrafo no estilo do template:
    - Fonte Roboto, cor 2e3c4f
    - Alinhamento justificado por padrão
    - Espaçamento de linha 276 (1.15)
    """
    jc = 'center' if centralizado else 'both'  # both = justificado
    bold_rpr = '<w:b w:val="1"/><w:bCs w:val="1"/>' if negrito else ''
    bold_ppr = '<w:b w:val="1"/><w:bCs w:val="1"/>' if negrito else ''
    spacing_depois = f'<w:after w:val="{espacamento_depois}"/>' if espacamento_depois else ''
    pid_attr = f'w14:paraId="{pid}"' if pid else ''

    texto_escapado = esc(texto)

    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:line="276" w:lineRule="auto" {spacing_depois}/>
        <w:jc w:val="{jc}"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:eastAsia="Roboto" w:hAnsi="Roboto"/>
          {bold_ppr}
          <w:color w:val="2e3c4f"/>
          <w:sz w:val="{tamanho}"/>
          <w:szCs w:val="{tamanho}"/>
        </w:rPr>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:eastAsia="Roboto" w:hAnsi="Roboto"/>
          {bold_rpr}
          <w:color w:val="2e3c4f"/>
          <w:sz w:val="{tamanho}"/>
          <w:szCs w:val="{tamanho}"/>
          <w:rtl w:val="0"/>
        </w:rPr>
        <w:t xml:space="preserve">{texto_escapado}</w:t>
      </w:r>
    </w:p>'''

def paragrafo_misto_xml(partes, centralizado=False, tamanho=24, pid=None):
    """
    Gera parágrafo com partes de texto, algumas em negrito.
    partes = lista de (texto, negrito)
    """
    jc = 'center' if centralizado else 'both'
    pid_attr = f'w14:paraId="{pid}"' if pid else ''

    runs = ''
    for texto, negrito in partes:
        bold = '<w:b w:val="1"/><w:bCs w:val="1"/>' if negrito else ''
        runs += f'''<w:r>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:eastAsia="Roboto" w:hAnsi="Roboto"/>
          {bold}
          <w:color w:val="2e3c4f"/>
          <w:sz w:val="{tamanho}"/>
          <w:szCs w:val="{tamanho}"/>
          <w:rtl w:val="0"/>
        </w:rPr>
        <w:t xml:space="preserve">{esc(texto)}</w:t>
      </w:r>'''

    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:line="276" w:lineRule="auto"/>
        <w:jc w:val="{jc}"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:eastAsia="Roboto" w:hAnsi="Roboto"/>
          <w:color w:val="2e3c4f"/>
          <w:sz w:val="{tamanho}"/>
          <w:szCs w:val="{tamanho}"/>
        </w:rPr>
      </w:pPr>
      {runs}
    </w:p>'''

def paragrafo_vazio_xml(pid=None):
    """Linha em branco."""
    pid_attr = f'w14:paraId="{pid}"' if pid else ''
    return f'''<w:p {pid_attr}>
      <w:pPr>
        <w:widowControl w:val="0"/>
        <w:spacing w:line="276" w:lineRule="auto"/>
        <w:rPr>
          <w:rFonts w:ascii="Roboto" w:cs="Roboto" w:eastAsia="Roboto" w:hAnsi="Roboto"/>
          <w:color w:val="2e3c4f"/>
          <w:sz w:val="24"/>
          <w:szCs w:val="24"/>
        </w:rPr>
      </w:pPr>
      <w:r><w:rPr><w:rtl w:val="0"/></w:rPr></w:r>
    </w:p>'''

def processar_linha(linha, pid_counter):
    """
    Converte uma linha de texto em XML de parágrafo,
    detectando negrito (**texto**) e padrões de formatação.
    """
    pid = f'{pid_counter:08X}'

    # Linha vazia
    if not linha.strip():
        return paragrafo_vazio_xml(pid=pid)

    texto = linha.strip()

    # Detecta partes com negrito **...**
    partes_raw = re.split(r'\*\*(.+?)\*\*', texto)
    tem_negrito = len(partes_raw) > 1

    if tem_negrito:
        partes = []
        for i, parte in enumerate(partes_raw):
            if parte:
                partes.append((parte, i % 2 == 1))
        # Verifica se toda a linha é negrito (título/seção)
        tudo_negrito = all(n for t, n in partes if t.strip())
        return paragrafo_misto_xml(partes, centralizado=tudo_negrito, pid=pid)
    else:
        # Linha toda em negrito se parece com título de seção (ex: "1. Resumo")
        e_titulo = bool(re.match(r'^(\d+\.?\s+[A-Z]|[A-Z]{3,})', texto))
        return paragrafo_xml(texto, negrito=e_titulo, pid=pid)

def texto_para_paragrafos_xml(texto_minuta):
    """Converte o texto completo da minuta em parágrafos XML."""
    linhas = texto_minuta.split('\n')
    paragrafos = []
    pid_counter = 1

    for linha in linhas:
        paragrafos.append(processar_linha(linha, pid_counter))
        pid_counter += 1

    return '\n'.join(paragrafos)

def gerar_docx(texto_minuta, caminho_template, caminho_saida):
    """
    Gera o documento Word final:
    1. Copia o template (preserva cabeçalho, rodapé, imagens)
    2. Substitui apenas o body com o texto da minuta formatado
    """
    # Copia o template para o arquivo de saída
    shutil.copy2(caminho_template, caminho_saida)

    # Lê o ZIP (docx é um ZIP)
    with zipfile.ZipFile(caminho_saida, 'r') as z:
        conteudo_original = z.read('word/document.xml').decode('utf-8')
        todos_arquivos = {name: z.read(name) for name in z.namelist()}

    # Extrai o sectPr (configurações de página, margens, cabeçalho/rodapé)
    match_sect = re.search(r'<w:sectPr>.*?</w:sectPr>', conteudo_original, re.DOTALL)
    sect_pr = match_sect.group(0) if match_sect else ''

    # Gera os novos parágrafos a partir do texto da minuta
    novos_paragrafos = texto_para_paragrafos_xml(texto_minuta)

    # Reconstrói o document.xml com os novos parágrafos + sectPr original
    # Preserva todos os namespaces do documento original
    match_abertura = re.match(r'(<\?xml[^>]*\?>\s*)?(<w:document[^>]*>)', conteudo_original)
    abertura_doc = match_abertura.group(0) if match_abertura else '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'

    novo_document_xml = f'''<?xml version="1.0" encoding="UTF-8"?>{abertura_doc}
  <w:background w:color="FFFFFF"/>
  <w:body>
{novos_paragrafos}
    {sect_pr}
  </w:body>
</w:document>'''

    # Reescreve o ZIP com o novo document.xml
    todos_arquivos['word/document.xml'] = novo_document_xml.encode('utf-8')

    with zipfile.ZipFile(caminho_saida, 'w', zipfile.ZIP_DEFLATED) as z:
        for nome, conteudo in todos_arquivos.items():
            z.writestr(nome, conteudo)

    return caminho_saida

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--file', help='Arquivo .txt com o texto da minuta')
    parser.add_argument('saida', help='Caminho do .docx de saída')
    parser.add_argument('template', nargs='?', default='template_notificacao.docx', help='Template .docx')
    args = parser.parse_args()

    if args.file:
        with open(args.file, 'r', encoding='utf-8') as f:
            texto = f.read()
    else:
        print('Forneça --file com o caminho do texto')
        sys.exit(1)

    if not os.path.exists(args.template):
        print(f'Template não encontrado: {args.template}')
        sys.exit(1)

    gerar_docx(texto, args.template, args.saida)
    print(f'Documento gerado: {args.saida}')
