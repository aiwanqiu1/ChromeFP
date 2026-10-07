param(
    [string]$NodePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$BrowserArguments = @()
)

$ErrorActionPreference = 'Stop'

function ConvertTo-ChromeFpArgument {
    param([AllowEmptyString()][string]$Value)
    # Start-Process joins ArgumentList with spaces. Quote each Windows argument,
    # doubling backslashes before embedded quotes and before the closing quote.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Show-ChromeFpError {
    param([string]$Detail, [string]$LogDirectory)
    $message = "ChromeFP 启动失败。`r`n`r`n" + $Detail
    if ($LogDirectory) {
        $message += "`r`n`r`n本次运行日志：`r`n" + $LogDirectory
    }
    $message += "`r`n`r`n也可以运行 start-chrome.cmd 查看完整诊断信息。"
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($message, 0, 'ChromeFP 浏览器', 16)
    }
    catch {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($message, 'ChromeFP 浏览器', 'OK', 'Error')
    }
}

function Get-ChromeFpReusableProfile {
    param([string]$ProjectRoot, [string[]]$BrowserArguments = @())
    $name = 'default'
    if ($BrowserArguments.Count -eq 2 -and $BrowserArguments[0] -eq '--profile') {
        $name = $BrowserArguments[1]
    }
    elseif ($BrowserArguments.Count -ne 0) { return $null }
    if (-not $name -or $name.Length -gt 128 -or $name.StartsWith('.') -or
        $name -match '[<>:"/\\|?*\x00-\x1f]' -or $name -match '[.\s]$' -or
        $name -match '^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)') { return $null }
    $base = Join-Path $ProjectRoot 'profiles'
    $directory = [IO.Path]::GetFullPath((Join-Path $base $name))
    # Leave reparse-point validation and all explicit configuration to the CLI.
    if (Test-Path -LiteralPath $directory) {
        if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $null }
    }
    return $directory
}

function Get-ChromeFpMutexName {
    param([string]$ProfileDirectory)
    $normalized = [IO.Path]::GetFullPath($ProfileDirectory).TrimEnd('\').ToUpperInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)) }
    finally { $sha.Dispose() }
    return 'Local\ChromeFP-' + ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())
}

function New-ChromeFpSessionMutex {
    param([string]$ProfileDirectory)
    return [Threading.Mutex]::new($false, (Get-ChromeFpMutexName $ProfileDirectory))
}

function Initialize-ChromeFpWindowApi {
    if ('ChromeFp.NativeWindows' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ChromeFp {
    public static class NativeWindows {
        private delegate bool Callback(IntPtr hwnd, IntPtr data);
        [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr data);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
        public static IntPtr FindVisibleWindow(uint processId) {
            IntPtr found = IntPtr.Zero;
            EnumWindows((hwnd, data) => {
                uint candidate; GetWindowThreadProcessId(hwnd, out candidate);
                if (candidate == processId && IsWindowVisible(hwnd)) { found = hwnd; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }
        public static void RestoreAndActivate(IntPtr hwnd) {
            if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9);
            SetForegroundWindow(hwnd);
        }
    }
}
'@
}

function Get-ChromeFpProfileWindow {
    param([string]$ProjectRoot, [string]$ProfileDirectory)
    $lockFile = Join-Path $ProfileDirectory '.fp-launcher.lock'
    if (-not [IO.File]::Exists($lockFile)) { return $null }
    try {
        $lock = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $ownerId = [int]$lock.pid
        if ($ownerId -le 0) { return $null }
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction Stop
        $entry = Join-Path $ProjectRoot 'fp-browser.mjs'
        $entryPattern = '(?i)(?:^|\s)"?' + [regex]::Escape($entry) + '"?(?:\s|$)'
        if (-not $owner -or $owner.Name -ne 'node.exe' -or $owner.CommandLine -notmatch $entryPattern) { return $null }
        $candidates = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownerId AND Name = 'chrome.exe'" -ErrorAction Stop)
        foreach ($candidate in $candidates) {
            if ($candidate.CommandLine -match '(?i)(?:^|\s)--headless(?:=|\s|$)') { continue }
            $match = [regex]::Match($candidate.CommandLine, '(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+)|--user-data-dir\s+"([^"]+)"|--user-data-dir\s+([^\s"]+))', 'IgnoreCase')
            if (-not $match.Success) { continue }
            $claimedDirectory = $null
            foreach ($group in $match.Groups | Select-Object -Skip 1) { if ($group.Success) { $claimedDirectory = $group.Value; break } }
            $claimedDirectory = [IO.Path]::GetFullPath($claimedDirectory).TrimEnd('\')
            if (-not [string]::Equals($claimedDirectory, $ProfileDirectory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { continue }
            Initialize-ChromeFpWindowApi
            return [pscustomobject]@{
                ProcessId = [uint32]$candidate.ProcessId
                WindowHandle = [ChromeFp.NativeWindows]::FindVisibleWindow([uint32]$candidate.ProcessId)
                NodePath = $owner.ExecutablePath
            }
        }
    }
    catch { return $null }
    return $null
}

function TryShow-ChromeFpProfile {
    param([string]$ProjectRoot, [string]$ProfileDirectory, [string]$NodePath, [bool]$AllowRestore = $false)
    $window = Get-ChromeFpProfileWindow -ProjectRoot $ProjectRoot -ProfileDirectory $ProfileDirectory
    if (-not $window) { return $false }
    if ($window.WindowHandle -eq [IntPtr]::Zero) {
        if (-not $AllowRestore) { return $false }
        if (-not $NodePath -or -not [IO.File]::Exists($NodePath)) { $NodePath = $window.NodePath }
        $helper = Join-Path $ProjectRoot 'lib\restore-window.mjs'
        if (-not [IO.File]::Exists($helper) -or -not [IO.File]::Exists($NodePath)) { return $false }
        $logs = Join-Path $ProjectRoot 'logs'
        [void][IO.Directory]::CreateDirectory($logs)
        $restoreId = [guid]::NewGuid().ToString('N')
        $parts = @((ConvertTo-ChromeFpArgument $helper), (ConvertTo-ChromeFpArgument $ProfileDirectory))
        $restorer = Start-Process -FilePath $NodePath -ArgumentList ($parts -join ' ') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs ($restoreId + '.restore.out.log')) -RedirectStandardError (Join-Path $logs ($restoreId + '.restore.err.log'))
        try {
            $null = $restorer.Handle
            if (-not $restorer.WaitForExit(20000)) { $restorer.Kill(); throw '恢复现有浏览器窗口超时，请稍后重试。' }
            $restorer.Refresh()
            if ($restorer.ExitCode -ne 0) { throw '已检测到运行中的环境，但无法恢复窗口。请查看 logs 目录中的 restore 日志。' }
        }
        finally { $restorer.Dispose() }
        for ($attempt = 0; $attempt -lt 15; $attempt++) {
            $window.WindowHandle = [ChromeFp.NativeWindows]::FindVisibleWindow($window.ProcessId)
            if ($window.WindowHandle -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 100
        }
    }
    if ($window.WindowHandle -ne [IntPtr]::Zero) {
        [ChromeFp.NativeWindows]::RestoreAndActivate($window.WindowHandle)
        try {
            $shell = New-Object -ComObject WScript.Shell
            try { [void]$shell.AppActivate([int]$window.ProcessId) }
            finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
        }
        catch {}
    }
    if ($window.WindowHandle -eq [IntPtr]::Zero) { throw '已有浏览器仍在后台运行，但没有恢复可见窗口。请稍后重试。' }
    return $true
}

function Invoke-ChromeFpLauncher {
    param(
        [string]$ProjectRoot,
        [string]$NodePath,
        [string[]]$BrowserArguments = @(),
        [int]$ReuseWaitMilliseconds = 120000
    )
    $logDirectory = $null
    $errorLog = $null
    $process = $null
    $sessionMutex = $null
    $sessionReady = $null
    $ownsSessionMutex = $false
    try {
        $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath
        $logDirectory = Join-Path $ProjectRoot 'logs'
        [void][System.IO.Directory]::CreateDirectory($logDirectory)
        $runId = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $outputLog = Join-Path $logDirectory ($runId + '.out.log')
        $errorLog = Join-Path $logDirectory ($runId + '.err.log')
        $entryPoint = Join-Path $ProjectRoot 'fp-browser.mjs'
        if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
            throw '找不到 fp-browser.mjs。请保留启动器与项目文件的相对位置。'
        }
        $profileDirectory = Get-ChromeFpReusableProfile -ProjectRoot $ProjectRoot -BrowserArguments $BrowserArguments
        if ($profileDirectory) {
            $sessionMutex = New-ChromeFpSessionMutex -ProfileDirectory $profileDirectory
            $sessionReady = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, ((Get-ChromeFpMutexName $profileDirectory) + '-ready'))
            $waitTimer = [Diagnostics.Stopwatch]::StartNew()
            while ($true) {
                if (TryShow-ChromeFpProfile -ProjectRoot $ProjectRoot -ProfileDirectory $profileDirectory -NodePath $NodePath -AllowRestore ($sessionReady.WaitOne(0))) {
                    [void]$sessionReady.Set()
                    return 0
                }
                try { $ownsSessionMutex = $sessionMutex.WaitOne(200) }
                catch {
                    $waitFailure = $_.Exception
                    while ($waitFailure -and $waitFailure -isnot [Threading.AbandonedMutexException]) { $waitFailure = $waitFailure.InnerException }
                    if ($waitFailure -is [Threading.AbandonedMutexException]) { $ownsSessionMutex = $true }
                    else { throw }
                }
                if ($ownsSessionMutex) {
                    if (TryShow-ChromeFpProfile -ProjectRoot $ProjectRoot -ProfileDirectory $profileDirectory -NodePath $NodePath -AllowRestore $true) {
                        [void]$sessionReady.Set()
                        return 0
                    }
                    [void]$sessionReady.Reset()
                    break
                }
                if ($waitTimer.ElapsedMilliseconds -ge $ReuseWaitMilliseconds) {
                    throw '这个浏览器环境仍在启动中，请稍候再点击快捷方式。'
                }
            }
        }
        if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($nodeCommand) { $NodePath = $nodeCommand.Source }
        }
        if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            throw '找不到 Node.js。请安装 Node.js 22 或更新版本，再重新创建快捷方式。'
        }
        $NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
        $argumentParts = @((ConvertTo-ChromeFpArgument $entryPoint))
        foreach ($argument in $BrowserArguments) {
            $argumentParts += ConvertTo-ChromeFpArgument $argument
        }
        $process = Start-Process -FilePath $NodePath -ArgumentList ($argumentParts -join ' ') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
        # Keep the PowerShell launcher alive for the entire browser session.
        # Read Handle first so Windows PowerShell retains the child's exit code.
        $null = $process.Handle
        $readyObserved = $false
        while (-not $process.WaitForExit(500)) {
            if ($sessionReady -and -not $readyObserved) {
                $window = Get-ChromeFpProfileWindow -ProjectRoot $ProjectRoot -ProfileDirectory $profileDirectory
                if ($window -and $window.WindowHandle -ne [IntPtr]::Zero) {
                    [void]$sessionReady.Set()
                    $readyObserved = $true
                }
            }
        }
        $process.Refresh()
        if ($null -eq $process.ExitCode) { throw '无法读取启动器退出状态。请查看运行日志。' }
        $exitCode = [int]$process.ExitCode
        if ($exitCode -ne 0) {
            $detail = '启动器已退出，错误代码：' + $exitCode
            $tail = @(Get-Content -LiteralPath $errorLog -Encoding UTF8 -Tail 12 -ErrorAction SilentlyContinue) -join "`r`n"
            if (-not $tail.Trim()) {
                $tail = @(Get-Content -LiteralPath $outputLog -Encoding UTF8 -Tail 12 -ErrorAction SilentlyContinue) -join "`r`n"
            }
            $tail = $tail -replace '\x1b\[[0-9;]*m', ''
            if ($tail.Length -gt 1400) { $tail = $tail.Substring($tail.Length - 1400) }
            if ($tail.Trim()) { $detail += "`r`n`r`n" + $tail }
            Show-ChromeFpError -Detail $detail -LogDirectory $logDirectory
        }
        return $exitCode
    }
    catch {
        $detail = $_.Exception.Message
        if ($errorLog) {
            try { Add-Content -LiteralPath $errorLog -Value $detail -Encoding UTF8 } catch {}
        }
        Show-ChromeFpError -Detail $detail -LogDirectory $logDirectory
        return 1
    }
    finally {
        if ($process) { $process.Dispose() }
        if ($ownsSessionMutex) { $sessionMutex.ReleaseMutex() }
        if ($sessionMutex) { $sessionMutex.Dispose() }
        if ($sessionReady) { $sessionReady.Dispose() }
    }
}

# Dot-sourcing exposes the launcher functions for verification without launching.
if ($MyInvocation.InvocationName -ne '.') {
    $launcherExitCode = Invoke-ChromeFpLauncher -ProjectRoot $PSScriptRoot -NodePath $NodePath -BrowserArguments $BrowserArguments
    exit $launcherExitCode
}
