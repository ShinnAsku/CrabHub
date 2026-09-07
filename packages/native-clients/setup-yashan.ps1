param([string]$Destination = (Join-Path $env:USERPROFILE '.yashandb\client'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '23.4.7.100'
$filename = 'yashandb-client-' + $version + '-win64-amd64.zip'
$expected = '031a5c7265a3b253eb08b7666bcbfafe4e4db789062c6ed2199484b69e0de387'
$url = 'https://github.com/yashan-technologies/yashandb-client/releases/download/' + $version + '/' + $filename
$staging = Join-Path $env:LOCALAPPDATA ('CrabHub\native\yashan-' + $version)
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$archive = Join-Path $staging $filename
if (-not (Test-Path $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile ($archive + '.partial') -TimeoutSec 180
    if ((Get-FileHash ($archive + '.partial') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Yashan client SHA256 mismatch.' }
    Move-Item -LiteralPath ($archive + '.partial') -Destination $archive
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Yashan client SHA256 mismatch.' }
$unpacked = Join-Path $staging 'unpacked'
if (-not (Test-Path $unpacked)) { Expand-Archive -LiteralPath $archive -DestinationPath $unpacked }
$library = Get-ChildItem -LiteralPath $unpacked -Filter yascli.dll -Recurse | Select-Object -First 1
if (-not $library) { throw 'Yashan archive has no yascli.dll.' }
$target = Join-Path $Destination 'lib'
if (Test-Path (Join-Path $target 'yascli.dll')) { throw 'An existing Yashan client is present; refusing to overwrite it.' }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $library.DirectoryName '*') -Destination $target -Recurse
Write-Output ('YashanDB client ' + $version + ' SHA256 verified and installed to ' + $target)