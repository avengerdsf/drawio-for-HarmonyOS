$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$testRoot = Join-Path $repositoryRoot ('tmp/runtime-restore/tests-' + [guid]::NewGuid().ToString('N'))
$restoreScript = Join-Path $PSScriptRoot 'Restore-ElectronRuntime.ps1'
$passed = 0

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function New-Fixture([string]$Name, [hashtable]$ExtraEntries = @{}) {
    $root = Join-Path $testRoot $Name
    $project = Join-Path $root 'harmony-electron'
    $tools = Join-Path $project 'tools'
    [void][IO.Directory]::CreateDirectory($tools)
    Copy-Item -LiteralPath $restoreScript -Destination $tools
    $app = Join-Path $project 'web_engine/src/main/resources/resfile/resources/app/upstream'
    [void][IO.Directory]::CreateDirectory($app)
    [IO.File]::WriteAllText((Join-Path $app 'index.html'), 'committed drawio')
    $zipPath = Join-Path $root 'runtime.zip'
    $entries = @{
        'release/libs/arm64-v8a/libelectron.so' = 'electron so'
        'release/libs/arm64-v8a/libadapter.so' = 'adapter so'
        'release/libs/arm64-v8a/not-a-library.txt' = 'ignore me'
        'release/libs/x86_64/libelectron.so' = 'wrong architecture'
        'release/entry/src/main/resources/resfile/electron' = 'runtime binary'
        'release/entry/src/main/resources/resfile/icudtl.dat' = 'unicode data'
        'release/entry/src/main/resources/resfile/resources.pak' = 'resource pack'
        'release/entry/src/main/resources/resfile/chrome_100_percent.pak' = 'chrome pack'
        'release/entry/src/main/resources/resfile/snapshot_blob.bin' = 'snapshot'
        'release/entry/src/main/resources/resfile/v8_context_snapshot.bin' = 'v8 snapshot'
        'release/entry/src/main/resources/resfile/locales/zh-CN.pak' = 'locale'
        'release/entry/src/main/resources/resfile/vulkan/libvulkan.so' = 'vulkan'
        'release/entry/src/main/resources/resfile/resources/app/upstream/index.html' = 'unwanted overwrite'
        'release/entry/src/main/resources/resfile/resources/app/package.json' = 'unwanted app'
        'release/entry/src/main/resources/resfile/unrelated.txt' = 'ignore me'
    }
    foreach ($key in $ExtraEntries.Keys) { $entries[$key] = $ExtraEntries[$key] }
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $entries.Keys) {
            $entry = $zip.CreateEntry($name)
            $writer = [IO.StreamWriter]::new($entry.Open())
            try { $writer.Write($entries[$name]) } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    $manifest = @{
        runtime = @{
            archiveUrl = 'https://example.invalid/runtime.zip'
            archiveBytes = (Get-Item -LiteralPath $zipPath).Length
            archiveSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $provenance = Join-Path $project 'runtime-provenance.json'
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $provenance -Encoding utf8
    return @{ Root = $root; Project = $project; Zip = $zipPath; Manifest = $manifest; Provenance = $provenance }
}

function Invoke-Restore($Fixture) {
    & (Join-Path $Fixture.Project 'tools/Restore-ElectronRuntime.ps1') -ArchivePath $Fixture.Zip | Out-Null
}

function Assert-Clean($Fixture) {
    $temporaryRoot = Join-Path $Fixture.Root 'tmp/runtime-restore'
    Assert ((-not (Test-Path -LiteralPath $temporaryRoot)) -or
        @(Get-ChildItem -LiteralPath $temporaryRoot -Force).Count -eq 0) 'Restore left temporary files.'
    Assert (Test-Path -LiteralPath $Fixture.Zip) 'Restore deleted the caller-owned archive.'
    $index = Join-Path $Fixture.Project 'web_engine/src/main/resources/resfile/resources/app/upstream/index.html'
    Assert ([IO.File]::ReadAllText($index) -eq 'committed drawio') 'Restore changed committed app sources.'
}

function Expect-Rejected($Fixture, [string]$Pattern) {
    $failure = $null
    try { Invoke-Restore $Fixture } catch { $failure = $_ }
    Assert ($null -ne $failure) 'An invalid archive was accepted.'
    Assert ($failure.Exception.Message -match $Pattern) "Unexpected failure: $($failure.Exception.Message)"
    Assert (-not (Test-Path -LiteralPath (Join-Path $Fixture.Project 'electron/libs/arm64-v8a/libelectron.so'))) 'Validation failure wrote runtime output.'
    Assert-Clean $Fixture
}

try {
    Assert (Test-Path -LiteralPath $restoreScript) 'Restore script is not implemented.'
    [void][IO.Directory]::CreateDirectory($testRoot)

    $fixture = New-Fixture 'mapping'
    Invoke-Restore $fixture
    $resfile = Join-Path $fixture.Project 'web_engine/src/main/resources/resfile'
    Assert ([IO.File]::ReadAllText((Join-Path $fixture.Project 'electron/libs/arm64-v8a/libelectron.so')) -eq 'electron so') 'arm64 library mapping failed.'
    Assert ([IO.File]::ReadAllText((Join-Path $resfile 'electron')) -eq 'runtime binary') 'Runtime executable mapping failed.'
    Assert ([IO.File]::ReadAllText((Join-Path $resfile 'locales/zh-CN.pak')) -eq 'locale') 'Locale mapping failed.'
    Assert ([IO.File]::ReadAllText((Join-Path $resfile 'vulkan/libvulkan.so')) -eq 'vulkan') 'Vulkan mapping failed.'
    Assert (Test-Path -LiteralPath (Join-Path $resfile 'snapshot_blob.bin')) 'Snapshot was not restored.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $resfile 'unrelated.txt'))) 'Non-runtime content was restored.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $resfile 'resources/app/package.json'))) 'Archive app content was restored.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $fixture.Project 'electron/libs/arm64-v8a/not-a-library.txt'))) 'Non-library content was restored.'
    Assert-Clean $fixture
    $passed++; Write-Host 'PASS: runtime mapping, committed app preservation, caller archive preservation, cleanup'

    $fixture = New-Fixture 'hash-failure'
    $fixture.Manifest.runtime.archiveSha256 = '0' * 64
    $fixture.Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $fixture.Provenance -Encoding utf8
    Expect-Rejected $fixture 'SHA256'
    $passed++; Write-Host 'PASS: wrong SHA256 rejected before writes, cleanup'

    $fixture = New-Fixture 'size-failure'
    $fixture.Manifest.runtime.archiveBytes++
    $fixture.Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $fixture.Provenance -Encoding utf8
    Expect-Rejected $fixture 'byte|size'
    $passed++; Write-Host 'PASS: wrong byte count rejected before writes, cleanup'

    $fixture = New-Fixture 'traversal' @{ 'release/../../outside.txt' = 'escaped' }
    Expect-Rejected $fixture 'unsafe|traversal'
    Assert (-not (Test-Path -LiteralPath (Join-Path $testRoot 'outside.txt'))) 'ZIP traversal escaped the project.'
    $passed++; Write-Host 'PASS: ZIP traversal rejected even outside selected runtime entries'

    $fixture = New-Fixture 'zip-link'
    $zip = [IO.Compression.ZipFile]::Open($fixture.Zip, [IO.Compression.ZipArchiveMode]::Update)
    try { $zip.GetEntry('release/libs/arm64-v8a/libelectron.so').ExternalAttributes = [int](-1577123840) } finally { $zip.Dispose() }
    $fixture.Manifest.runtime.archiveBytes = (Get-Item -LiteralPath $fixture.Zip).Length
    $fixture.Manifest.runtime.archiveSha256 = (Get-FileHash -LiteralPath $fixture.Zip -Algorithm SHA256).Hash
    $fixture.Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $fixture.Provenance -Encoding utf8
    Expect-Rejected $fixture 'link|file type'
    $passed++; Write-Host 'PASS: ZIP symbolic link rejected'

    $fixture = New-Fixture 'ambiguous' @{ 'other/libs/arm64-v8a/libelectron.so' = 'ambiguous' }
    Expect-Rejected $fixture 'ambiguous|unique'
    $passed++; Write-Host 'PASS: ambiguous runtime layout rejected'

    $fixture = New-Fixture 'filesystem-link'
    $libraryDirectory = Join-Path $fixture.Project 'electron/libs/arm64-v8a'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($libraryDirectory))
    $outside = Join-Path $fixture.Root 'outside'
    [void][IO.Directory]::CreateDirectory($outside)
    New-Item -ItemType Junction -Path $libraryDirectory -Target $outside | Out-Null
    Expect-Rejected $fixture 'link'
    Assert (@(Get-ChildItem -LiteralPath $outside -Force).Count -eq 0) 'Runtime write followed a filesystem junction.'
    $passed++; Write-Host 'PASS: destination junction rejected'

    $fixture = New-Fixture 'hardlink'
    $libraryDirectory = Join-Path $fixture.Project 'electron/libs/arm64-v8a'
    [void][IO.Directory]::CreateDirectory($libraryDirectory)
    $originalApp = Join-Path $fixture.Project 'web_engine/src/main/resources/resfile/resources/app/upstream/index.html'
    New-Item -ItemType HardLink -Path (Join-Path $libraryDirectory 'libelectron.so') -Target $originalApp | Out-Null
    $failure = $null
    try { Invoke-Restore $fixture } catch { $failure = $_ }
    Assert ($null -ne $failure -and $failure.Exception.Message -match 'link') 'Destination hardlink was accepted.'
    Assert-Clean $fixture
    $passed++; Write-Host 'PASS: destination hardlink cannot overwrite committed app sources'

    Write-Host "$passed integration checks passed."
} finally {
    $expectedParent = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'tmp/runtime-restore')) + [IO.Path]::DirectorySeparatorChar
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTestRoot.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup outside project temporary directory: $resolvedTestRoot"
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}
