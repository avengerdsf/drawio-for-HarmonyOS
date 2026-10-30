$ErrorActionPreference = 'Stop'

$script:ElectronWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:ElectronTemporaryRoot = Join-Path $script:ElectronWorkspace 'tmp'
$script:ElectronToolHome = Join-Path $script:ElectronTemporaryRoot 'electron-home'
$script:ElectronCliRoot = Join-Path $script:ElectronTemporaryRoot 'electron-cli'
$script:ElectronCliEntry = Join-Path $script:ElectronCliRoot 'dist\cli.js'
$script:ElectronStudio = $env:DEVECO_PATH
if (-not $script:ElectronStudio) { throw 'Set DEVECO_PATH to your DevEco Studio installation directory.' }
$script:ElectronNode = Join-Path $script:ElectronStudio 'tools\node\node.exe'
$script:ElectronHdc = Join-Path $script:ElectronStudio 'sdk\default\openharmony\toolchains\hdc.exe'
$script:ElectronHdcAddress = '127.0.0.1:8710'
$script:ElectronPadAddress = $env:DRAWIO_PAD_ADDRESS
if (-not (Get-Variable ElectronAuthorizationSource -Scope Script -ErrorAction SilentlyContinue)) {
    $script:ElectronAuthorizationSource = Join-Path $env:USERPROFILE '.harmony'
}

function Assert-ElectronTemporaryPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($script:ElectronTemporaryRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Tool cache path must remain inside the project tmp directory.'
    }
    if ((Test-Path -LiteralPath $absolute) -and
        ((Get-Item -LiteralPath $absolute -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Tool cache root cannot be a link.'
    }
}

function Find-ElectronInstalledCli {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $link = Get-Item -LiteralPath (Join-Path $script:ElectronCliRoot 'node_modules') -Force -ErrorAction SilentlyContinue
    if ($link -and $link.LinkType -eq 'Junction') {
        $candidates.Add((Split-Path -Parent ([string]@($link.Target)[0])))
    }
    foreach ($command in @(Get-Command devecocli -All -CommandType Application,ExternalScript -ErrorAction SilentlyContinue)) {
        $candidates.Add((Join-Path (Split-Path -Parent $command.Source) 'node_modules\@deveco\deveco-cli'))
    }
    foreach ($candidate in $candidates | Select-Object -Unique) {
        $packagePath = Join-Path $candidate 'package.json'
        if ((Test-Path -LiteralPath $packagePath) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'dist\cli.js')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'node_modules'))) {
            $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
            if ($package.name -eq '@deveco/deveco-cli') { return [IO.Path]::GetFullPath($candidate) }
        }
    }
    throw 'The installed global @deveco/deveco-cli package was not found on PATH.'
}

function Initialize-ElectronCli {
    $source = Find-ElectronInstalledCli
    $package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
    $patch = 'if(process.env.DEVECO_PATH){let e=E.resolve(process.env.DEVECO_PATH);if(!r.isExistingDirectory(e))throw new Error("DEVECO_PATH must reference DevEco Studio");return r._cachedInstallRoot=e;}'
    $modules = Join-Path $script:ElectronCliRoot 'node_modules'
    if ((Test-Path -LiteralPath $script:ElectronCliEntry) -and (Test-Path -LiteralPath $modules)) {
        $cachedPackage = Get-Content -LiteralPath (Join-Path $script:ElectronCliRoot 'package.json') -Raw | ConvertFrom-Json
        $cachedCode = [IO.File]::ReadAllText($script:ElectronCliEntry)
        $cachedModules = Get-Item -LiteralPath $modules -Force
        if ($cachedPackage.version -eq $package.version -and $cachedCode.Contains($patch) -and
            $cachedModules.LinkType -eq 'Junction' -and
            [IO.Path]::GetFullPath([string]@($cachedModules.Target)[0]) -eq [IO.Path]::GetFullPath((Join-Path $source 'node_modules'))) {
            return
        }
    }
    Assert-ElectronTemporaryPath $script:ElectronCliRoot
    $code = [IO.File]::ReadAllText((Join-Path $source 'dist\cli.js'))
    $anchor = 'static async findDevEcoStudio(){'
    if ($package.version -ne '1.2.0' -or
        ([regex]::Matches($code, [regex]::Escape($anchor))).Count -ne 1) {
        throw 'The installed CLI differs from the verified 1.2.0 DEVECO_PATH patch; inspect the new version before using it.'
    }
    $code = $code.Replace($anchor, $anchor + $patch)
    New-Item -ItemType Directory -Path $script:ElectronCliRoot -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
        if ($item.Name -eq 'node_modules') { continue }
        $destination = Join-Path $script:ElectronCliRoot $item.Name
        Assert-ElectronTemporaryPath $destination
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Unexpected link in the installed CLI package.'
        }
        Copy-Item -LiteralPath $item.FullName -Destination $script:ElectronCliRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $modules) {
        $cachedModules = Get-Item -LiteralPath $modules -Force
        if ($cachedModules.LinkType -ne 'Junction' -or
            [IO.Path]::GetFullPath([string]@($cachedModules.Target)[0]) -ne [IO.Path]::GetFullPath((Join-Path $source 'node_modules'))) {
            throw 'An unexpected node_modules cache exists; inspect it before rebuilding the CLI cache.'
        }
    } else {
        New-Item -ItemType Junction -Path $modules -Target (Join-Path $source 'node_modules') | Out-Null
    }
    [IO.File]::WriteAllText($script:ElectronCliEntry, $code, [Text.UTF8Encoding]::new($false))
}

$electronDirectories = @{
    LocalAppData = 'AppData\Local'
    AppData = 'AppData\Roaming'
    Temporary = 'temp'
    Hvigor = '.hvigor'
    NpmCache = 'cache\npm'
    NpmPrefix = 'npm'
    NodeCache = 'cache\node'
    Ohpm = '.ohpm'
    XdgCache = 'cache'
    XdgConfig = 'config'
    XdgData = 'data'
    Logs = 'logs'
    HdcLogs = 'logs\hdc'
    Pids = 'pids'
}
foreach ($electronRelativePath in $electronDirectories.Values) {
    New-Item -ItemType Directory -Path (Join-Path $script:ElectronToolHome $electronRelativePath) -Force | Out-Null
}

$env:DEVECO_PATH = $script:ElectronStudio
$env:DEVECO_SDK_HOME = Join-Path $script:ElectronStudio 'sdk'
$env:USERPROFILE = $script:ElectronToolHome
$env:HOMEDRIVE = [IO.Path]::GetPathRoot($script:ElectronToolHome).TrimEnd('\')
$env:HOMEPATH = $script:ElectronToolHome.Substring($env:HOMEDRIVE.Length)
$env:LOCALAPPDATA = Join-Path $script:ElectronToolHome $electronDirectories.LocalAppData
$env:APPDATA = Join-Path $script:ElectronToolHome $electronDirectories.AppData
$env:TEMP = Join-Path $script:ElectronToolHome $electronDirectories.Temporary
$env:TMP = $env:TEMP
$env:HVIGOR_USER_HOME = Join-Path $script:ElectronToolHome $electronDirectories.Hvigor
$env:NPM_CONFIG_CACHE = Join-Path $script:ElectronToolHome $electronDirectories.NpmCache
$env:NPM_CONFIG_PREFIX = Join-Path $script:ElectronToolHome $electronDirectories.NpmPrefix
$env:NODE_COMPILE_CACHE = Join-Path $script:ElectronToolHome $electronDirectories.NodeCache
$env:NODE_REPL_HISTORY = Join-Path $script:ElectronToolHome 'logs\node-history'
$env:OHPM_HOME = Join-Path $script:ElectronToolHome $electronDirectories.Ohpm
$env:XDG_CACHE_HOME = Join-Path $script:ElectronToolHome $electronDirectories.XdgCache
$env:XDG_CONFIG_HOME = Join-Path $script:ElectronToolHome $electronDirectories.XdgConfig
$env:XDG_DATA_HOME = Join-Path $script:ElectronToolHome $electronDirectories.XdgData
$env:COREPACK_HOME = Join-Path $script:ElectronToolHome 'cache\corepack'
$env:YARN_CACHE_FOLDER = Join-Path $script:ElectronToolHome 'cache\yarn'
$env:GRADLE_USER_HOME = Join-Path $script:ElectronToolHome '.gradle'
$env:JAVA_HOME = Join-Path $script:ElectronStudio 'jbr'
$env:JAVA_TOOL_OPTIONS = "-Duser.home=$script:ElectronToolHome -Djava.io.tmpdir=$env:TEMP"
$env:_JAVA_OPTIONS = $env:JAVA_TOOL_OPTIONS
$env:JDK_JAVA_OPTIONS = $env:JAVA_TOOL_OPTIONS
$env:OHOS_HDC_SERVER_PORT = '8710'
$env:HDC_SERVER_PORT = '8710'
$env:OHOS_HDC_CMD_RECORD = '0'
$env:OHOS_HDC_LOG_DIR = Join-Path $script:ElectronToolHome $electronDirectories.HdcLogs
$env:HDC_LOG_PATH = $env:OHOS_HDC_LOG_DIR
$env:PATH = "$(Split-Path -Parent $script:ElectronNode);$env:JAVA_HOME\bin;$env:PATH"

if (Get-Module -Name PSReadLine) {
    Set-PSReadLineOption -HistorySaveStyle SaveNothing
}

function devecocli {
    Initialize-ElectronCli
    & $script:ElectronNode $script:ElectronCliEntry @args
    if ($LASTEXITCODE -ne 0) { throw "devecocli exited with code $LASTEXITCODE" }
}

function Initialize-ElectronHdcAuthorization {
    $destination = Join-Path $script:ElectronToolHome '.harmony'
    Assert-ElectronTemporaryPath $destination
    $privatePresent = Test-Path -LiteralPath (Join-Path $destination 'hdckey')
    $publicPresent = Test-Path -LiteralPath (Join-Path $destination 'hdckey.pub')
    if ($privatePresent -and $publicPresent) { return }
    if ($privatePresent -or $publicPresent) { throw 'The temporary HDC key pair is incomplete; inspect that cache before using it.' }
    foreach ($name in @('hdckey', 'hdckey.pub')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:ElectronAuthorizationSource $name))) {
            throw 'The existing authorized HDC key pair is unavailable; authorize the device before using this session tool.'
        }
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    foreach ($name in @('hdckey', 'hdckey.pub')) {
        $file = Join-Path $destination $name
        Assert-ElectronTemporaryPath $file
        if (-not (Test-Path -LiteralPath $file)) {
            Copy-Item -LiteralPath (Join-Path $script:ElectronAuthorizationSource $name) -Destination $file
        }
    }
}

function InvokeElectronHdc {
    Initialize-ElectronHdcAuthorization
    $electronHdcOutput = @(& $script:ElectronHdc '-s' $script:ElectronHdcAddress @args 2>&1)
    $electronHdcExit = $LASTEXITCODE
    $electronInstallFailed = ($args -contains 'install') -and
        ($electronHdcOutput -match '(?i)(?:error:.*(?:install|grant)|failed to install bundle|install failed)')
    if ($electronHdcExit -ne 0 -or ($electronHdcOutput -match '^\[Fail\]') -or $electronInstallFailed) {
        throw "HDC command failed (exit code $electronHdcExit)."
    }
    $electronHdcOutput
}

function InvokeElectronPadHdc {
    InvokeElectronHdc '-t' $script:ElectronPadAddress @args
}

function Initialize-ElectronPadConnection {
    $electronTargets = (@(InvokeElectronHdc list targets '-v')) -join "`n"
    $electronConnected = '(?m)^' + [regex]::Escape($script:ElectronPadAddress) + '\s+TCP\s+(?:Connected|Ready)\b'
    if ($electronTargets -notmatch $electronConnected) {
        InvokeElectronHdc tconn $script:ElectronPadAddress | Out-Null
    }
}

function Update-ElectronPadActivity {
    $electronActivityPath = Join-Path $script:ElectronToolHome 'pids\pad-session.activity'
    if (Test-Path -LiteralPath $electronActivityPath) {
        [IO.File]::SetLastWriteTimeUtc($electronActivityPath, [DateTime]::UtcNow)
    }
}
