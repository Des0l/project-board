param([switch] $Open)

$ErrorActionPreference = 'Stop'
$boardNode = Join-Path $PSScriptRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $boardNode)) {
    $boardNode = (Get-Command node.exe -ErrorAction Stop).Source
}
$boardArgs = @((Join-Path $PSScriptRoot 'open-board.mjs'))
if (-not $Open) { $boardArgs += '--no-open' }
& $boardNode @boardArgs
exit $LASTEXITCODE
