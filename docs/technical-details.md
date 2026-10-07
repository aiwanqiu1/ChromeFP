# ChromeFP 技术说明

安装和常用命令见 [README](../README.md)。本文说明出口检测、覆盖范围和实验功能的边界。

## 工作方式

1. 在所选 profile 的后台 Chrome 中读取出口 IP。查询目标不可见，使用该浏览器的网络进程，请求禁用缓存且不携带 Cookie。
2. 按固定来源顺序选择有效 IP，再查询这个 IP 的归属地，校验 IP、国家、时区和坐标。首次查询无法取得有效数据时停止启动。
3. 普通窗口模式下，先关闭后台启动的 Chrome，保存原生语言偏好，再打开可见窗口并复查出口。语言更新保留 profile 中其他设置和站点数据。
4. 通过 Chrome DevTools Protocol（CDP）及页面补丁应用覆盖，在页面脚本执行前完成初始化；对新标签页、iframe 和 Worker 自动附加。
5. 根据 IP 生成核心数、内存读数及 Canvas / Audio 扰动种子。未指定完整身份、WebGL 或屏幕参数时，保留这些字段的 Chrome 原生值。
6. 每轮检测结束后等待 10 秒，再查询出口和系统代理设置。IP 改变时更新已打开的目标与新文档脚本，自检页同步显示新配置。

系统代理配置改变但 IP 相同时，会刷新出口描述和 WebRTC 过滤设置，保留同一 IP 的派生参数。查询失败时继续使用上一次有效配置；更新失败时记录警告，在后续检测中重新应用配置，修复部分目标更新失败的情况。

### 目标附加与兼容性

启动器需要在浏览器使用期间保持运行。快捷方式在后台维护会话，Chrome 进程退出后结束；CMD 模式需要保持命令行窗口开启。

重复点击默认快捷方式或仅指定 `--profile` 的后台入口，会切回已有窗口。首次启动尚未完成时，后续点击最多等待两分钟。其他参数交给命令行入口处理，同一 profile 的占用检查仍然生效。

关闭最后一个窗口通常会退出 Chrome。下载等任务可能让浏览器继续留在后台，此时快捷方式会在原会话中恢复一个空白窗口。会话结束后再次启动，会重新检测出口并打开自检页。

启动期间出现的初始空白窗口和恢复的旧标签页，会在本次页面打开后关闭。单个目标覆盖超时或失败时，启动器记录警告并解除调试暂停，其他窗口继续运行；该目标的读数可能与配置不一致。初始化失败或会话结束时，会清理本次启动的 Chrome 进程与自检服务。

Chrome 内部的扩展管理、设置等页面不执行网页接口补丁。返回普通网站后仍应用覆盖。网站的网络、代理和证书错误保留 Chrome 原生错误页，便于诊断和重试。

## 区域与语言

语言映射覆盖 249 个 ISO 国家与地区：明确配置的多语言地区保留其偏好，其余地区使用 CLDR 常用语言数据。如果 Chrome 缺少某种语言的格式化数据，会选择当地使用且受支持的语言，并保留真实地区代码。

覆盖包括 Chrome 原生菜单语言偏好、网站首选语言、翻译目标，以及网页 / Worker 语言读数与请求头。运行中切换地区时，网站语言、翻译目标和网页读数会更新；菜单语言需要结束会话并重新启动。自检页显示待生效的菜单语言，实际可用语言取决于本机 Chrome 的资源。Chrome 的显示语言也需要重启生效，见 [Chrome 官方语言设置说明](https://support.google.com/chrome/answer/173424?hl=zh-Hans)。

网站自行保存的账号、Cookie 或网址语言设置可能优先于浏览器偏好。改变请求语言不会重写已经显示的正文，ChromeFP 保留这些站点数据。

定位覆盖使用 IP 归属地接口的坐标，并向浏览器报告 5000 米的准确度参数；这个参数不能保证数据库坐标的实际误差。默认会为该浏览器会话授予地理位置权限。使用 `--no-geo-location` 可关闭定位覆盖及启动器的权限授予。

## 出口检测与缓存

出口检测会查询 ipify 和 IPQuery，按固定顺序选择有效 IP。不同检测域名返回不同 IP 时，会在日志和自检页显示观测结果及分流提示，选择不会取决于响应速度。

归属地查询只接受所选 IP 的有效响应。优先使用 IPQuery，必要时尝试 ipapi.co 和 ipinfo.io；国家、时区、坐标或返回 IP 不符合要求时，会尝试后续接口。所有接口失败时，首次启动会停止，运行中的会话会保留上一次有效配置并重试。

### 代理与机房判定

启动器通过相同的 Chrome 网络设置，向 IPQuery 查询所选 IP 的 `risk.is_proxy` 和 `risk.is_datacenter` 字段。自检页和日志显示“是 / 否 / 未知”以及判定来源，“是”或未知显示黄色提示。

此查询默认最多等待 5 秒。接口失败、限流、缺少布尔字段或返回其他 IP 时，对应判定保持未知；有效归属地仍可用于启动。代理判定单独使用 `is_proxy`，不合并 VPN / Tor 标记，也不根据本地代理开关推断。

### 同一 IP 的数据复用

每次启动和每轮检测都重新读取出口 IP。默认不读取跨会话缓存；可显式启用：

```powershell
node fp-browser.mjs --cache-geo 5
node fp-browser.mjs --cache-geo 5 --refresh
```

`--cache-geo 5` 将归属地和代理 / 机房判定保存到本机，允许启动时读取五分钟内的有效缓存。缓存键包含代理模式及系统代理配置，只有实时检测的 IP 与缓存 IP 一致时才复用，IP 改变时重新查询归属地和判定。

运行中的会话也会复用上一次相同 IP 的归属地和判定，不受跨会话缓存开关影响。`--refresh` 只在本次启动时跳过已有缓存，不会让每一轮检测都重新查询相同 IP 的全部数据。需要更新相同 IP 的未知判定或归属地时，结束会话后使用 `--refresh` 重启。

查询接口和目标网站使用同一套浏览器网络设置，但 PAC、分流规则、TUN 或轮换代理可能按域名分配不同出口，一次检测无法保证所有网站出口相同。多个代理软件同时运行时，TUN 或重复占用的端口也可能影响实际出口。

## 可选 UA 与完整 Client Hints

完整身份配置会在页面最早脚本与导航请求之前，同时覆盖 UA 和 Client Hints metadata：

```powershell
node fp-browser.mjs --identity examples/windows-identity.json
```

[示例文件](../examples/windows-identity.json) 使用 Windows x64 桌面身份。`platformVersion: "13.0.0"` 只是示例值，使用前请按实际系统填写。UA 中的 `{major}` 和完整品牌版本中的 `{version}` 会替换为本机 Chrome 的实际版本。

JSON 文件需要提供：

- `userAgent` 和旧 `navigator.platform` 对应的 `platform`。
- 完整 `userAgentMetadata`：`brands`、`fullVersionList`、`platform`、`platformVersion`、`architecture`、`model`、`mobile`、`bitness`、`wow64`、`formFactors`。旧版 `fullVersion` 可选。

当前只接受与本机系统和架构一致的桌面 Chrome 身份，要求 `mobile: false`、`model: ""`、`wow64: false`、`formFactors: ["Desktop"]`。UA 可使用实际完整版本或相同主版本的缩减形式；两个真实品牌的完整版本必须匹配本机 Chrome，并提供一致的 GREASE 品牌。

只提供 UA、字段不完整、跨平台、版本不符或字段矛盾时会报错。文件结构在网络查询前校验，实际浏览器版本在调试连接建立后、目标附加前校验。文件支持 UTF-8 BOM，上限为 64 KB。

语言仍由出口地区产生；完整身份覆盖会同时携带该 `Accept-Language`。新标签页、跨域 iframe 和 Worker 的 JS 身份均参与覆盖。Worker fetch 保留 Chrome 原生的 Client Hints 行为，不额外伪造 CH 请求头；UA 请求头和 JS 读数保持一致。自检页对照 UA、低熵和高熵 Client Hints。

字段校验只能约束本次覆盖的身份字段，无法改变浏览器内核、字体或真实硬件。

## 实验性视口、屏幕与 DPR

```powershell
node fp-browser.mjs --viewport 1280x720 --screen 1920x1080 --dpr 1.25
node fp-browser.mjs --identity examples/windows-identity.json --viewport 1280x720 --screen 1920x1080 --dpr 1
```

`--screen` 和 `--dpr` 需要同时提供 `--viewport`。尺寸范围为 64–16384，视口不能大于屏幕，DPR 范围为 0.5–4。仅指定视口时，屏幕默认为相同尺寸，DPR 默认为 1。

此功能使用 `Emulation.setDeviceMetricsOverride` 仿真顶层页面，不改变系统桌面。**跨进程 iframe（OOPIF）的 screen / DPR 保留原生值**：当前实现不对 iframe 应用该命令，iframe 的实际容器尺寸也保持原状。

顶层页面、同进程 iframe、跨进程 iframe 和物理窗口的读数，不能因此视为完整设备一致性。`outerWidth` / `outerHeight`、可用工作区、真实显示器和窗口边框保留原生行为。启动器会提示限制，默认不启用此实验功能。

## 硬件与渲染补丁

默认按 IP 生成核心数、内存和固定的 Canvas / Audio 扰动，WebGL 名称保持原生值。可显式指定：

| 参数 | 覆盖范围 |
|---|---|
| `--cores 8` | 网页、iframe 和 Worker 的硬件并发读数 |
| `--device-memory 8` | `navigator.deviceMemory` 读数 |
| `--webgl "厂商\|渲染器"` | 网页读取的 WebGL 厂商和渲染器名称 |
| `--canvas-noise` | 已默认开启，给 2D Canvas 读取和导出添加固定扰动 |
| `--audio-noise` | 已默认开启，给频率数据和 AudioBuffer 采样读数添加固定扰动，支持 OfflineAudio 指纹 |

Canvas 扰动不修改原画布，相同原始数据与种子的重复读取保持稳定。补丁不覆盖全部 WebGL / OffscreenCanvas 读取路径，WebGL 名称覆盖也不改变真实 GPU 渲染。当前命令行没有关闭 Canvas / Audio 扰动的选项。

同一 IP 的不同 profile 使用相同派生参数。IP 改变会重新派生指纹编号与扰动种子，核心数和内存取自有限配置集合，可能保持相同。实际 Canvas / Audio 哈希仍取决于内容、本机渲染和补丁覆盖范围，不能保证每次换 IP 都得到不同的完整读数。

`deviceMemory: 32` 不能仅凭数值判为异常。Chromium 主分支的桌面实现允许上限 32，Android 使用不同范围；本机行为仍取决于所装版本。实现见 [Chromium 内存读数源码](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/common/device_memory/approximated_device_memory.cc)。

### 安装状态与未覆盖项

页面补丁不向全局对象写入 `Symbol.for('ChromeFP.provider.installed')`。包装器通过闭包中的 WeakMap 和每个驱动生成的一次性私有令牌复用安装状态；同一份 provider source 的继承和重复求值不会反复包装原型。IP 切换更新闭包种子，避免叠加噪声。这些措施不保证脚本无法被检测。

当前未加入字体白名单、字体度量噪声、通用 `drawImage` / WebGL `readPixels` 扰动或 WebGPU 名称覆盖。这些功能需要同时处理字体匹配、布局、像素格式和 GPU 能力的一致性；现有补丁只覆盖上文列出的范围。

## WebRTC 过滤

自动模式下，显式代理、系统代理、PAC、自动发现启用或代理状态未知时开启过滤；明确直连时默认关闭。可使用 `--webrtc-protect` / `--no-webrtc-protect` 指定行为。

过滤覆盖以下常见读取路径：

- `icecandidate` 事件，包括函数监听器、对象监听器和 `onicecandidate`。
- `createOffer` / `createAnswer` 以及本地 SDP 描述。
- 连接、发送器和接收器的候选统计，以及部分 ICE transport 读取接口。

过滤会丢弃与期望出口不符的直连数值地址候选，保留 mDNS 本地候选与 TURN 中继候选，并过滤中继候选关联的客户端地址。监听器删除、`once` 和 `AbortSignal` 语义保持可用。

TURN 中继地址属于中继服务，保留这些候选用于中继连接；相关候选策略见 [W3C WebRTC relay 说明](https://www.w3.org/TR/webrtc/#rtcicetransportpolicy-enum)。ChromeFP 的页面补丁并不设置网络层 relay 策略，过滤只影响网页可见读数，不能保证底层网络防泄露。代理和网络配置仍决定实际流量路径，补丁可能影响视频通话或被页面检测。

自检页检查事件、SDP 和统计中的可见地址，包括 IPv6；未取得候选时显示“结果不确定”。网络失败不算作过滤成功。自检可能访问 `stun:stun.l.google.com:19302`。

## 模块目录

| 文件 | 职责 |
|---|---|
| `lib/options.mjs` | 参数与 profile 路径校验 |
| `lib/launcher-config.mjs` | 项目代理配置及命令行优先级 |
| `lib/cdp.mjs` | CDP 客户端、Chrome 启动与 profile 独占检测 |
| `lib/systemproxy.mjs` | 系统代理读取、代理就绪等待、缓存键与 WebRTC 自动选择 |
| `lib/geo.mjs` | 出口、归属地和代理 / 机房判定查询与校验 |
| `lib/config.mjs` | 国家到语言的映射 |
| `lib/fingerprint.mjs` | IP 派生参数与配置组装 |
| `lib/ip-monitor.mjs` | 出口变化检测、串行更新与取消清理 |
| `lib/browser-language.mjs` | Chrome 原生语言偏好保存与更新 |
| `lib/identity.mjs` | 完整 UA / Client Hints 身份校验 |
| `lib/driver.mjs` | 目标附加、覆盖完成等待与失败处理 |
| `lib/restore-window.mjs` | 在已验证的原会话中恢复空白窗口 |
| `lib/provider.mjs` | 页面接口补丁 |
| `lib/verifypage.mjs` | 本地自检服务与页面 |
