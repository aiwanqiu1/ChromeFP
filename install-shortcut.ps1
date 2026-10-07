param(
    [string]$DesktopPath = [Environment]::GetFolderPath('DesktopDirectory'),
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'start-chrome.ps1'
$icon = Join-Path $PSScriptRoot 'assets\chromefp.ico'
foreach ($file in @($launcher, $icon)) {
    if (-not [IO.File]::Exists($file)) { throw "Required file is missing: $file" }
}
if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'Node.js 22 or later is required. Install it and run this script again.' }
    $NodePath = $nodeCommand.Source
}
if (-not [IO.File]::Exists($NodePath)) { throw "Node.js executable is missing: $NodePath" }
if (-not [IO.Directory]::Exists($DesktopPath)) { throw "Desktop folder is missing: $DesktopPath" }
$nodeVersion = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'Node.js 22 or later is required.'
}
$shell = New-Object -ComObject WScript.Shell
try {
    foreach ($directory in (@($DesktopPath, $PSScriptRoot) | Select-Object -Unique)) {
        $shortcutPath = Join-Path $directory 'ChromeFP 浏览器.lnk'
        $shortcut = $shell.CreateShortcut($shortcutPath)
        try {
            $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            $shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '" -NodePath "' + $NodePath + '"'
            $shortcut.WorkingDirectory = $PSScriptRoot
            $shortcut.IconLocation = $icon + ',0'
            $shortcut.Description = '启动 ChromeFP 独立浏览器环境'
            $shortcut.WindowStyle = 7
            $shortcut.Save()
            Write-Output $shortcutPath
        }
        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    }
}
finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
