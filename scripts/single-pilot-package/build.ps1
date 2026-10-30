param([Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Push-Location $root
try {
  if (git status --porcelain) { throw 'Commit the isolated worktree before packaging' }
  $sha = (git rev-parse HEAD).Trim()
  $epoch = (git show -s --format=%ct HEAD).Trim()
  if (Test-Path -LiteralPath $Output) { throw 'Output must be a new directory' }
  New-Item -ItemType Directory -Path (Join-Path $Output 'input') | Out-Null
  $out = (Resolve-Path $Output).Path
  git archive --format=tar --output="$out/input/source.tar" $sha
  if ($LASTEXITCODE) { throw 'git archive failed' }
  $inputData = @{sha=$sha; epoch=$epoch; archiveHash=(Get-FileHash "$out/input/source.tar" -Algorithm SHA256).Hash.ToLowerInvariant()}
  [IO.File]::WriteAllText("$out/input/build-input.json", ($inputData | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  Copy-Item -LiteralPath "$PSScriptRoot/build.sh","$PSScriptRoot/package.mjs" -Destination "$out/input"
  $image = 'sha256:622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24'
  docker run --rm --name netvision-single-pilot-builder --mount "type=bind,source=$out/input,target=/audit,readonly" --mount "type=bind,source=$out,target=/output" --env NETVISION_INSTALLATION_ID=IMPLANTAR $image bash /audit/build.sh
  if ($LASTEXITCODE) { throw 'Linux package build failed' }
  Get-Content "$out/package.sha256"
} finally { Pop-Location }
