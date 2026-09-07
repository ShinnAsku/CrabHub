$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '5.42.3.1'
$expectedHash = '6a081a811781c30aca51dbc036afd93092af91e3297901f02c17043795a10690'
$tools = Join-Path $env:LOCALAPPDATA 'CrabHub\build-tools'
$directory = Join-Path $tools "strawberry-perl-$version"
$perl = Join-Path $directory 'perl\bin\perl.exe'
if (!(Test-Path -LiteralPath $perl)) {
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    $archive = Join-Path $tools "strawberry-perl-$version.zip"
    if (!(Test-Path -LiteralPath $archive)) {
        $uri = "https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/SP_54231_64bit/strawberry-perl-$version-64bit-portable.zip"
        $proxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]$uri)
        $request = @{ Uri=$uri; OutFile=$archive; UseBasicParsing=$true; TimeoutSec=600 }
        if ($proxy.AbsoluteUri -ne $uri) {
            $request.Proxy = $proxy
            $request.ProxyUseDefaultCredentials = $true
        }
        Invoke-WebRequest @request
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'Portable Perl SHA256 does not match the official release; no tools extracted'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
}
& $perl -MIPC::Cmd -MTime::Piece -e 'print $^V'
if ($LASTEXITCODE -ne 0) { throw 'Portable Perl module verification failed' }
$env:PERL = $perl
Write-Output "PERL is configured for this terminal only: $perl"