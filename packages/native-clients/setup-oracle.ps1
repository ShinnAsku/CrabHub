param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'CrabHub\native\oracle-23.26.3'))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$filename = 'instantclient-basic-windows.x64-23.26.3.0.0.zip'
$expected = '4c7fe8a77f6b9a00d57214ffda241f14f79dad5774a8f53073b7497e54b51763'
$url = 'https://download.oracle.com/otn_software/nt/instantclient/2326300/' + $filename
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$archive = Join-Path $Destination $filename
if (-not (Test-Path $archive)) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile ($archive + '.partial') -TimeoutSec 300
    if ((Get-FileHash ($archive + '.partial') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
        throw 'Oracle client SHA256 mismatch; archive has not been extracted.'
    }
    Move-Item -LiteralPath ($archive + '.partial') -Destination $archive
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Oracle client SHA256 mismatch; archive has not been extracted.'
}
$library = Get-ChildItem -LiteralPath $Destination -Filter oci.dll -Recurse | Select-Object -First 1
if (-not $library) {
    Expand-Archive -LiteralPath $archive -DestinationPath $Destination
    $library = Get-ChildItem -LiteralPath $Destination -Filter oci.dll -Recurse | Select-Object -First 1
}
if (-not $library) { throw 'Oracle archive did not contain oci.dll.' }
$env:PATH = $library.DirectoryName + ';' + $env:PATH
Write-Output ('Oracle Basic 23.26.3 SHA256 verified. Client directory: ' + $library.DirectoryName)
Write-Output 'PATH was updated for this PowerShell session only. Launch CrabHub from this session or configure its process PATH.'