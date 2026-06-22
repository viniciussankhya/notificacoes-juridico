# ================================================================
# backup-e-push.ps1 - Backup + Deploy do Modulo 3 (Notificacoes)
# Sankhya S.A. - Departamento Juridico
#
# USO:
#   .\backup-e-push.ps1 "mensagem do commit"
# ================================================================

param(
    [string]$Mensagem = "Atualizacao do sistema"
)

$RENDER_URL   = "https://notificacoes-juridico.onrender.com"
$BACKUP_TOKEN = "sankhya-legal-backup-2025"
$BACKUP_DIR   = "backups"
$DEPLOY_WAIT  = 90

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Sankhya Legal - Backup and Deploy" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# PASSO 1: Baixar backup do Render
Write-Host "[1/5] Baixando backup do Render..." -ForegroundColor Yellow

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$pastaBackup = "$BACKUP_DIR\$timestamp"
New-Item -ItemType Directory -Force -Path $pastaBackup | Out-Null

$urlBackup = "$RENDER_URL/api/backup?token=$BACKUP_TOKEN"
$arquivoBackup = $null

try {
    $response = Invoke-WebRequest -Uri $urlBackup -Method GET -TimeoutSec 30
    $arquivoBackup = "$pastaBackup\backup_$timestamp.json"
    [System.IO.File]::WriteAllText($arquivoBackup, $response.Content, [System.Text.Encoding]::UTF8)

    $dados = $response.Content | ConvertFrom-Json
    $nReg  = ($dados.registros  | Measure-Object).Count
    $nEx   = ($dados.exemplos   | Measure-Object).Count
    $nLog  = ($dados.auditoria  | Measure-Object).Count

    Write-Host "  OK - Backup salvo: $arquivoBackup" -ForegroundColor Green
    Write-Host "  Registros: $nReg | Exemplos: $nEx | Log: $nLog entradas" -ForegroundColor Gray
} catch {
    Write-Host "  AVISO - Nao foi possivel baixar o backup: $_" -ForegroundColor Red
    Write-Host "  Continuando sem backup." -ForegroundColor Red
}

Write-Host ""

# PASSO 2: Git add
Write-Host "[2/5] Adicionando arquivos ao Git..." -ForegroundColor Yellow
git add .
if ($LASTEXITCODE -ne 0) { Write-Host "  ERRO no git add" -ForegroundColor Red; exit 1 }
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# PASSO 3: Git commit
Write-Host "[3/5] Commitando: '$Mensagem'..." -ForegroundColor Yellow
git commit -m $Mensagem
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Nenhuma alteracao para commitar." -ForegroundColor Gray
}
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# PASSO 4: Git push
Write-Host "[4/5] Enviando para o GitHub..." -ForegroundColor Yellow
git push
if ($LASTEXITCODE -ne 0) { Write-Host "  ERRO no git push" -ForegroundColor Red; exit 1 }
Write-Host "  OK - Render iniciando deploy..." -ForegroundColor Green
Write-Host ""

# PASSO 5: Aguardar deploy e restaurar
if ($arquivoBackup -and (Test-Path $arquivoBackup)) {
    Write-Host "[5/5] Aguardando deploy do Render ($DEPLOY_WAIT seg)..." -ForegroundColor Yellow

    for ($i = 1; $i -le $DEPLOY_WAIT; $i++) {
        $pct = [int](($i / $DEPLOY_WAIT) * 100)
        Write-Progress -Activity "Aguardando deploy..." -Status "$pct% concluido" -PercentComplete $pct
        Start-Sleep -Seconds 1
    }
    Write-Progress -Completed -Activity "Deploy concluido"

    Write-Host "  Restaurando dados no servidor..." -ForegroundColor Yellow

    $conteudoBackup = [System.IO.File]::ReadAllText($arquivoBackup, [System.Text.Encoding]::UTF8)
    $urlRestaurar = "$RENDER_URL/api/restaurar?token=$BACKUP_TOKEN"

    try {
        $restResp = Invoke-WebRequest -Uri $urlRestaurar -Method POST `
            -Body $conteudoBackup `
            -ContentType "application/json" `
            -TimeoutSec 30

        $resultado = $restResp.Content | ConvertFrom-Json
        Write-Host "  OK - Dados restaurados!" -ForegroundColor Green
        Write-Host "  Registros: $($resultado.registros) | Exemplos: $($resultado.exemplos) | Log: $($resultado.auditoria)" -ForegroundColor Gray
    } catch {
        Write-Host "  AVISO - Erro ao restaurar: $_" -ForegroundColor Red
        Write-Host "  Backup disponivel em: $arquivoBackup" -ForegroundColor Yellow
    }
} else {
    Write-Host "[5/5] Sem backup para restaurar." -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deploy concluido!" -ForegroundColor Green
Write-Host "  Backups salvos em: .\$BACKUP_DIR\" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
