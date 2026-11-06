param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [Parameter(Mandatory=$true)][string]$EvidenceDir,
  [switch]$Resume,
  [switch]$SeedMain
)
$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$env:HOMOLOG_CONFIG_PATH=(Resolve-Path -LiteralPath $ConfigPath).Path
$env:HOMOLOG_EVIDENCE_DIR=(Resolve-Path -LiteralPath $EvidenceDir).Path
# run-homolog.ts sets the full MITIGATION_* contract together in each API child's
# environment, before any config/Prisma import. It validates the disposable identity.
Push-Location -LiteralPath $taskRoot
try {
  $taskArguments=@('--import','tsx','apps/api/src/scripts/homolog/run-homolog.ts')
  if($Resume){$taskArguments+='--resume'}
  if($SeedMain){$taskArguments+='--seed-main'}
  & node @taskArguments
  exit $LASTEXITCODE
} finally { Pop-Location }
