$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
& (Join-Path $PSScriptRoot 'setup-windows-perl.ps1')
$version = '3.6.4'
$tools = Join-Path $env:LOCALAPPDATA 'CrabHub\build-tools'
$prefix = Join-Path $tools "openssl-$version-static"
$executable = Join-Path $prefix 'bin\openssl.exe'
if (!(Test-Path -LiteralPath $executable)) {
    $base = "https://github.com/openssl/openssl/releases/download/openssl-$version/openssl-$version.tar.gz"
    $archive = Join-Path $tools "openssl-$version.tar.gz"
    $checksum = "$archive.sha256"
    foreach ($download in @(@{Uri="$base.sha256";Path=$checksum}, @{Uri=$base;Path=$archive})) {
        if (!(Test-Path -LiteralPath $download.Path)) {
            $proxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]$download.Uri)
            $request = @{Uri=$download.Uri;OutFile=$download.Path;UseBasicParsing=$true;TimeoutSec=600}
            if ($proxy.AbsoluteUri -ne $download.Uri) {
                $request.Proxy = $proxy
                $request.ProxyUseDefaultCredentials = $true
            }
            Invoke-WebRequest @request
        }
    }
    $expectedHash = ([IO.File]::ReadAllText($checksum) -split '\s+')[0].ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'OpenSSL archive differs from its official SHA256; no code executed'
    }
    if (!(Test-Path -LiteralPath (Join-Path $tools "openssl-$version\Configure"))) {
        & tar.exe -xf $archive -C $tools
        if ($LASTEXITCODE -ne 0) { throw 'OpenSSL extraction failed' }
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$visualStudio) { throw 'Visual Studio C++ x64 build tools are required' }
    $log = Join-Path $tools "openssl-$version-build.log"
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & (Join-Path $PSScriptRoot 'build-windows-openssl.cmd') $visualStudio (Join-Path $tools "openssl-$version") $prefix *> $log
        $buildExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $preference }
    if ($buildExit -ne 0) { throw "OpenSSL build failed with exit $buildExit; see $log" }
}
$reported = & $executable version
if ($LASTEXITCODE -ne 0 -or $reported -notmatch '^OpenSSL 3\.6\.4\b') { throw 'Unexpected OpenSSL build version' }
foreach ($library in @('lib\libssl.lib', 'lib\libcrypto.lib', 'include\openssl\opensslv.h')) {
    if (!(Test-Path -LiteralPath (Join-Path $prefix $library))) { throw "Missing OpenSSL build artifact: $library" }
}
$env:OPENSSL_DIR = $prefix
$env:OPENSSL_STATIC = '1'
$env:OPENSSL_NO_VENDOR = '1'
Write-Output "$reported; configured OPENSSL_DIR for this terminal only: $prefix"