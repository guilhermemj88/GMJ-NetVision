<#
.SYNOPSIS
    Valida as MIBs do NetVision em duas camadas: PRISTINE (mibs/, nunca alterada) e
    VALIDATION OVERLAY (cópia temporária com as correções mínimas dos defeitos externos).

.DESCRIPTION
    1. copia mibs/{huawei,ietf,iana} para um diretório temporário;
    2. aplica SOMENTE no temporário os overlays de mibs/validation/known-issues.json
       (5 símbolos duplicados do HUAWEI-MIB, 9 identificadores com '-' final do
       HUAWEI-TC-MIB e substituição do RFC-1212 por um módulo SMIv1 equivalente);
    3. roda o validador (pysmi/mibdump) por módulo nas duas árvores;
    4. grava mibs/validation/results/validation-<timestamp>.json;
    5. apaga o temporário (salvo -Keep).

    Os arquivos em mibs/ nunca são modificados.

.EXAMPLE
    pwsh -File tools/mibs/prepare-validation-tree.ps1
.EXAMPLE
    pwsh -File tools/mibs/prepare-validation-tree.ps1 -Keep -Validator C:\Python312\Scripts\mibdump.exe
#>
[CmdletBinding()]
param(
    [string]$MibsRoot,
    [string]$Validator,
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'

if (-not $MibsRoot) {
    $MibsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\mibs')).Path
}
if (-not (Test-Path $MibsRoot)) { throw "MibsRoot nao encontrado: $MibsRoot" }

function Resolve-Validator {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "Validador informado nao existe: $Explicit" }
        return $Explicit
    }
    $cmd = Get-Command mibdump -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $py = Get-Command python -ErrorAction SilentlyContinue
    if ($py) {
        $candidate = Join-Path (Split-Path $py.Source -Parent) 'Scripts\mibdump.exe'
        if (Test-Path $candidate) { return $candidate }
        $candidate = Join-Path (Split-Path $py.Source -Parent) 'Scripts/mibdump'
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'Validador nao encontrado. Instale com "pip install pysmi" ou informe -Validator <caminho do mibdump>.'
}

function Get-ModuleFiles {
    param([string]$Root)
    $dirs = 'huawei', 'ietf', 'iana'
    return Get-ChildItem ($dirs | ForEach-Object { Join-Path $Root $_ }) -File -Filter *.mib |
        Sort-Object BaseName
}

function Invoke-MibValidation {
    param(
        [string]$ValidatorPath,
        [string]$Root,
        [string[]]$Modules
    )
    $sources = ('huawei', 'ietf', 'iana') | ForEach-Object {
        $p = (Join-Path $Root $_).Replace('\', '/')
        "--mib-source=file:///$p"
    }
    $result = [ordered]@{}
    foreach ($m in $Modules) {
        $argsList = @($sources) + @('--destination-format=null', '--rebuild', $m)
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $ValidatorPath
        $psi.Arguments = ($argsList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $out = $proc.StandardOutput.ReadToEnd()
        $err = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        $rc = $proc.ExitCode
        $text = "$out`n$err"
        $fail = [regex]::Match($text, 'Failed MIBs:\s*(?<d>[^\r\n]+)')
        $detail = if ($fail.Success) { ($fail.Groups['d'].Value -replace '\s+', ' ').Trim() } else { '' }
        $result[$m] = [pscustomobject]@{
            status = if ($rc -eq 0) { 'PASS' } else { 'FAIL' }
            exit   = $rc
            detail = $detail
        }
    }
    return $result
}

function Apply-Overlay {
    param([string]$Root)

    $applied = [System.Collections.Generic.List[string]]::new()

    # --- HUAWEI-MIB: renomear a 2a ocorrencia dos 5 simbolos duplicados
    $mibPath = Join-Path $Root 'huawei\HUAWEI-MIB.mib'
    $lines = [IO.File]::ReadAllLines($mibPath)
    $dups = @{
        'eudemon200S' = 2; 'USG6635F' = 2; 'USG6525F' = 2; 'USG6565F' = 2; 'ne40ex16b' = 2
    }
    $renamed = 0
    foreach ($sym in $dups.Keys) {
        $seen = 0
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^\s*$([regex]::Escape($sym))\s+OBJECT IDENTIFIER") {
                $seen++
                if ($seen -eq $dups[$sym]) {
                    $lines[$i] = $lines[$i] -replace "^\s*$([regex]::Escape($sym))\s+", "$sym-DUP    "
                    $renamed++
                }
            }
        }
    }
    [IO.File]::WriteAllLines($mibPath, $lines)
    $applied.Add("HUAWEI-MIB: $renamed simbolo(s) duplicado(s) renomeado(s) no overlay")

    # --- HUAWEI-TC-MIB: remover '-' final dos identificadores invalidos
    $tcPath = Join-Path $Root 'huawei\HUAWEI-TC-MIB.mib'
    $tc = [IO.File]::ReadAllText($tcPath)
    $fixed = [regex]::Replace($tc, '(subbname8090DEV[A-Z0-9-]*[A-Z0-9])-\(', '$1(')
    $count = ([regex]::Matches($tc, 'subbname8090DEV[A-Z0-9-]*[A-Z0-9]-\(', 'IgnoreCase')).Count
    [IO.File]::WriteAllText($tcPath, $fixed)
    $applied.Add("HUAWEI-TC-MIB: $count identificador(es) com '-' final corrigido(s) no overlay")

    # --- RFC-1212: substituir o stub de libsmi por um modulo SMIv1 equivalente (so no overlay)
    $rfcPath = Join-Path $Root 'ietf\RFC-1212.mib'
    $synthetic = @'
RFC-1212 DEFINITIONS ::= BEGIN

OBJECT-TYPE
    MACRO ::=
    BEGIN
        TYPE NOTATION ::=
                          "SYNTAX" type (TYPE ObjectSyntax)
                          "ACCESS" Access
                          "STATUS" Status
        VALUE NOTATION ::=
                          value (VALUE ObjectName)

        Access ::= "read-only"
                 | "read-write"
                 | "write-only"
                 | "not-accessible"
        Status ::= "mandatory"
                 | "optional"
                 | "obsolete"
    END

END
'@
    [IO.File]::WriteAllText($rfcPath, $synthetic)
    $applied.Add('RFC-1212: stub de libsmi substituido por modulo SMIv1 equivalente (somente no overlay)')

    return $applied
}

$validatorPath = Resolve-Validator -Explicit $Validator
Write-Host "MibsRoot  : $MibsRoot"
Write-Host "Validador : $validatorPath"
Write-Host ""

$modules = (Get-ModuleFiles -Root $MibsRoot).BaseName
Write-Host "== PRISTINE ($($modules.Count) modulos) =="
$pristine = Invoke-MibValidation -ValidatorPath $validatorPath -Root $MibsRoot -Modules $modules

$tmpRoot = Join-Path ([IO.Path]::GetTempPath()) ("netvision-mib-validation-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpRoot | Out-Null
foreach ($d in 'huawei', 'ietf', 'iana') {
    Copy-Item (Join-Path $MibsRoot $d) (Join-Path $tmpRoot $d) -Recurse
}
$overlayNotes = Apply-Overlay -Root $tmpRoot
Write-Host "== VALIDATION OVERLAY ($tmpRoot) =="
$overlay = Invoke-MibValidation -ValidatorPath $validatorPath -Root $tmpRoot -Modules $modules

Write-Host ""
Write-Host ("{0,-24} {1,-12} {2,-10} {3}" -f 'MODULO', 'PRISTINE', 'OVERLAY', 'DETALHE (pristine)')
foreach ($m in $modules) {
    $p = $pristine[$m]; $o = $overlay[$m]
    $detail = if ($p.detail) { $p.detail.Substring(0, [Math]::Min(70, $p.detail.Length)) } else { '' }
    Write-Host ("{0,-24} {1,-12} {2,-10} {3}" -f $m, $p.status, $o.status, $detail)
}

$pristineFail = ($modules | Where-Object { $pristine[$_].status -ne 'PASS' }).Count
$overlayFail = ($modules | Where-Object { $overlay[$_].status -ne 'PASS' }).Count
Write-Host ""
Write-Host ("resumo: pristine PASS={0} FAIL={1} | overlay PASS={2} FAIL={3}" -f `
    ($modules.Count - $pristineFail), $pristineFail, ($modules.Count - $overlayFail), $overlayFail)

$knownIssues = Get-Content (Join-Path $MibsRoot 'validation\known-issues.json') -Raw | ConvertFrom-Json
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$report = [ordered]@{
    timestamp    = $timestamp
    validator    = $validatorPath
    mibsRoot     = $MibsRoot
    overlayNotes = $overlayNotes
    pristine     = $pristine
    overlay      = $overlay
    summary      = [ordered]@{
        modules          = $modules.Count
        pristinePass     = $modules.Count - $pristineFail
        pristineFail     = $pristineFail
        overlayPass      = $modules.Count - $overlayFail
        overlayFail      = $overlayFail
        knownIssueIds    = @($knownIssues.issues | ForEach-Object { $_.id })
    }
}
$resultsDir = Join-Path $MibsRoot 'validation\results'
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
$reportPath = Join-Path $resultsDir "validation-$timestamp.json"
$report | ConvertTo-Json -Depth 6 | Set-Content $reportPath -Encoding UTF8
Write-Host "resultado gravado em: $reportPath"

if ($Keep) {
    Write-Host "temporario mantido: $tmpRoot"
} else {
    Remove-Item $tmpRoot -Recurse -Force
    Write-Host 'temporario removido'
}

if ($overlayFail -gt 0) { exit 2 } else { exit 0 }
