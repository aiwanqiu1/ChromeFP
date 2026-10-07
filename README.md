# ChromeFP

基于出口 IP 对齐区域设置、生成稳定指纹参数的 Chrome 启动器。使用本机 Chrome，通过独立 profile 保存 Cookie、登录状态和浏览器数据。

- **区域对齐**：按出口 IP 设置时区、语言和定位，覆盖网站首选语言、翻译目标及网页 / Worker 语言读数。
- **IP 派生参数**：按 IP 生成核心数、内存读数及 Canvas / Audio 扰动种子，同一 IP 的派生结果稳定。
- **出口变化检测**：切换 IP 后更新现有页面、iframe、Worker 和新标签页，保留当前站点数据。
- **多环境与自检**：不同 profile 分开保存浏览器数据，本地自检页对照配置与实际读数。

当前面向 **Windows**，需要 **Node.js 22+** 和 **Google Chrome**，无需安装 npm 依赖。macOS / Linux 的完整启动流程尚未验证。

[快速开始](#快速开始) · [常用命令](#常用命令) · [代理与缓存](#代理与缓存) · [参数](#参数) · [常见问题](#常见问题) · [技术说明](docs/technical-details.md)

## 快速开始

### 1. 准备环境

安装 Node.js 22 或更新版本，以及 Google Chrome。打开 PowerShell，确认 Node 已加入 `PATH`：

```powershell
node --version
```

### 2. 下载项目

已安装 Git 时，可克隆仓库并进入目录：

```powershell
git clone https://github.com/aiwanqiu1/ChromeFP.git
cd ChromeFP
```

也可以在 GitHub 点击 **Code → Download ZIP**，解压后在项目目录打开 PowerShell。下面的命令都在项目目录执行。

### 3. 创建快捷方式并启动

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1
```

安装脚本会在桌面和项目目录生成 **ChromeFP 浏览器** 快捷方式。双击即可启动独立 Chrome 窗口，并打开自检页。默认使用 `default` profile，跟随当前系统网络和代理。

快捷方式会在后台保持启动器运行。查看实时诊断时，双击 `start-chrome.cmd`；直接通过命令行启动也可以：

```powershell
node fp-browser.mjs
```

移动项目目录后，在新目录重新运行安装命令，更新快捷方式路径。

## 常用命令

```powershell
# 为不同环境保存独立的 Cookie 和登录状态
node fp-browser.mjs --profile 店铺A --url https://example.com
node fp-browser.mjs --profile 店铺B

# 使用固定代理；端口按本机代理软件的设置填写
node fp-browser.mjs --profile 测试环境 --proxy http://127.0.0.1:7892

# 查看当前出口对应的配置，或列出已有环境
node fp-browser.mjs --print-config --refresh
node fp-browser.mjs --list

# 查看全部选项
node fp-browser.mjs --help
```

默认快捷方式及仅指定 `--profile` 的后台入口会复用该环境的已有窗口；提供其他参数时会按新参数启动。同一 profile 已在运行时，普通 CMD / Node 命令行会拒绝再次启动。不同 profile 可同时运行。

关闭最后一个窗口通常会结束会话，启动器随 Chrome 进程退出。若下载等任务使 Chrome 继续留在后台，再次点击快捷方式会恢复一个空白窗口。CMD 诊断模式需要保持命令行窗口开启，也可按 Ctrl+C 结束会话。

## 默认行为与限制

| 项目 | 默认行为 |
|---|---|
| 浏览器与身份 | 使用本机 Chrome，保留原生 UA 和 Client Hints |
| 时区与语言 | 按出口归属地设置，语言映射覆盖 249 个国家与地区 |
| 定位 | 使用 IP 归属地接口的坐标；可用 `--no-geo-location` 关闭覆盖 |
| 核心数与内存 | 按 IP 生成网页读数，可用参数指定 |
| Canvas / Audio | 开启由 IP 派生的固定扰动 |
| GPU 与屏幕 | 保留原生值；WebGL 名称和顶层视口可选覆盖 |
| WebRTC | 代理启用或状态未知时开启页面级过滤，明确直连时默认关闭 |
| 自检页 | 默认打开，对照 IP、指纹编号、Canvas / Audio 哈希与实际读数 |

使用前请了解以下边界：

- profile 隔离浏览器数据。同一出口 IP 的不同 profile 使用相同派生参数；GPU、字体、屏幕和底层渲染特征仍可能关联这些环境。
- 稳定的是 IP 派生参数和扰动种子。实际 Canvas / Audio 哈希还取决于网页内容与本机渲染，不能据此保证完整指纹唯一或匿名。
- 默认定位覆盖会为该浏览器会话授予地理位置权限，返回 IP 数据库坐标，而非设备 GPS。定位准确性取决于接口数据。
- 出口检测完成后等待 10 秒再开始下一次检测，网络查询耗时可能延后更新。网站已保存的语言偏好和已显示的正文可能保持原状；Chrome 菜单语言需重新打开浏览器才会切换。
- WebRTC 过滤只修改页面可见读数，网络层隐私取决于代理和网络配置。过滤可能影响 P2P 或视频通话；CDP 与页面补丁也可能被网站检测。

完整 UA / Client Hints 配置、实验性视口及补丁范围见 [技术说明](docs/technical-details.md)。

## 代理与缓存

`launcher-config.json` 默认内容：

```json
{
  "proxy": null
}
```

`proxy: null` 或缺少配置文件时跟随 Windows 系统代理及网络 / TUN 设置。需要固定代理时，填写代理地址，例如 `"proxy": "http://127.0.0.1:7892"`，也可使用 `--proxy`。命令行 `--proxy` / `--direct` 优先于项目配置。

出口查询使用正式 Chrome 的同一个 profile 和网络进程，包含扩展代理及按程序设置的网络规则。显式代理连接失败时，启动器会等待端口就绪，最多 10 秒。请先启动代理软件，并确认监听端口。

修改固定代理配置后，需要结束原会话再启动；在同一代理端口切换节点时，运行中的启动器会检测新出口。`--direct` 关闭浏览器代理，系统 VPN / TUN 仍可接管流量。PAC、分流或轮换代理可能让不同网站使用不同出口，节点名称不能代替实际 IP。

每次启动和运行中的检测都会重新读取出口 IP。可显式启用同一 IP 的归属地与代理 / 机房判定缓存：

```powershell
node fp-browser.mjs --cache-geo 5
node fp-browser.mjs --cache-geo 5 --refresh
```

默认不使用跨会话缓存。启用后，只有实时检测的 IP 与有效缓存一致时才复用数据；运行中也会复用上一次相同 IP 的归属地与判定。`--refresh` 在启动时忽略已有缓存。更多说明见 [出口检测与缓存](docs/technical-details.md#出口检测与缓存)。

## 参数

```text
出口设置
  默认                    读取 launcher-config.json；proxy 为 null 时跟随系统代理
  --proxy <url>            指定 http / https / socks4 / socks5 代理
  --direct                 关闭浏览器代理（仍跟随 VPN/TUN）

环境
  --profile <名称>         独立 profile，默认 default
  --identity <JSON路径>    可选的完整 UA / Client Hints 身份
  --list                   列出已有 profile 和占用状态
  --url <网址>             HTTP / HTTPS 网址，可多次使用
  --chrome <路径>          指定 chrome.exe，也可使用 CHROME_PATH

覆盖与补丁
  --viewport <宽x高>       实验性顶层网页视口
  --screen <宽x高>         仿真屏幕，需提供 viewport
  --dpr <倍率>             仿真 DPR，需提供 viewport
  --no-geo-location        不覆盖地理位置
  --cores <整数>           覆盖核心数读数
  --device-memory <数值>   支持 0.25 / 0.5 / 1 / 2 / 4 / 8 / 16 / 32
  --webgl "厂商|渲染器"    覆盖 WebGL 字符串
  --canvas-noise           默认已启用当前 IP 对应的固定 Canvas 扰动
  --audio-noise            默认已启用当前 IP 对应的固定音频扰动
  --webrtc-protect         强制开启 WebRTC 页面级过滤
  --no-webrtc-protect      强制关闭 WebRTC 页面级过滤

诊断
  --verify / --no-verify   打开 / 关闭自检页，默认打开
  --print-config          输出配置后退出；查询可能临时启动无头 Chrome
  --cache-geo <分钟>       默认 0；缓存同一 IP 的归属地与判定，IP 始终实时查询
  --refresh               启动时忽略已有归属地缓存
  --headless              无头模式
  --verbose               输出目标附加日志
  --help                  查看帮助
```

profile 名称不能包含路径、Windows 保留名称或末尾空格；代理参数不支持 URL 内嵌账号密码，需使用本地代理转发。非法参数在查询或浏览器启动前被拒绝。

## 常见问题

| 现象 | 处理 |
|---|---|
| 找不到 Node 或 WebSocket | 安装 Node.js 22+，确认 `node --version` 可用，再创建快捷方式 |
| 找不到 Chrome | 使用 `--chrome "C:\路径\chrome.exe"` 指定程序，或设置 `CHROME_PATH` |
| 代理连接失败 / `ERR_PROXY_CONNECTION_FAILED` | 确认代理软件正在运行，端口与配置一致 |
| 归属地查询失败 | 检查网络、代理和查询接口；首次启动需要有效国家、时区和坐标 |
| profile 已被占用 | 关闭该环境的原窗口，或更换 `--profile` 名称 |
| 切换节点后地区未更新 | 等待下一次检测及接口返回，查看日志中的查询或更新警告 |
| 网页语言未切换 | 检查站点自身的账号、Cookie 和网址语言设置；已显示正文需刷新 |
| Chrome 菜单语言未切换 | 结束原会话并重新启动；菜单可用语言取决于本机 Chrome 资源 |
| 视频通话受影响 | 尝试 `--no-webrtc-protect`，并检查代理的 UDP / TURN 支持 |
| 个别网页读数不一致 | 查看自检页与日志，检查页面覆盖警告及按域名分流规则 |

快捷方式启动失败时会显示中文提示和日志位置。输出保存在 `logs/*.out.log`，错误保存在 `logs/*.err.log`。

## 数据与外部请求

浏览器数据保存在本机 `profiles/`，缓存与日志分别位于 `cache/` 和 `logs/`；这些目录及生成的 `.lnk` 已加入 `.gitignore`。日志可能包含出口 IP、地区、代理地址和指纹编号，分享前请检查内容。ChromeFP 读取系统代理配置，不修改 Windows 时区或日常 Chrome 的企业策略。

出口检测访问 ipify 和 IPQuery；归属地查询会将所选出口 IP 提交给 IPQuery，失败时尝试 ipapi.co / ipinfo.io。查询请求禁用缓存且不携带 Cookie。自检页仅监听本机 `127.0.0.1`，WebRTC 检查可能访问 Google 的公开 STUN 服务。

## 开发与验证

```text
fp-browser.mjs          命令行入口与会话管理
launcher-config.json    项目代理配置
install-shortcut.ps1     创建桌面与项目内快捷方式
start-chrome.ps1 / .cmd  后台启动 / 实时诊断
upload-github.ps1 / .cmd Git 上传工具
assets/                 图标资源
examples/               完整 UA / Client Hints 示例
lib/                    出口检测、区域配置、CDP 驱动、页面补丁与自检
test/                   自动化回归与真实 Chrome 集成测试
docs/                   技术说明
```

在项目目录执行：

```powershell
# 回归检查，包含真实 Chrome 场景
node --test test/regressions.test.mjs

# 完整测试
$testFiles = @(Get-ChildItem -LiteralPath .\test -Filter '*.test.mjs' | ForEach-Object FullName)
node --test --test-concurrency=2 @testFiles
```

真实 Chrome 测试使用临时目录中的独立 profile，不接触已有登录数据；部分测试会打开屏幕外窗口或访问外部网络。快捷方式入口测试使用临时 Node 脚本验证启动行为。维护 Windows 入口时，CMD 文件保持 CRLF 和纯 ASCII，PowerShell 文件保留原有编码。

真实 Chrome 测试使用系统临时目录中的独立 profile，不接触已有登录数据。兼容性测试还以屏幕外的普通窗口检查扩展页、设置页、覆盖超时后的页面恢复和原生网络错误页。快捷方式入口测试使用临时 Node 脚本检查参数传递、等待退出、中文日志和失败提示，不启动 Chrome。自检页的 WebRTC 检查可能访问公开 STUN 服务。
