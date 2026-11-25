$ErrorActionPreference = 'Stop'
$boardRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
$version = '1.0.4370.26'
$digest = '1c0dacac84b70109b3fd42f90c53a0ba942abc3a87590d7a4e0ccd86e4a06cf4'
$cache = New-Item -Force -Type Directory "$boardRoot\.work\portable-cache"
$package = Join-Path $cache.FullName "webview2-$version.nupkg"
function Get-PackageDigest($path) {
    $hash = [Security.Cryptography.SHA256]::Create()
    $file = [IO.File]::OpenRead($path)
    try { [BitConverter]::ToString($hash.ComputeHash($file)).Replace('-', '') }
    finally { $file.Dispose(); $hash.Dispose() }
}
if (!(Test-Path -LiteralPath $package) -or (Get-PackageDigest $package) -ne $digest) {
    $download = "$package.$PID.tmp"
    try {
        $client = New-Object Net.WebClient
        try { $client.DownloadFile("https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg", $download) }
        finally { $client.Dispose() }
        if ((Get-PackageDigest $download) -ne $digest) { throw 'WebView2 SDK checksum mismatch.' }
        Move-Item -LiteralPath $download -Destination $package -Force
    } finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download } }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
    $files = @{
        'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
        'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
        'LICENSE.txt' = 'runtime/webview2-LICENSE.txt'
        'NOTICE.txt' = 'runtime/webview2-NOTICE.txt'
    }
    foreach ($arch in 'x86', 'x64', 'arm64') {
        $loader = "runtimes/win-$arch/native/WebView2Loader.dll"
        $files[$loader] = $loader
    }
    foreach ($source in $files.Keys) {
        $target = Join-Path $boardRoot $files[$source]
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry($source), $target, $true)
    }
} finally { $archive.Dispose() }
& $compiler /nologo /target:winexe /platform:anycpu /utf8output /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/reference:$boardRoot\Microsoft.Web.WebView2.Core.dll" "/reference:$boardRoot\Microsoft.Web.WebView2.WinForms.dll" "/win32icon:$boardRoot\public\favicon.ico" "/out:$boardRoot\ProjectBoard.exe" "$boardRoot\desktop\ProjectBoard.cs"
exit $LASTEXITCODE
