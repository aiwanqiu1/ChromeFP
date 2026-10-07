# ChromeFP

基于出口 IP 生成稳定指纹参数的 Chrome 启动器，自动同步时区、语言与定位，支持 IP 切换实时更新、多 Profile 数据隔离和指纹自检。

读取当前系统网络的公网出口 IP，生成这个 IP 对应的稳定指纹：核心数、内存读数、Canvas 和音频扰动由 IP 派生，时区、语言和定位按 IP 归属地对齐。语言包含 Chrome 菜单与设置、网站首选语言、翻译目标，以及网页、Worker 的语言读数和请求头。同一 IP 的生成结果稳定，同国家内换 IP 也会改变 Canvas 和音频指纹。不同 profile 独立保存 Cookie、登录状态和浏览器数据。

浏览器运行期间每 10 秒重新检测当前出口和系统代理设置。IP 改变时自动更新已打开的页面、iframe、Worker 和随后打开的标签页，自检页同步显示新的 IP、指纹编号和实际读数。系统代理设置改变但 IP 相同时，刷新出口描述及 WebRTC 保护设置，保留同一 IP 的稳定指纹。更新无需重新加载网站，页面数据和登录状态继续保留。网络查询失败时保留上一次有效配置、记录警告并在下次检测重试。首次升级后请关闭旧版本浏览器会话，再通过原快捷方式启动一次。

启动时先在同一个 profile 的后台 Chrome 中读取 IP，配置原生语言偏好，再打开正常浏览器并复查实际出口。运行中切换地区后，网站首选语言、翻译目标及网页语言立即更新；Chrome 菜单资源需要重新打开浏览器才会切换，自检页显示待生效的语言。此行为与 [Chrome 的原生显示语言设置](https://support.google.com/chrome/answer/173424?hl=en) 一致。网站自行保存的账号、Cookie 或网址语言设置可能优先于浏览器偏好；已显示的网页正文不会仅因请求语言变化而重写。项目保留这些站点数据。

语言映射覆盖全部 249 个 ISO 国家与地区，保留明确配置的多语言地区偏好，其他地区使用 CLDR 常用语言数据。Chrome 缺少某些语言的格式化数据时选择当地使用且受支持的语言，仍保留真实地区代码；不会将未收录的地区默认为美国。Chrome 菜单可用的翻译语言取决于本机 Chrome 的语言资源。

它运行的是本机 Chrome。区域信息对齐和浏览器数据隔离不等于设备隔离；GPU、字体、屏幕、底层渲染等特征仍可能关联不同 profile。

## 运行

需要 Node.js 22 或更新版本，以及 Chrome，没有 npm 依赖。日常使用双击 **ChromeFP 浏览器** 快捷方式；它使用独立图标，并在后台保持启动器运行，正常打开或关闭 Chrome 时不显示黑色命令行窗口。仍沿用项目中的 profile、登录状态和所有启动配置。

启动失败会显示中文提示和日志位置。每次运行的输出与错误分别保存在 `logs/*.out.log` 和 `logs/*.err.log`，无需保持命令行窗口可见。需要查看实时诊断时，双击 `start-chrome.cmd`。

快捷方式默认使用 `default` profile，并保留原有默认启动行为。移动项目目录后，在新项目目录重新运行下面的命令，更新桌面与项目内的快捷方式路径和图标：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-shortcut.ps1
```

重复点击快捷方式会切回同一环境的已有窗口，不再启动第二份浏览器或重复打开自检页。首次启动尚未完成时，后续点击会等待，最长两分钟。关掉浏览器的最后一个窗口后 Chrome 会自行退出，会话随之结束，再次点击快捷方式就是一次全新会话（重新查询归属地并打开自检页）。只有在窗口已关闭而本项目 Chrome 仍因下载等原因留在后台时，才会在原会话中恢复一个空白窗口，继续使用现有登录和区域覆盖。

自动复用仅适用于快捷方式的默认参数，或只指定 `--profile <名称>` 的调用。提供其他参数时仍交给原命令行入口处理，避免悄悄忽略新的代理或指纹配置。普通 CMD / Node 命令行继续拒绝同时启动同一 profile。

需要命令行参数时，在项目目录执行：

```powershell
node fp-browser.mjs
node fp-browser.mjs --profile 店铺A --url https://example.com
node fp-browser.mjs --profile 店铺B --proxy http://127.0.0.1:7892
node fp-browser.mjs --print-config --refresh
node fp-browser.mjs --list
```

本项目的 `launcher-config.json` 默认 `proxy: null`，跟随当前 Windows 系统代理及网络/TUN 设置，适用于任何实际改变 Chrome 出口的代理或网络软件。快捷方式、CMD 和直接运行 Node 都读取这个配置；出口查询直接使用正式 Chrome 的同一个 profile 和网络进程，包含浏览器扩展代理及按程序设置的网络规则，不修改 Windows 系统代理。需要固定代理时可在文件里填写代理地址，或使用 `--proxy`。

使用显式代理查询归属地前，启动器会先检查代理端口；代理软件尚在启动时等待最多 10 秒，连接就绪后继续查询。持续无法连接时，提示实际代理地址、连接错误和配置修改位置。请保持代理软件运行；端口改变时同步修改 `launcher-config.json` 的 `proxy`。

命令行 `--proxy` 或 `--direct` 优先于项目配置。`proxy: null` 或没有该配置文件时使用系统代理。修改项目的固定代理配置后需结束原会话再启动；当前系统出口 IP 的变化由运行中的启动器自动检测。重复点击快捷方式会复用原会话。启动后打开本地自检页，显示当前 IP、对应指纹编号、Canvas / Audio 哈希及实际读数与配置的对照。

`--direct` 只关闭浏览器代理，系统 VPN/TUN 仍可接管流量。同时运行多个代理软件时，另一个软件的 TUN 或重复占用的监听端口可能阻止所选节点接管网络；ChromeFP 根据浏览器实际出口生成指纹，节点名称不能代替实际 IP。

启动器需要在浏览器使用期间保持运行，它负责给新标签页、iframe 和 Worker 应用覆盖。快捷方式会在后台保持运行，Chrome 进程退出后自动结束；关掉最后一个浏览器窗口即可结束会话。启动时先出现的初始空白窗口和可能被恢复的旧标签页，会在本次页面开好后自动关闭。使用 CMD 诊断模式时则需要保持命令行窗口开启，也可以按 Ctrl+C 结束会话。单个页面的覆盖超时或失败会记录警告并恢复该页面，不会关闭整个浏览器；警告页的区域或硬件读数可能不一致。浏览器初始化失败或会话结束时清理本次启动的 Chrome 进程与本地自检服务。

扩展管理、设置等 Chrome 内部页面不执行网页接口补丁，避免影响管理功能。从管理页返回普通网站时仍应用补丁。网站连接、代理或证书错误会保留 Chrome 自带的错误页，便于查看原因和重试。

不同 profile 是不同的 Chrome 实例，通常各自有窗口。同一个 profile 内的标签页和窗口共享 Cookie 与登录状态。同一个 profile 不能同时启动两次。

## 工作方式

1. 先启动正式 Chrome，通过它的隐藏查询目标实时读取公网出口 IP；请求不携带 Cookie、禁用缓存，也不打开额外的可见标签页。仅 `--print-config` 使用临时无头 Chrome，但使用相同的查询方式。
2. 按固定来源顺序选取有效出口 IP，再显式查询这个 IP 的归属地，校验 IP、国家、时区和坐标。接口数据不完整时尝试其他接口，全部失败时停止启动。不同检测域名返回不同 IP 时显示观测结果和分流提示，不再用接口响应速度决定指纹。
3. 根据国家映射语言，保存 Chrome 原生菜单语言、网站首选语言和翻译目标；通过 CDP 设置语言请求头、时区和定位，通过页面补丁设置语言读数。原生语言偏好更新保留 profile 中其他设置和站点数据。
4. 在页面脚本运行前应用覆盖，再放行或导航。单个目标覆盖失败时记录警告并解除调试暂停，其他窗口继续运行。
5. 按当前 IP 生成硬件读数及 Canvas、音频扰动，对新标签页和派生目标自动附加。
6. 运行中持续查询出口；IP 改变时替换配置和新文档脚本，更新已打开页面的读数及语言请求头，不重复叠加扰动。

启动时还会通过相同的 Chrome 代理设置，向 [IPQuery](https://ipquery.io/) 显式查询已选定出口 IP 的 `risk.is_proxy`（已知代理）和 `risk.is_datacenter`（机房）字段。自检页及启动日志显示“是 / 否 / 未知”和判定来源；“是”或未知以黄色提示。查询默认最多等待 5 秒，接口失败、限流、缺字段或返回其他 IP 时保留未知，浏览器仍按有效归属地启动。这里的代理判定单独使用 `is_proxy`，不合并 VPN 或 Tor 标记，也不根据本地代理开关推断。

默认保留 Chrome 原生 UA、Client Hints、WebGL 渲染器和屏幕值。显式启用以下配置才覆盖这些字段；核心数、内存、Canvas 和音频默认由 IP 生成。CDP 与页面补丁仍可能被检测。

## 可选 UA 与完整 Client Hints

提供完整 JSON 身份，UA 和 metadata 在页面最早脚本与导航请求之前一起覆盖：

```powershell
node fp-browser.mjs --identity examples/windows-identity.json
```

示例为 Windows x64 桌面身份，platformVersion=13.0.0 只是示例值；使用前按实际系统填写。不要将该文件用于其他系统或架构。UA 中的 {major}、完整品牌版本中的 {version} 在启动时替换为本机 Chrome 的实际版本，不需要把版本写死。

文件必须包含 userAgent、旧 navigator.platform 对应的 platform、完整 userAgentMetadata。metadata 必须显式给出 brands、fullVersionList、platform、platformVersion、architecture、model、mobile、bitness、wow64、formFactors；legacy fullVersion 可选。仅支持本机系统与架构的桌面 Chrome，mobile=false、model=""、wow64=false、formFactors=["Desktop"]。UA 可以是实际完整版本或相同主版本的缩减形式，两个真实品牌的 CH 完整版本必须与实际 Chrome 一致；还需一致的 GREASE 品牌。

只提供 UA、漏字段、跨平台、伪造未运行的 Chrome 版本或版本相互矛盾时会报错。文件结构在网络查询前校验；实际浏览器版本在调试连接建立后、页面附加之前校验。支持 UTF-8 BOM，文件上限 64 KB。

语言仍由出口地区配置产生；完整身份同时携带该 Accept-Language，避免身份覆盖抹掉语言。新标签页、跨域 iframe 和 Worker 的 JS 身份都参与验证。当前实测 Chrome 的原生 Worker fetch 不发送 Client Hints 请求头，覆盖后仍保留这一行为；Worker 的 UA 请求头与 JS 读数保持一致，不额外伪造 CH 头。自检页新增 UA、低熵和高熵 Client Hints 的配置对照。这个校验保证本轮覆盖字段之间一致，不等于改变浏览器内核、字体或硬件。

## 实验性顶层视口、屏幕与 DPR

```powershell
node fp-browser.mjs --viewport 1280x720 --screen 1920x1080 --dpr 1.25
node fp-browser.mjs --identity examples/windows-identity.json --viewport 1280x720 --screen 1920x1080 --dpr 1
```

--screen 与 --dpr 必须提供 --viewport。尺寸范围 64–16384，视口不能大于屏幕，DPR 范围 0.5–4。仅指定视口时屏幕默认为相同尺寸、DPR 默认为 1。

这是 Emulation.setDeviceMetricsOverride 提供的顶层页面仿真，不会改动系统桌面。**跨进程 iframe 的 screen / DPR 不继承这项覆盖**；当前实测 Chrome 拒绝对 iframe 调用这个命令。iframe 的实际容器尺寸保留，screen / DPR 继续反映原生值。同进程 iframe、顶层页面和物理窗口的读数不能因此被称为完整设备一致性。启动器会显示这一限制；默认不启用该实验功能。实际 outerWidth / outerHeight、可用工作区、真实显示器与窗口边框保留原生行为。

## 安装状态与暂缓项

不向页面全局对象写入 Symbol.for('ChromeFP.provider.installed')。已有函数包装器的闭包持有 WeakMap，通过每个驱动生成的一次性私有令牌复用安装状态和更新配置；同一份 provider source 的 OOPIF 继承与重复求值不会反复包装原型。IP 切换时更新现有闭包的种子，避免噪声叠加；不声称脚本无法被检测。

本轮暂不加入字体白名单、字体度量噪声、通用 drawImage / WebGL readPixels 扰动或 WebGPU 名称覆盖。它们需要额外处理 CSS 字体匹配、真实布局、像素格式与 GPU 能力之间的一致性，单纯修改部分读数可能增加不一致或影响网站。现有可选 Canvas / WebGL 名称补丁继续保留原范围。


## 代理与缓存

**每次启动和运行中的检测都重新查询当前出口 IP。** 即使启用了缓存，也不会用旧缓存的 IP 生成本次指纹。代理软件在同一个本地端口切换节点时，端口不变，但出口 IP 和地区可能已改变。

需要复用同一 IP 的代理 / 机房判定时可显式启用缓存：

```powershell
node fp-browser.mjs --cache-geo 5
node fp-browser.mjs --cache-geo 5 --refresh
```

缓存按代理模式和系统代理配置区分；只有实时查询的 IP 与缓存 IP 一致时才复用判定结果，归属地仍以实时查询为准。`--refresh` 同时强制重新查询判定。

代理 / 机房判定随归属地一起缓存；升级前没有判定数据的旧缓存会自动刷新。已缓存的未知结果可用 `--refresh` 重新查询。

查询接口与目标网站使用同一套代理设置，但 PAC、分流规则、TUN 和轮换代理可能按域名分配不同出口，无法由一次归属地查询保证所有网站出口相同。

会话中切换节点后，启动器在下一次检测发现新出口 IP 后自动更新区域和 IP 指纹；同一国家或城市的语言、时区可以保持一致，Canvas / Audio 指纹仍随 IP 改变。

## WebRTC 过滤

自动模式下，显式代理、系统代理、PAC、自动发现启用或状态未知时开启页面级过滤；明确直连时默认关闭。可用 --webrtc-protect / --no-webrtc-protect 覆盖此选择。

过滤覆盖以下常见读取路径：

- icecandidate 事件，包括函数监听器、对象监听器和 onicecandidate。
- createOffer / createAnswer 和本地 SDP 描述。
- 连接、发送器和接收器的候选统计，以及部分 ICE transport 读取接口。

丢弃与期望出口不符的直连数值地址候选，保留 mDNS 本地候选及 TURN 中继候选；中继服务的 IP 不等于客户端的真实 IP，相关客户端地址字段仍过滤。监听器删除、once 和 AbortSignal 语义保持可用。

**这是页面级读数过滤，不是网络层防泄露保证。** 补丁仍可被检测，也可能影响 P2P 和视频通话。对底层网络的隐私要求需要由代理或网络设置提供保障。保留中继的原因见 [W3C 的 relay 策略说明](https://www.w3.org/TR/webrtc/#rtcicetransportpolicy-enum)。

自检页检查事件、SDP 和统计的可见地址，包括 IPv6；未获取到候选时显示“结果不确定”，不会把网络失败当成防护成功。

相关接口定义见 [W3C WebRTC 规范](https://www.w3.org/TR/webrtc/)。

## 可选硬件和渲染补丁

默认按当前 IP 生成核心数、内存和稳定的 Canvas / 音频扰动，WebGL 名称保留真实值。显式参数可指定硬件或 WebGL 读数：

- --cores 8：覆盖网页、iframe 和 Worker 的硬件并发读数。
- --device-memory 8：覆盖设备内存读数。
- --webgl "厂商|渲染器"：修改网页读取到的 WebGL 厂商和渲染器名称。
- --canvas-noise：默认已开启，按当前 IP 种子给 2D Canvas 读取和导出加固定扰动；重复读取稳定，不修改原画布。
- --audio-noise：默认已开启，按当前 IP 种子给频率数据和 AudioBuffer 采样读数加固定扰动；支持 OfflineAudio 指纹。

Canvas 补丁不覆盖全部 WebGL / OffscreenCanvas 读取路径，WebGL 名称覆盖也不改变真实 GPU 渲染。以上补丁都有可检测的 JS 修改面，无法保证匿名或多设备隔离。

deviceMemory=32 不应被一概判为异常：当前桌面版 Chromium 的实现允许上限 32，Android 的范围不同。详见 [Chromium 内存读数实现](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/common/device_memory/approximated_device_memory.cc)。不再自动建议把真实的 32 改成 8。

## 参数

```text
出口设置
  默认                    读取 launcher-config.json（当前跟随系统网络与代理）
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
  --cache-geo <分钟>       默认 0；缓存同一 IP 的判定，IP 始终实时查询
  --refresh               忽略已有缓存
  --headless              无头模式
  --verbose               输出目标附加日志
  --help                  查看帮助
```

profile 名称不能包含路径、Windows 保留名称或末尾空格；代理参数不支持 URL 内嵌账号密码，需使用本地代理转发。非法参数在查询或浏览器启动前被拒绝。

## 排查

| 现象 | 处理 |
|---|---|
| 找不到 Node 或 WebSocket | 安装 Node.js 22 或更新版本，确认已加入 PATH |
| 找不到 Chrome | 使用 --chrome 指定程序，或设置 CHROME_PATH |
| 代理连接失败 / ERR_PROXY_CONNECTION_FAILED | 启动代理软件，确认监听端口与 launcher-config.json 的 proxy 一致；启动器会先等待最多 10 秒 |
| 归属地查询失败 | 检查代理可用性；工具要求接口提供有效的时区和坐标 |
| profile 已被占用 | 关闭该 profile 的原窗口，或换一个名称 |
| 切节点后地区没更新 | 等待下一次 IP 检测及接口返回，查看日志是否查询失败；升级前旧会话需要先重开一次 |
| 视频通话受影响 | 尝试 --no-webrtc-protect，并检查代理的 UDP / TURN 支持 |
| 某些网页时区或定位不一致 | 查看终端错误和自检页；检查代理是否按域名分流 |

start-chrome.cmd 保持 CRLF 换行和纯 ASCII；中文提示由 Node 输出。工具读取系统代理配置，浏览器数据与锁文件写入项目内的 profiles，不修改 Windows 时区或日常 Chrome 的企业策略。

## 目录与验证

```text
fp-browser.mjs        命令行入口和会话清理
launcher-config.json 默认跟随当前系统出口；命令行参数优先
start-chrome.ps1      快捷方式后台入口（Windows PowerShell 5.1，UTF-8 BOM）
install-shortcut.ps1  创建或更新桌面与项目内的快捷方式
start-chrome.cmd      Windows 实时诊断入口
assets/chromefp.ico   快捷方式图标
lib/
  options.mjs         参数与 profile 路径校验
  launcher-config.mjs 项目代理配置与命令行优先级
  cdp.mjs             CDP 客户端、Chrome 启动和 profile 独占检测
  systemproxy.mjs     系统代理读取、显式代理就绪等待、缓存键和过滤自动选择
  geo.mjs             HTTPS 归属地查询及响应校验
  config.mjs          国家到语言的映射
  fingerprint.mjs     当前 IP 的稳定指纹生成与配置组装
  ip-monitor.mjs      出口变化检测、串行更新与取消清理
  driver.mjs          目标附加、覆盖完成等待及失败处理
  restore-window.mjs  在已验证的原会话中恢复空白窗口
  provider.mjs        可选页面补丁
  verifypage.mjs      本地自检页
test/                 自动化回归与真实 Chrome 集成测试
profiles/             浏览器持久数据
cache/                显式启用的归属地缓存
logs/                 每次快捷方式启动的输出与错误日志
```

`profiles/`、`cache/` 和 `logs/` 在运行时自动创建，已加入 Git 忽略规则；浏览器数据只保存在本机。项目内的 `.lnk` 快捷方式也不提交，可运行 `install-shortcut.ps1` 重新生成。

```powershell
node --test test/regressions.test.mjs
$testFiles = @(Get-ChildItem -LiteralPath .\test -Filter '*.test.mjs' | ForEach-Object FullName)
node --test --test-concurrency=2 @testFiles
```

真实 Chrome 测试使用系统临时目录中的独立 profile，不接触已有登录数据。兼容性测试还以屏幕外的普通窗口检查扩展页、设置页、覆盖超时后的页面恢复和原生网络错误页。快捷方式入口测试使用临时 Node 脚本检查参数传递、等待退出、中文日志和失败提示，不启动 Chrome。自检页的 WebRTC 检查可能访问公开 STUN 服务。
