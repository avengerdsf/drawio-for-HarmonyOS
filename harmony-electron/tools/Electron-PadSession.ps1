param(
    [scriptblock]$Action = {},
    [int[]]$UnlockKeys = @(),
    [ValidateRange(1, 45)][int]$MaxAwakeSeconds = 45,
    [ValidateRange(0, 300)][int]$IdleTimeoutSeconds = 0,
    [switch]$Watchdog
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Use-ElectronTools.ps1')
$electronActivityPath = Join-Path $script:ElectronToolHome 'pids\pad-session.activity'

function Suspend-ElectronPad {
    Initialize-ElectronPadConnection
    try { InvokeElectronPadHdc shell power-shell timeout -o 10000 | Out-Null } finally {
        InvokeElectronPadHdc shell power-shell suspend | Out-Null
    }
}

if ($Watchdog) {
    if ($IdleTimeoutSeconds -gt 0) {
        while (Test-Path -LiteralPath $electronActivityPath) {
            $lastActivity = [IO.File]::GetLastWriteTimeUtc($electronActivityPath)
            if (([DateTime]::UtcNow - $lastActivity).TotalSeconds -ge $IdleTimeoutSeconds) { break }
            Start-Sleep -Seconds 2
        }
    } else {
        Start-Sleep -Seconds $MaxAwakeSeconds
    }
    Suspend-ElectronPad
    exit
}

function Test-ElectronPadLocked {
    $electronLockState = (InvokeElectronPadHdc shell hidumper -s ScreenlockService -a '-all') -join "`n"
    if ($electronLockState -match 'screenLocked\s*(?:[:=]\s*)?true') { return $true }
    if ($electronLockState -match 'screenLocked\s*(?:[:=]\s*)?false') { return $false }
    throw 'Cannot determine the Pad lock state.'
}

function Get-ElectronUnlockButtons {
    InvokeElectronPadHdc shell uitest uiInput swipe 2304 1536 2304 384 1200 | Out-Null
    function Visit-ElectronUnlockNode($Node, [bool]$Inside) {
        $electronAttributes = $Node.attributes
        $electronInside = $Inside -or ($electronAttributes.id -eq 'BouncerView')
        if ($electronInside -and $electronAttributes.type -eq 'Stack' -and [string]$electronAttributes.clickable -eq 'true') {
            $electronBounds = [regex]::Matches([string]$electronAttributes.bounds, '-?\d+')
            if ($electronBounds.Count -eq 4) {
                $electronLeft, $electronTop, $electronRight, $electronBottom = @($electronBounds | ForEach-Object { [int]$_.Value })
                $electronWidth = $electronRight - $electronLeft
                $electronHeight = $electronBottom - $electronTop
                if ($electronWidth -eq $electronHeight -and $electronWidth -gt 80) {
                    $electronButtons.Add([pscustomobject]@{ X = [int](($electronLeft + $electronRight) / 2); Y = [int](($electronTop + $electronBottom) / 2) })
                }
            }
        }
        foreach ($electronChild in $Node.children) { Visit-ElectronUnlockNode $electronChild $electronInside }
    }
    $electronDeadline = [DateTime]::UtcNow.AddSeconds(5)
    $electronReswiped = $false
    do {
        InvokeElectronPadHdc shell uitest dumpLayout '-p/data/local/tmp/drawio-electron-unlock.json' | Out-Null
        $electronLayout = ((InvokeElectronPadHdc shell cat '/data/local/tmp/drawio-electron-unlock.json') -join "`n") | ConvertFrom-Json
        if ($electronLayout -is [array]) { $electronLayout = [pscustomobject]@{attributes=[pscustomobject]@{};children=$electronLayout} }
        $electronButtons = [System.Collections.Generic.List[object]]::new()
        Visit-ElectronUnlockNode $electronLayout $false
        if ($electronButtons.Count -eq 11) { return @($electronButtons | Sort-Object Y, X) }
        if (-not $electronReswiped) {
            InvokeElectronPadHdc shell uitest uiInput swipe 2304 1536 2304 384 1200 | Out-Null
            $electronReswiped = $true
        }
        Update-ElectronPadActivity
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $electronDeadline)
    throw 'The verified 11-button BouncerView layout was not found.'
}

$electronWatchdogProcess = $null
$electronWatchdogPidPath = Join-Path $script:ElectronToolHome 'pids\pad-session-watchdog.pid'
try {
    Initialize-ElectronPadConnection
    if (@($UnlockKeys | Where-Object { $_ -lt 2000 -or $_ -gt 2009 }).Count) { throw 'UnlockKeys contains an unsupported hardware code.' }
    $electronPowerShell = (Get-Process -Id $PID).Path
    if ($IdleTimeoutSeconds -gt 0) {
        [IO.File]::WriteAllText($electronActivityPath, [string]$PID)
    }
    $electronWatchdogProcess = Start-Process -FilePath $electronPowerShell -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'),
        '-Watchdog', '-MaxAwakeSeconds', [string]$MaxAwakeSeconds,
        '-IdleTimeoutSeconds', [string]$IdleTimeoutSeconds
    ) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $script:ElectronToolHome 'logs\pad-watchdog.stdout.log') `
      -RedirectStandardError (Join-Path $script:ElectronToolHome 'logs\pad-watchdog.stderr.log') -PassThru
    [System.IO.File]::WriteAllText($electronWatchdogPidPath, [string]$electronWatchdogProcess.Id)
    $electronInitiallyLocked = Test-ElectronPadLocked
    $electronPowerTimeout = if ($IdleTimeoutSeconds -gt 0) { $IdleTimeoutSeconds * 1000 } else { $MaxAwakeSeconds * 1000 }
    InvokeElectronPadHdc shell power-shell timeout -o $electronPowerTimeout | Out-Null
    InvokeElectronPadHdc shell power-shell wakeup | Out-Null
    if (Test-ElectronPadLocked) {
        if (-not $UnlockKeys.Count) { throw 'The Pad is locked; pass the authorized hardware-code array through UnlockKeys.' }
        $electronButtons = Get-ElectronUnlockButtons
        foreach ($electronCode in $UnlockKeys) {
            if (-not (Test-ElectronPadLocked)) { break }
            $electronDigit = $electronCode - 2000
            $electronIndex = if ($electronDigit -eq 0) { 9 } else { $electronDigit - 1 }
            $electronButton = $electronButtons[$electronIndex]
            InvokeElectronPadHdc shell uitest uiInput click $electronButton.X $electronButton.Y | Out-Null
        }
        $electronStillLocked = $true
        for ($electronAttempt = 0; $electronAttempt -lt 10; $electronAttempt++) {
            Start-Sleep -Milliseconds 100
            $electronStillLocked = Test-ElectronPadLocked
            if (-not $electronStillLocked) { break }
        }
        if ($electronStillLocked) { throw 'The single authorized unlock attempt did not complete.' }
    }
    & $Action
} finally {
    try { Suspend-ElectronPad } finally {
        if ($electronWatchdogProcess -and -not $electronWatchdogProcess.HasExited) {
            Stop-Process -Id $electronWatchdogProcess.Id -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $electronWatchdogPidPath) { Remove-Item -LiteralPath $electronWatchdogPidPath -Force }
        if ($IdleTimeoutSeconds -gt 0 -and (Test-Path -LiteralPath $electronActivityPath) -and
            [IO.File]::ReadAllText($electronActivityPath) -eq [string]$PID) {
            Remove-Item -LiteralPath $electronActivityPath -Force
        }
        try { InvokeElectronPadHdc shell rm -f '/data/local/tmp/drawio-electron-unlock.json' | Out-Null } catch {}
        if ($UnlockKeys.Count) { [Array]::Clear($UnlockKeys, 0, $UnlockKeys.Count) }
    }
}
