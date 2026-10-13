# Google Flow Studio MCP

让 Codex 等 MCP 客户端在本机可见的 Chrome / Edge 窗口中操作 Google Flow，完成参考素材上传、图像与视频生成、进度查询、下载和媒体校验。服务使用 **stdio** 通信，以 SQLite 保存项目、任务和素材记录。

- 人工登录后，按浏览器配置目录跨项目复用会话。
- 22 个工具，支持只读接入测试与完整制作流程。
- 生成准备与额度提交分开，生成分辨率与交付分辨率分别记录。
- 任务持久保存，轮询超时后沿用原任务继续查询。

包名与命令名：`google-flow-studio-mcp`。当前版本：`1.0.1`。

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Node.js | 22.13 或更新版本 |
| pnpm | 项目声明使用 10.32.1 |
| 浏览器 | 本机安装 Google Chrome 或 Microsoft Edge，并有可用的桌面会话 |
| Google 账号 | 可以进入 Google Flow，生成前确认账号权限和可用额度 |
| FFprobe | 媒体校验需要；连接、登录、页面读取与下载不依赖它 |

FFprobe 通常随 FFmpeg 一起安装。将其加入 `PATH`，或设置 `FLOW_FFPROBE_EXECUTABLE`。健康检查会检查 FFprobe，缺失时返回 `degraded`，但不影响只读接入测试。项目使用 `playwright-core` 调用本机浏览器，无需另行下载 Playwright 浏览器。

## 从源码安装

```sh
git clone https://github.com/jinhk7/google-flow-studio-mcp.git
cd google-flow-studio-mcp
pnpm install --frozen-lockfile
pnpm build
```

MCP 入口为 `dist/src/index.js`。直接运行 `pnpm start` 会启动 stdio 服务，等待 MCP 客户端通信。

## 接入 Codex

编辑 `~/.codex/config.toml`，保留已有配置，添加下面的服务。将路径替换为本机绝对路径；Windows 的 TOML 字面量字符串可以直接使用反斜杠。

### 只读配置

```toml
[mcp_servers.google-flow-studio]
command = "node"
args = ['C:\path\to\google-flow-studio-mcp\dist\src\index.js']
startup_timeout_sec = 30
tool_timeout_sec = 660
enabled_tools = [
  "mcp_health_check",
  "project_create",
  "project_list",
  "project_get",
  "flow_start_login",
  "flow_auth_status",
  "flow_confirm_login",
  "flow_inspect_page",
  "flow_open_project",
  "flow_open_media",
]

[mcp_servers.google-flow-studio.env]
FLOW_DATA_DIR = 'C:\path\to\google-flow-studio-data'
```

macOS / Linux 将 `args` 换成类似 `['/absolute/path/google-flow-studio-mcp/dist/src/index.js']` 的路径，`FLOW_DATA_DIR` 同样使用本机路径。若 Codex 找不到 `node`，将 `command` 改为 Node.js 可执行文件的绝对路径。

该工具列表支持登录和页面读取，会保存本地项目与登录状态；上传、填写、点击、生成和下载工具未启用。配置项见 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

重新加载 MCP 服务或重启 Codex 后，可以直接说：

> 使用 google-flow-studio 检查连接和登录状态，复用已有本地项目与有效登录。只有需要登录时再打开登录窗口等我亲自完成。只读取 Flow 首页和我指定的已有项目，不上传素材，不发起生成。

### 启用完整工作流

需要生成时，从同一服务配置中移除 `enabled_tools`，或将所需工具加入列表，然后重新加载服务。启用工具并不等于批准消耗额度：每次提交仍须先明确确认生成内容、页面参数和显示的费用，再调用 `flow_submit_generation`。

默认的 `flow_wait_for_generation` 最长等待 600 秒，因此示例将客户端工具超时设为 660 秒。若使用其他 `timeoutSeconds`，客户端超时应留出余量。

### 其他 MCP 客户端

支持本地 stdio 的客户端可以使用：

```json
{
  "mcpServers": {
    "google-flow-studio": {
      "command": "node",
      "args": ["/absolute/path/google-flow-studio-mcp/dist/src/index.js"],
      "env": {
        "FLOW_DATA_DIR": "/absolute/path/google-flow-studio-data"
      }
    }
  }
}
```

根据客户端的配置方式设置工具权限与调用超时。

## 登录与项目

先调用 `mcp_health_check` 检查连接，再通过 `project_list` / `project_get` 复用本地项目。新建项目才调用 `project_create`：它返回本地 UUID，不在 Flow 云端创建项目，也不重置登录。实际 Flow 项目通过 `flow_open_project` 传入官方项目 URL 进行关联。

登录属于**浏览器配置目录**，可以跨本地项目和对话复用。每次开始或续作先调用 `flow_auth_status`：

| 状态或场景 | 下一步 |
| --- | --- |
| `ready` | 直接打开项目或读取页面，沿用有效会话 |
| 首次使用或需要重新登录 | 调用一次 `flow_start_login`，进入下面的人工登录流程 |
| `awaiting_user_fresh_sign_in` / `signed_in_unconfirmed` | 等待用户完成；用户已表示完成时，立即调用 `flow_confirm_login` |
| 用户明确要求重开未完成的登录窗口或更换账号 | 调用 `flow_start_login`，传入 `reopen: true` |

人工登录流程：

1. 用户在打开的普通浏览器中亲自登录 Google，进入 Flow，确认访问权限与可用额度。
2. 关闭使用该专用配置目录的所有窗口，并告诉客户端登录已完成。
3. 客户端调用 `flow_confirm_login`，记录三项确认并打开受控浏览器，再调用 `flow_inspect_page` 读取页面。

等待确认时，轮询 `flow_auth_status` 不会代替用户确认。`flow_start_login` 默认 `reopen: false`，重复调用会复用有效或待确认的登录流程；`flow_confirm_login` 也可重复调用。关闭受控窗口后，后续操作可以恢复同一配置目录中的会话。

接口保留 `userConfirmedFreshSignIn` 参数与 `freshLoginForProjectId` 字段；后者仅记录确认来源，不要求每个项目重新登录。

## 生成与下载

打开目标项目后，先用 `flow_inspect_page` 获取当前控件标签或索引，再按顺序操作：

1. 设置图像 / 视频模式、模型、画幅和时长；需要参考图时，用 `flow_upload_reference` 上传，再用 `flow_bind_asset` 绑定。
2. 调用 `flow_prepare_generation` 填写提示词、应用视频生成分辨率并保存任务，取得 `jobId`。
3. 用户明确批准本次额度消耗后，在同一页面紧接着调用 `flow_submit_generation`。
4. 用 `flow_wait_for_generation` 查询结果，再用 `flow_download_media` 下载。
5. 用 `media_validate_local` 检查文件、尺寸、时长和音轨，并实际审看媒体。

`project_create` 的 `durationSeconds`、`aspectRatio` 和 `language` 用于记录制作要求；页面中的模型、时长和画幅需要另行设置。`flow_prepare_generation` 自动应用提示词与视频生成分辨率。

### 视频分辨率

| 最终交付目标 | 默认生成分辨率 | 下载时选择 |
| --- | --- | --- |
| 720p | 360p | 页面提供的 720p 选项 |
| 1080p | 720p | 页面提供的 1080p 选项 |

用 `finalVideoResolution` 在创建项目或准备视频时保存交付目标，后续镜头沿用该项目默认值。目标未确定时，工具会要求补充后再准备视频。

例如，准备一个最终交付 720p 的镜头：

```json
{
  "projectId": "<本地项目 UUID>",
  "operation": "video",
  "shotIndex": 1,
  "version": 1,
  "prompt": "镜头缓慢推近，一片枯叶随风落在石阶上，树影在午后阳光中轻轻晃动。",
  "textboxLabel": "Flow prompt",
  "finalVideoResolution": "720p"
}
```

`textboxLabel` 应来自当前页面检查结果。此例默认生成 360p 源视频；如果需要原生 720p，可以同时传入 `generationResolution: "720p"`。1080p 交付要求使用 720p 生成。提交前，工具会核对页面分辨率是否与保存的任务一致。

下载同一任务：

```json
{
  "projectId": "<本地项目 UUID>",
  "jobId": "<已完成任务 UUID>",
  "fileName": "s01.mp4"
}
```

`flow_download_media` 默认继承任务的交付目标；直接以 `mediaId` 或 `title` 下载时继承项目目标。可显式指定 `resolution: "original"`、`"720p"` 或 `"1080p"`，图像保持原始尺寸。响应及本地记录保存 `downloadedResolution` 和 `downloadVariant`，分别表示所选下载选项的分辨率和原始 / 升档类型。

## 任务恢复与超时

任务和已发现的媒体 ID 持久保存在 SQLite。服务重启后使用相同数据目录，通过 `project_get` 读取任务、`flow_auth_status` 恢复会话，再打开原项目继续查询或下载。

| 情况 | 行为与处理 |
| --- | --- |
| 生成轮询超时 | 保留本地 `generating` 状态；返回 `providerStatus: "unknown"`、`retryAction: "flow_wait_for_generation"`、`resubmitSafe: false`，继续查询原 `jobId` |
| 重复准备同一项目、操作、镜头和版本 | 复用未失败任务，不重新填写提示词；修改提示词或分辨率需使用新 `version` |
| 同一镜头已有 `submitted`、`generating` 或 `paused` 任务 | 阻止准备或提交另一版本；先观察原任务，或在页面核实实际完成 / 失败后记录结果 |
| 下载仍在处理中 | 在同一 MCP 进程内用相同参数重试，继续原下载而不再次点击 |

`flow_wait_for_generation` 默认每 10 秒检查一次、最多等待 600 秒；可设等待 10–1800 秒、间隔 3–60 秒。超时响应的 `observation` 提供页面 URL、标题、可见媒体数和失败提示数。`updatedAt` / `lastObservedAt` 是本地记录时间，不表示 Google 队列进度；未发现匹配素材不能作为重新提交的依据。

`flow_download_media` 单次等待约 50 秒，页面下载事件最多等待 600 秒。待下载请求只存在于当前 MCP 进程，服务重启或请求终止后需重新发起下载。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `mcp_health_check` | 检查版本、运行进程、SQLite、浏览器路径、FFprobe 与本地记录数量 |
| `project_create` | 创建本地项目，保存制作要求与交付分辨率 |
| `project_list` | 列出本地项目 |
| `project_get` | 读取项目及关联任务、素材 |
| `flow_start_login` | 复用有效或待确认的登录流程，需要时打开普通浏览器登录窗口 |
| `flow_auth_status` | 检查并恢复浏览器配置目录的登录会话，不读取凭据字段 |
| `flow_confirm_login` | 记录用户对登录、访问权限和额度的确认，供各项目复用 |
| `flow_inspect_page` | 读取页面文本、控件、素材和失败提示数量 |
| `flow_open_project` | 打开官方 Flow 项目 URL，并关联本地项目 |
| `flow_open_media` | 按媒体 ID 或唯一标题打开素材详情 |
| `flow_fill_text` | 填写检查结果中的非凭据文本框 |
| `flow_click_control` | 点击检查结果中的控件；额度操作须批准 |
| `flow_upload_reference` | 上传本地参考素材并登记记录 |
| `flow_bind_asset` | 将页面素材拖入提示词框，建立实际引用 |
| `flow_prepare_generation` | 准备提示词与生成参数，建立可复用任务 |
| `flow_submit_generation` | 在用户批准额度消耗后提交已准备任务 |
| `flow_wait_for_generation` | 持续查询生成结果并保存观察到的状态 |
| `job_record_result` | 保存已在页面核实的状态与媒体 ID |
| `flow_download_media` | 按任务、媒体 ID 或标题下载指定质量的素材 |
| `flow_download_asset` | 点击指定下载控件，将文件保存到本地 |
| `media_validate_local` | 使用 FFprobe 检查本地媒体、时长、画幅与音轨 |
| `state_backup` | 创建一致的 SQLite 备份，不覆盖已有目标文件 |

`flow_download_asset` 是通用控件下载工具，不选择交付分辨率；视频交付使用 `flow_download_media`。

## 数据与配置

默认数据目录为 `~/.google-flow-creator/`，可以用 `FLOW_DATA_DIR` 指定独立目录：

```text
browser-profile/   浏览器配置与登录会话
state.sqlite       项目、任务、素材与事件
state.json         可选的旧版 JSON 状态导入源
downloads/         下载的媒体
```

| 环境变量 | 用途与默认值 |
| --- | --- |
| `FLOW_BROWSER_EXECUTABLE` | Chrome / Edge 可执行文件路径；未设置时搜索常见安装位置 |
| `CHROME_PATH` | 备用浏览器路径，优先级在 `FLOW_BROWSER_EXECUTABLE` 之后 |
| `FLOW_DATA_DIR` | 数据根目录，默认 `~/.google-flow-creator` |
| `FLOW_PROFILE_DIR` | 独立浏览器配置目录，默认 `<数据目录>/browser-profile` |
| `FLOW_DATABASE_FILE` | SQLite 路径，默认 `<数据目录>/state.sqlite` |
| `FLOW_STATE_FILE` | 旧版 JSON 状态导入路径，默认 `<数据目录>/state.json` |
| `FLOW_DOWNLOAD_DIR` | 下载目录，默认 `<数据目录>/downloads` |
| `FLOW_FFPROBE_EXECUTABLE` | FFprobe 可执行文件，默认从 `PATH` 运行 `ffprobe` |

通过 MCP 客户端的 `env` 或进程环境设置变量。服务不会自动读取 `.env`；`.env.example` 用于说明可用配置。路径建议使用绝对路径。

浏览器配置包含登录会话，SQLite 包含项目、提示词及素材信息，应保留在本机。仓库已忽略常见运行数据、数据库、下载目录及本地环境文件。`state_backup` 备份 SQLite，不包含浏览器配置和媒体文件。

## 开发与维护

| 命令 | 用途 |
| --- | --- |
| `pnpm run check` | TypeScript 类型检查 |
| `pnpm test` | 构建后测试状态、MCP 工具、stdio 协议和页面适配；浏览器测试使用本地 HTML，不登录 Google 或发起生成 |
| `pnpm run health` | 通过 stdio 调用健康检查，不打开 Flow |
| `pnpm run backup` | 创建一致的 SQLite 备份 |
| `pnpm run smoke` | 读取实际 Flow 项目、下载既有视频并校验；会打开浏览器、写入下载文件及素材记录 |

维护脚本与 MCP 服务使用相同的环境变量和默认数据目录。要维护自定义目录，请在运行命令的终端中设置与客户端一致的 `FLOW_DATA_DIR` 或各项路径；Codex 配置中的 `env` 不会自动作用于另一个终端。

### 既有视频回归检查

`smoke` 要求 `ready` 登录状态、已关联 Flow URL 的本地项目和完整视频。它会启动独立 MCP 进程；先断开占用同一配置目录的现有浏览器会话，再设置以下变量运行：

| 环境变量 | 用途 |
| --- | --- |
| `FLOW_SMOKE_PROJECT_ID` | 必填，本地项目 UUID；项目须已关联实际 Flow URL |
| `FLOW_SMOKE_MEDIA_ID` | 待检查的既有视频媒体 ID；与 `FLOW_SMOKE_JOB_ID` 至少设置一项 |
| `FLOW_SMOKE_JOB_ID` | 所选项目中已完成、已保存媒体 ID 的视频任务；同时提供媒体 ID 时，两者须匹配 |
| `FLOW_SMOKE_PROJECT_URL` | 可选，核对项目已保存的 Flow URL |

脚本下载原始版本到配置的下载目录，待下载时沿用同一连接和参数继续等待，总上限 300 秒。下载后用 FFprobe 检查媒体并解码开头一秒，确认至少有一帧可读取。它不限定时长、画幅或音轨，不新建项目或提交生成。

主要源码位于 `src/server.ts`（工具接口）、`src/flow-adapter.ts`（页面操作）、`src/state.ts`（SQLite 状态）及 `src/media-validator.ts`（媒体校验）。

### 更新与服务重连

更新源码后执行 `pnpm install --frozen-lockfile` 和 `pnpm build`，再重新连接客户端中的 MCP 服务。**覆盖 `dist/` 不会更新已运行的进程。** 待下载请求应在原进程完成后再重连。

通过客户端当前连接调用 `mcp_health_check`，核对 `version`、`runtime.processId`、`runtime.startedAt` 和 `runtime.entrypoint`。`pnpm run health` 启动的是临时服务，其结果不能证明 Codex 原有连接已加载新版本。

## 已知限制

- 本项目是非官方浏览器自动化工具，与 Google 无隶属关系。需要本地桌面、可见浏览器及有效 Flow 会话；页面结构、控件名称或登录策略变化可能需要更新适配。
- 模型、时长、画幅、生成费用与升档下载权限以当前账号页面为准。分辨率路由不承诺所有账号都能免费升档；目标下载项缺失、禁用或显示需升级时，工具会报错。
- 页面自动化共用一个浏览器上下文，应串行操作，准备与提交保持在同一项目页面。轮询通过媒体基线识别新增素材，人工或其他客户端并行生成可能使结果归属不明确。
- 同一浏览器配置目录同时只供一个会话使用，日常操作沿用现有 MCP 连接，避免另开 stdio 服务或浏览器争用。账号会话失效后需用户重新登录；密码、验证码和账号验证均在浏览器中由用户操作。
- Google 提示浏览器无法登录时，应在 `flow_start_login` 打开的普通浏览器窗口中处理；受控浏览器用于登录完成后的页面操作。
- 下载菜单记录和 FFprobe 检查不等于画面、动作或声音质量审核，交付前仍需实际查看媒体。

## 许可与致谢

本项目采用 [MIT License](LICENSE)，保留原作者的版权声明。

部分实现参考 [hitjcl/google-flow-mcp](https://github.com/hitjcl/google-flow-mcp)。
