param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'CrabHub\jdbc'))
$ErrorActionPreference = 'Stop'
$artifacts = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'artifacts.json') -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
foreach ($artifact in $artifacts) {
    if ($artifact.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid pinned SHA256' }
    $target = Join-Path $Destination $artifact.name
    $valid = (Test-Path -LiteralPath $target) -and ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $artifact.sha256)
    if (-not $valid) {
        $download = $target + '.download'
        Invoke-WebRequest -UseBasicParsing -Uri ('https://repo.maven.apache.org/maven2/' + $artifact.path) -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $artifact.sha256) { throw ('Checksum failed for ' + $artifact.name) }
        Move-Item -Force -LiteralPath $download -Destination $target
    }
    Write-Output ($artifact.name + ' pinned SHA256 verified')
}