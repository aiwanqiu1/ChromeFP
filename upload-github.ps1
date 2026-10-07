param(
    [string]$RepositoryUrl,
    [string]$Message,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:GitExecutable = $null
$script:GitExitCode = 0

function Invoke-UploadGit {
    param(
        [string[]]$GitArguments,
        [switch]$Capture,
        [switch]$AllowFailure
    )
    # PowerShell 5.1 represents redirected native stderr as ErrorRecord objects.
    # Use Git's exit code to decide whether warnings actually mean failure.
    $ErrorActionPreference = 'Continue'
    $lines = @(& $script:GitExecutable -c core.quotePath=false @GitArguments 2>&1)
    $script:GitExitCode = $LASTEXITCODE
    $textLines = @($lines | ForEach-Object { $_.ToString() })
    if ($script:GitExitCode -ne 0 -and -not $AllowFailure) {
        throw ("Git {0} 失败（退出码 {1}）。`n{2}" -f $GitArguments[0], $script:GitExitCode, ($textLines -join "`n"))
    }
    if ($Capture) { return $textLines }
    foreach ($line in $textLines) { Write-Host $line }
}

function ConvertTo-UploadUrl {
    param([string]$Url)
    $value = $Url.Trim()
    if (-not $value -or $value.StartsWith('-')) { throw '仓库地址为空或格式不正确。' }
    if ($value -match '^https?://[^/]*@github\.com/') {
        throw '请使用不包含账号或令牌的 GitHub 地址，由 Git 登录窗口完成认证。'
    }
    return ($value -replace '^http://github\.com/', 'https://github.com/')
}

$savedOptionalLocks = [Environment]::GetEnvironmentVariable('GIT_OPTIONAL_LOCKS', 'Process')
$pushedLocation = $false
$exitCode = 0
try {
    if ($DryRun) { $env:GIT_OPTIONAL_LOCKS = '0' }
    $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gitCommand) { throw '找不到 Git。请先安装 Git for Windows，再重新运行。' }
    $script:GitExecutable = $gitCommand.Source
    Push-Location -LiteralPath $PSScriptRoot
    $pushedLocation = $true

    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.git'))) {
        if ($DryRun) {
            $targetUrl = ConvertTo-UploadUrl $(if ($RepositoryUrl) { $RepositoryUrl } else { 'https://github.com/aiwanqiu1/ChromeFP.git' })
            Write-Host "[预览] 将初始化 main 分支并上传到 $targetUrl"
            Write-Host '[预览] 将排除 profiles、cache、logs、_probe 和 .lnk 快捷方式；未修改文件或访问远程。'
            exit 0
        }
        Invoke-UploadGit -GitArguments @('init', '--initial-branch=main')
    }

    $repositoryRoot = (Invoke-UploadGit -GitArguments @('rev-parse', '--show-toplevel') -Capture | Select-Object -First 1)
    if ([IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\', '/') -ne [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')) {
        throw '脚本必须放在此 Git 仓库的根目录。'
    }
    $unmerged = @(Invoke-UploadGit -GitArguments @('ls-files', '--unmerged') -Capture)
    if ($unmerged.Count -gt 0) { throw '仓库有未解决的合并冲突。请先处理冲突并完成合并，再上传。' }
    foreach ($operation in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer')) {
        $operationPath = (Invoke-UploadGit -GitArguments @('rev-parse', '--git-path', $operation) -Capture | Select-Object -First 1)
        if (Test-Path -LiteralPath $operationPath) { throw "Git 操作尚未完成（$operation）。请先完成该操作，再上传。" }
    }
    $branch = (Invoke-UploadGit -GitArguments @('symbolic-ref', '--quiet', '--short', 'HEAD') -Capture -AllowFailure | Select-Object -First 1)
    if ($script:GitExitCode -ne 0 -or -not $branch) { throw '当前未处于分支上。请先切换到需要上传的分支。' }
    $runtimeTracked = @(Invoke-UploadGit -GitArguments @('ls-files', '--', 'profiles', 'cache', 'logs', '_probe', '*.lnk') -Capture)
    if ($runtimeTracked.Count -gt 0) {
        throw '浏览器数据、缓存、日志或快捷方式已被 Git 跟踪。请先用 git rm --cached 将这些文件移出 Git，保留本地数据后再上传。'
    }

    $remoteNames = @(Invoke-UploadGit -GitArguments @('remote') -Capture)
    $hasOrigin = $remoteNames -contains 'origin'
    $fetchUrls = @()
    $pushUrls = @()
    if ($hasOrigin) {
        $fetchUrls = @(Invoke-UploadGit -GitArguments @('remote', 'get-url', '--all', 'origin') -Capture)
        $pushUrls = @(Invoke-UploadGit -GitArguments @('remote', 'get-url', '--push', '--all', 'origin') -Capture)
        if ($fetchUrls.Count -ne 1 -or $pushUrls.Count -ne 1) { throw 'origin 配置了多个地址，请先保留一个明确的拉取和推送地址。' }
        if (-not $RepositoryUrl -and (ConvertTo-UploadUrl $fetchUrls[0]) -ne (ConvertTo-UploadUrl $pushUrls[0])) {
            throw 'origin 的拉取和推送地址不同。请使用 -RepositoryUrl 明确指定本次上传仓库。'
        }
    }
    $targetUrl = ConvertTo-UploadUrl $(if ($RepositoryUrl) { $RepositoryUrl } elseif ($hasOrigin) { $fetchUrls[0] } else { 'https://github.com/aiwanqiu1/ChromeFP.git' })
    Write-Host "仓库：$targetUrl"
    Write-Host "分支：$branch"
    if ($DryRun) {
        Write-Host '[预览] 下列改动会提交；无改动时只同步并推送已有提交：'
        Invoke-UploadGit -GitArguments @('status', '--short', '--untracked-files=normal', '--', '.', ':(glob,top,exclude)[p]rofiles/**', ':(glob,top,exclude)[c]ache/**', ':(glob,top,exclude)[l]ogs/**', ':(glob,top,exclude)[_]probe/**', ':(glob,top,exclude)**/*.lnk')
        Write-Host '[预览] 将拉取远程、提交改动、合并远程同名分支，然后推送。未修改文件或访问远程。'
    } else {
        foreach ($identityKey in @('user.name', 'user.email')) {
            $identity = @(Invoke-UploadGit -GitArguments @('config', '--get', $identityKey) -Capture -AllowFailure)
            if ($script:GitExitCode -ne 0 -or -not ($identity -join '').Trim()) {
                throw "Git 尚未配置 $identityKey。请先执行 git config --global $identityKey 并填写你的信息。"
            }
        }
        if (-not $hasOrigin) {
            Invoke-UploadGit -GitArguments @('remote', 'add', 'origin', $targetUrl)
        } else {
            if ($fetchUrls[0] -ne $targetUrl) { Invoke-UploadGit -GitArguments @('remote', 'set-url', 'origin', $targetUrl) }
            if ($pushUrls[0] -ne $targetUrl) { Invoke-UploadGit -GitArguments @('remote', 'set-url', '--push', 'origin', $targetUrl) }
        }
        Write-Host '正在连接远程仓库。首次上传如出现 Git 登录窗口，请完成登录。'
        Invoke-UploadGit -GitArguments @('fetch', '--prune', 'origin')
        $remoteRef = 'refs/remotes/origin/' + $branch
        [void](Invoke-UploadGit -GitArguments @('show-ref', '--verify', '--quiet', $remoteRef) -Capture -AllowFailure)
        $hasRemoteBranch = $script:GitExitCode -eq 0
        if ($script:GitExitCode -ne 0 -and $script:GitExitCode -ne 1) { throw '无法检查远程分支。' }
        if ($hasRemoteBranch) {
            $remoteFiles = @(Invoke-UploadGit -GitArguments @('ls-tree', '-r', '--name-only', $remoteRef) -Capture)
            if (@($remoteFiles | Where-Object { $_ -match '^(profiles|cache|logs|_probe)(/|$)|\.lnk$' }).Count -gt 0) {
                throw '远程分支仍包含浏览器数据、缓存、日志或快捷方式。请先清理远程跟踪记录，再同步上传。'
            }
        }
        # Character groups prevent Git from treating an ignored directory's
        # fixed pathspec prefix as an explicit request to add that directory.
        Invoke-UploadGit -GitArguments @('add', '--all', '--', '.', ':(glob,top,exclude)[p]rofiles/**', ':(glob,top,exclude)[c]ache/**', ':(glob,top,exclude)[l]ogs/**', ':(glob,top,exclude)[_]probe/**', ':(glob,top,exclude)**/*.lnk')
        [void](Invoke-UploadGit -GitArguments @('diff', '--cached', '--quiet') -Capture -AllowFailure)
        if ($script:GitExitCode -eq 1) {
            if (-not $Message) { $Message = 'Update ChromeFP - ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
            Invoke-UploadGit -GitArguments @('commit', '--message', $Message)
        } elseif ($script:GitExitCode -ne 0) {
            throw '无法检查暂存区改动。'
        } else {
            Write-Host '没有新的文件改动，继续同步已有提交。'
        }
        [void](Invoke-UploadGit -GitArguments @('rev-parse', '--verify', 'HEAD') -Capture -AllowFailure)
        if ($script:GitExitCode -ne 0) { throw '没有可上传的提交。请先添加项目文件。' }
        if ($hasRemoteBranch) {
            Invoke-UploadGit -GitArguments @('merge', '--no-edit', '--no-overwrite-ignore', $remoteRef)
        }
        $refspec = 'refs/heads/' + $branch + ':refs/heads/' + $branch
        Invoke-UploadGit -GitArguments @('push', '--set-upstream', 'origin', $refspec)
        Write-Host '上传成功。'
    }
} catch {
    Write-Host "上传失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '本地文件和提交已保留；若同步产生冲突，请解决并完成合并后重新运行。'
    $exitCode = 1
} finally {
    if ($pushedLocation) { Pop-Location }
    if ($DryRun) { [Environment]::SetEnvironmentVariable('GIT_OPTIONAL_LOCKS', $savedOptionalLocks, 'Process') }
}
exit $exitCode
