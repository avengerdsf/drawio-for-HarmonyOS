# Restore only the verified Electron runtime; resources/app belongs to this repository.
[CmdletBinding()]
param([string]$ArchivePath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Net.Http

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..'))
$temporaryRoot = Join-Path $repositoryRoot 'tmp/runtime-restore'
$workRoot = Join-Path $temporaryRoot ([guid]::NewGuid().ToString('N'))

function Assert-NoLinks([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            $linkType = $item.PSObject.Properties['LinkType']
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($linkType -and $linkType.Value)) {
                throw "Links are not allowed: $current"
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-ContainedPath([string]$Root, [string]$Relative) {
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $fullPath = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe path outside destination: $fullPath"
    }
    Assert-NoLinks $fullPath
    return $fullPath
}

function Get-SafeEntryName($Entry) {
    $name = $Entry.FullName.Replace('\', '/')
    if (-not $name -or $name.StartsWith('/') -or $name -match '[\x00-\x1f:<>"|?*]') {
        throw "Unsafe ZIP path: $name"
    }
    foreach ($part in $name.TrimEnd('/').Split('/')) {
        if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$|^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:[.]|$)') {
            throw "Unsafe ZIP path or traversal: $name"
        }
    }
    $attributes = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$Entry.ExternalAttributes), 0)
    $fileType = ($attributes -shr 16) -band 0xF000
    if (($fileType -notin @(0, 0x4000, 0x8000)) -or ($attributes -band 0x400)) {
        throw "ZIP link or unsupported file type: $name"
    }
    return $name
}

if ($repositoryRoot -match '^[cC]:[\\/]') {
    throw 'Place the repository on a writable drive other than C: before restoring the runtime.'
}
Assert-NoLinks $projectRoot
Assert-NoLinks $temporaryRoot
$provenancePath = Join-Path $projectRoot 'runtime-provenance.json'
Assert-NoLinks $provenancePath
$runtime = (Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json).runtime
$expectedBytes = [long]$runtime.archiveBytes
$expectedHash = [string]$runtime.archiveSha256
$archiveUri = [uri]$runtime.archiveUrl
if ($expectedBytes -le 0 -or $expectedHash -notmatch '^[0-9a-fA-F]{64}$' -or
    -not $archiveUri.IsAbsoluteUri -or $archiveUri.Scheme -ne 'https' -or $archiveUri.UserInfo) {
    throw 'runtime-provenance.json must specify an HTTPS archive URL, positive archiveBytes and SHA256.'
}

$archiveStream = $null
$zip = $null
try {
    [void][IO.Directory]::CreateDirectory($workRoot)
    if ($ArchivePath) {
        $archiveFile = [IO.Path]::GetFullPath($ArchivePath)
        Assert-NoLinks $archiveFile
    } else {
        $archiveFile = Get-ContainedPath $workRoot 'runtime.zip'
        $client = [Net.Http.HttpClient]::new()
        $client.Timeout = [TimeSpan]::FromMinutes(30)
        $download = $null
        $output = $null
        try {
            Write-Host "Downloading $archiveUri"
            $download = $client.GetStreamAsync($archiveUri).GetAwaiter().GetResult()
            $output = [IO.File]::Create($archiveFile)
            $download.CopyTo($output)
        } finally {
            if ($output) { $output.Dispose() }
            if ($download) { $download.Dispose() }
            $client.Dispose()
        }
    }

    # Keep this handle open through extraction so the verified archive cannot be replaced.
    $archiveStream = [IO.File]::Open($archiveFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($archiveStream.Length -ne $expectedBytes) {
        throw "Archive byte count mismatch: expected $expectedBytes, received $($archiveStream.Length)."
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace('-', '') } finally { $sha256.Dispose() }
    if ($actualHash -ne $expectedHash) { throw 'Archive SHA256 mismatch.' }
    $archiveStream.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)

    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $libraryRoots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $resourceRoots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $entries = @()
    foreach ($entry in $zip.Entries) {
        $name = Get-SafeEntryName $entry
        if (-not $names.Add($name)) { throw "Ambiguous duplicate ZIP path: $name" }
        if ($name.EndsWith('/')) { continue }
        if ($name -match '^(?<root>(?:.+/)?libs/arm64-v8a/)(?<file>[^/]+[.]so)$') {
            [void]$libraryRoots.Add($Matches.root)
            $entries += @{ Entry = $entry; Kind = 'library'; Root = $Matches.root; Relative = $Matches.file }
        } elseif ($name -match '^(?<root>(?:.+/)?resfile/)(?<file>.+)$') {
            $root = $Matches.root
            $relative = $Matches.file
            if ($relative -match '^(locales|vulkan)/.+$|^(electron|icudtl[.]dat|[^/]+[.]pak|snapshot_blob[.]bin|v8_context_snapshot[.]bin)$') {
                [void]$resourceRoots.Add($root)
                $entries += @{ Entry = $entry; Kind = 'resource'; Root = $root; Relative = $relative }
            }
        }
    }
    if ($libraryRoots.Count -ne 1 -or $resourceRoots.Count -ne 1) {
        throw 'Cannot find a unique libs/arm64-v8a and resfile runtime layout; archive layout is missing or ambiguous.'
    }
    if (-not @($entries | Where-Object { $_.Kind -eq 'library' -and $_.Relative -eq 'libelectron.so' }).Count -or
        -not @($entries | Where-Object { $_.Kind -eq 'resource' -and $_.Relative -eq 'electron' }).Count) {
        throw 'Archive does not contain the expected Electron library and runtime executable.'
    }

    # Validate every destination, then stage all runtime files before changing the project.
    $destinations = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $entries) {
        $destinationRoot = if ($item.Kind -eq 'library') {
            Join-Path $projectRoot 'electron/libs/arm64-v8a'
        } else {
            Join-Path $projectRoot 'web_engine/src/main/resources/resfile'
        }
        $item.Destination = Get-ContainedPath $destinationRoot $item.Relative
        if (-not $destinations.Add($item.Destination)) { throw 'Ambiguous runtime destination.' }
        $item.Staged = Get-ContainedPath $workRoot ('staged/' + $item.Kind + '/' + $item.Relative)
    }
    foreach ($item in $entries) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Staged))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($item.Entry, $item.Staged, $false)
    }
    foreach ($item in $entries) {
        Assert-NoLinks $item.Destination
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Destination))
        [IO.File]::Copy($item.Staged, $item.Destination, $true)
    }
    Write-Host "Restored $($entries.Count) verified runtime files. resources/app was preserved."
} finally {
    if ($zip) { $zip.Dispose() }
    if ($archiveStream) { $archiveStream.Dispose() }
    # Delete only this invocation's directory after checking its absolute path and ancestors.
    $cleanupPath = Get-ContainedPath $temporaryRoot ([IO.Path]::GetFileName($workRoot))
    if (Test-Path -LiteralPath $cleanupPath) { Remove-Item -LiteralPath $cleanupPath -Recurse -Force }
}
