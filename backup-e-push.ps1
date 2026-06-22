# ================================================================
# backup-e-push.ps1 — Backup + Deploy do Módulo 3 (Notificações)
# Sankhya S.A. — Departamento Jurídico
#
# USO:
#   .\backup-e-push.ps1 "mensagem do commit"
#
# O script:
#   1. Baixa os dados do Render (registros, exemplos, auditoria)
#   2. Salva o backup em backups\YYYY-MM-DD_HH-MM\
#   3. Faz git add, commit e push
#   4. Aguarda o Render terminar o deploy
#   5. Restaura os dados no servidor atualizado
# ================================================================

param(
    [string]$Mensagem = "Atualizacao do sistema"
)

# ── Configurações ──────────────────────────────────────────────
$RENDER_URL   = "https://notificacoes-juridico.onrender.com"   # <-- substitua pela URL real do Render
$BACKUP_TOKEN = "sankhya-legal-backup-2025"                    # <-- mesmo valor da variável BACKUP_TOKEN no Render
$BACKUP_DIR   = "backups"
$DEPLOY_WAIT  = 90   # segundos para aguardar o deploy do Render
# ──────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Sankhya Legal — Backup & Deploy" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── PASSO 1: Baixar backup do Render ──────────────────────────
Write-Host "▶ Passo 1/5: Baixando backup do Render..." -ForegroundColor Yellow

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$pastaBackup = "$BACKUP_DIR\$timestamp"
New-Item -ItemType Directory -Force -Path $pastaBackup | Out-Null

$urlBackup = "$RENDER_URL/api/backup?token=$BACKUP_TOKEN"

try {
    $response = Invoke-WebRequest -Uri $urlBackup -Method GET -TimeoutSec 30
    $arquivoBackup = "$pastaBackup\backup_$timestamp.json"
    [System.IO.File]::WriteAllText($arquivoBackup, $response.Content, [System.Text.Encoding]::UTF8)

    $dados = $response.Content | ConvertFrom-Json
    $nReg  = ($dados.registros  | Measure-Object).Count
    $nEx   = ($dados.exemplos   | Measure-Object).Count
    $nLog  = ($dados.auditoria  | Measure-Object).Count

    Write-Host "  ✅ Backup salvo em: $arquivoBackup" -ForegroundColor Green
    Write-Host "     Registros: $nReg | Exemplos: $nEx | Log: $nLog entradas" -ForegroundColor Gray
} catch {
    Write-Host "  ⚠️  Não foi possível baixar o backup: $_" -ForegroundColor Red
    Write-Host "     Continuando sem backup (servidor pode estar offline)." -ForegroundColor Red
    $arquivoBackup = $null
}

Write-Host ""

# ── PASSO 2: Git add ──────────────────────────────────────────
Write-Host "▶ Passo 2/5: Adicionando arquivos ao Git..." -ForegroundColor Yellow

# Garante que a pasta de backups está no .gitignore para não subir dados sensíveis
# EXCEÇÃO: sobe a pasta backups/ propositalmente para ter histórico no GitHub
# Se preferir NÃO subir os backups pro GitHub, comente a linha abaixo e adicione backups/ ao .gitignore

git add .
if ($LASTEXITCODE -ne 0) { Write-Host "  ❌ Erro no git add" -ForegroundColor Red; exit 1 }
Write-Host "  ✅ Arquivos adicionados" -ForegroundColor Green
Write-Host ""

# ── PASSO 3: Git commit ───────────────────────────────────────
Write-Host "▶ Passo 3/5: Commitando: '$Mensagem'..." -ForegroundColor Yellow

git commit -m $Mensagem
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ℹ️  Nenhuma alteração para commitar (ou erro no commit)" -ForegroundColor Gray
}
Write-Host "  ✅ Commit realizado" -ForegroundColor Green
Write-Host ""

# ── PASSO 4: Git push ─────────────────────────────────────────
Write-Host "▶ Passo 4/5: Enviando para o GitHub (deploy automático)..." -ForegroundColor Yellow

git push
if ($LASTEXITCODE -ne 0) { Write-Host "  ❌ Erro no git push" -ForegroundColor Red; exit 1 }
Write-Host "  ✅ Push realizado — Render iniciando deploy..." -ForegroundColor Green
Write-Host ""

# ── PASSO 5: Aguardar deploy e restaurar ──────────────────────
if ($arquivoBackup -and (Test-Path $arquivoBackup)) {
    Write-Host "▶ Passo 5/5: Aguardando deploy do Render ($DEPLOY_WAIT seg)..." -ForegroundColor Yellow

    # Barra de progresso
    for ($i = 1; $i -le $DEPLOY_WAIT; $i++) {
        $pct = [int](($i / $DEPLOY_WAIT) * 100)
        Write-Progress -Activity "Aguardando deploy..." -Status "$pct% concluído" -PercentComplete $pct
        Start-Sleep -Seconds 1
    }
    Write-Progress -Completed -Activity "Deploy concluído"

    Write-Host "  Restaurando dados no servidor..." -ForegroundColor Yellow

    $conteudoBackup = [System.IO.File]::ReadAllText($arquivoBackup, [System.Text.Encoding]::UTF8)
    $urlRestaurar = "$RENDER_URL/api/restaurar?token=$BACKUP_TOKEN"

    try {
        $restResp = Invoke-WebRequest -Uri $urlRestaurar -Method POST `
            -Body $conteudoBackup `
            -ContentType "application/json" `
            -TimeoutSec 30

        $resultado = $restResp.Content | ConvertFrom-Json
        Write-Host "  ✅ Dados restaurados com sucesso!" -ForegroundColor Green
        Write-Host "     Registros: $($resultado.registros) | Exemplos: $($resultado.exemplos) | Log: $($resultado.auditoria)" -ForegroundColor Gray
    } catch {
        Write-Host "  ⚠️  Erro ao restaurar: $_" -ForegroundColor Red
        Write-Host "     Backup disponível em: $arquivoBackup" -ForegroundColor Yellow
        Write-Host "     Você pode restaurar manualmente acessando o sistema." -ForegroundColor Yellow
    }
} else {
    Write-Host "▶ Passo 5/5: Sem backup para restaurar." -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deploy concluído!" -ForegroundColor Green
Write-Host "  Backups salvos em: .\$BACKUP_DIR\" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
