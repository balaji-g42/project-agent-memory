param([string]$VaultPath)

$ErrorActionPreference = "Stop"

$vault = if ($VaultPath) { $VaultPath } elseif ($env:CLAUDE_VAULT) { $env:CLAUDE_VAULT } else { Join-Path $env:USERPROFILE ".claude\vault" }

if (-not (Test-Path (Join-Path $vault ".git"))) {
    Write-Host "Vault at $vault is not a git repo - nothing to sync."
    exit 0
}

Set-Location $vault
git pull --rebase --autostash
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (git status --porcelain)) {
    Write-Host "Vault clean, nothing to push."
    exit 0
}

git add -A
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git commit -m "memory: sync from $env:COMPUTERNAME $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git push
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Vault synced."
