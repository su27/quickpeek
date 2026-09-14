# Native unit tests can retain Tauri's Common Controls imports. Unlike the app
# executable, Cargo's library test harness does not inherit Tauri's manifest.
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '../src-tauri')
try {
    $messages = & cargo rustc --lib --profile test --message-format=json -- -C link-arg=/MANIFEST:EMBED -C "link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $artifacts = @($messages | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object {
        $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable
    })
    if ($artifacts.Count -ne 1) { throw 'Expected one native test executable' }
    & $artifacts[0].executable @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
