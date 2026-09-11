---
contract_id: SESSION-MIG-006
version: 1
status: ready
route: direct
source_revision: ide-hub-f6bd318-plan-d1446a27-pi-0.85.1
---

# Codex 会话迁移到 Pi Product Contract

## Source baseline

- 产品基线：[IDE Hub 实现方案](docs/ide-hub-implementation-plan.md)，SHA-256 `d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb`；研究起点 commit `f6bd3187e56ecd3af8885216efa71b1ecde95ac9`。
- 本轮用户要求（2026-09-10）：研究 Pi 会话原理，实现 Codex → Pi；源会话属于目录 A，目标会话仍属于目录 A；本机尚未安装 Pi，先安装 Pi。
- 延续用户已明确的要求：IDE Hub 是本地桌面应用，正式渲染层基于 `prototype/`；迁移应产生可打开、可继续的原生历史，不是将全文 Markdown 塞进输入框；由实现方实际验证续聊，不能让用户替代验收。会话迁移与全局 MCP 迁移独立。
- 本文定型 Codex → Pi 这一有界切片；其他目标、反向迁移、跨电脑 ZIP、独立 MCP 等总方案需求继续保留，未被本轮删除或宣称完成。
- 总方案 §4.1 中 Pi 未安装的状态由本轮安装结果更新；§8.3 的 Pi SessionManager 路线继续采用。不修改总方案。本轮按 `gryy-spec` 只产出合同；安装是用户额外明确授权的操作，不代表迁移功能已开发。

## Objective

在现有 IDE Hub 桌面向导中，把停止执行的 Codex 会话复制为 Pi 原生会话；原会话保留，Pi 恢复后的工作目录仍为 A，历史参与下一轮上下文。

最短闭环：`扫描真实 Codex → 选择 Pi → 固定原目录并预览 → 生成原生历史 → Pi 会话选择器找到并恢复 → 同一会话实际回答旧上下文问题并继续下一步 → 重开核实新增历史`。

Pi 当前官方交互产品是终端 TUI，不是独立桌面 IDE。因此 Hub 中的目标入口应明确写“在终端中打开 Pi 会话”，由 Hub 打开原生 Pi，不新造 Web 页面，也不以静态历史查看器代替 Pi。用户不需要手工复制历史或拼装迁移命令。

`ready` 表示需求和开发入口明确，不表示目标文件落盘、TUI 打开或模型续聊已经验收。

## Background

### 安装基线与已核实的会话机制

官方当前安装包为 `@earendil-works/pi-coding-agent`；旧包 `@mariozechner/pi-coding-agent` 的 npm 元数据已标记迁移到新包。本次执行 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1` 成功，命令 `/opt/homebrew/bin/pi` 返回版本 `0.85.1`，`pi --help` 正常。安装不涉及登录、模型配置或 MCP 配置。[官方安装及恢复说明](https://pi.dev/docs/latest/quickstart)

以下细节以本机安装包 `0.85.1` 的实际发布代码为准，不把在线 latest 当成固定协议：

| 机制 | 本机代码事实 | 对迁移的直接影响 |
| --- | --- | --- |
| 数据根 | `getAgentDir()` 默认 `~/.pi/agent`，支持 `PI_CODING_AGENT_DIR` | 发现实际数据根；不能只猜固定路径，更不能修改用户全局环境 |
| 会话目录 | 默认 `sessions/--编码后的绝对 cwd--/`；CLI 另支持 `--session-dir` 和 `PI_CODING_AGENT_SESSION_DIR` | 默认使用 A 的目录桶；自定义目录时写入、查找、打开必须使用同一目录参数 |
| 会话文件 | JSONL v3：首行为 session header，含 `id/timestamp/cwd`；后续 tree entry 含 `id/parentId/timestamp` | 不依赖 SQLite，不需要修改 IDE 私有索引；不能把 Codex rollout 直接改后缀 |
| 消息与上下文 | `appendMessage` 生成 entry ID 和父子链；`buildSessionContext` 沿 leaf 到根恢复，处理 compaction | 按源顺序建立单一分支；验收检查有效分支而非只统计所有 JSON 行 |
| 标题和来源 | `appendSessionInfo(name)` 提供原生标题；`appendCustomEntry` 不进入模型上下文；`custom_message` 会进入上下文 | 标题用 `Codex · 源标题`；lineage 用普通 custom entry，不用 custom message 装整段历史 |
| 恢复入口 | CLI `--session` 接受文件路径或 ID；`-r`、`/resume` 提供选择器；`SessionManager.open` 默认读取 header cwd | Hub 打开确切文件；列表可发现、恢复后的工作目录和工具工作目录都必须是 A |
| 持久化陷阱 | 新建 manager 的 `_persist` 等到首条 assistant 才首次写文件；`getSessionFile()` 提前就能返回路径 | 不能以路径存在于返回值为成功，也不能为促使保存伪造 assistant |
| 读取副作用 | loader 跳过坏 JSON 行，缺尾换行时补换行；`open` 可升级旧版本并重写 | 预览不用可写 loader；本次输出必须完整、v3、带尾换行，严格逐行校验后再原生回读 |
| 当前模型恢复 | SDK 从最后 assistant 或 model_change 获取 model hint；无法恢复时按 Pi 本地设置选模型 | 导入历史的来源元数据不等于目标续聊模型配置；不能复制 Codex 凭据或伪称目标生成了历史 |

公开格式及 API 概览见 [Pi Session Format](https://pi.dev/docs/latest/session-format)；上述实现细节的固定版本证据见文末。

### 选定的原生投影方式

使用安装包公开 SDK 的 `SessionManager` 构造 Pi 原生 entry，不调用 `createAgentSession()`、CLI prompt、模型或资源加载器来完成导入。后者初始化包含模型和扩展配置，不能因为“不发送问题”就推断完全离线。

为统一处理普通历史与只有 user 的历史，采用 `SessionManager.inMemory(A, { id }) → appendMessage → appendCustomEntry → appendSessionInfo → getHeader/getEntries`。由公开访问器取得完整原生记录，序列化成带尾换行的 JSONL，完成严格校验后写入本次迁移独占文件，再以 `SessionManager.open` 和 `buildSessionContext` 验证。SDK 管理格式与父子关系，Hub 只负责完整文件发布；不调用私有 `_persist/_rewriteFile`，不伪造回复绕过延迟保存。

默认文件应位于 Pi 原生 cwd 桶，文件名沿用时间戳和 session ID 形式。例如 A 为 `/Users/domino/develop/IdeaProjects/temp` 时，默认目录是 `~/.pi/agent/sessions/--Users-domino-develop-IdeaProjects-temp--/`。路径编码调用或对照当前包实现，不能上移到 Git 根；目录名只是定位，header cwd 和目录身份才是归属校验依据。临时产物不以可被 Pi 列表识别的 `.jsonl` 发布；验证后按总方案的独占写入/恢复规则发布完整目标文件。

| 源内容 | Pi 投影 | 必须保留的语义 |
| --- | --- | --- |
| 可见 user 文本 | `message.role=user`，原顺序文本块 | 逐条保留，不拼成一条种子请求 |
| 可见 assistant 文本 | `message.role=assistant`，`content=[text blocks]` | 连续 assistant 仍逐条保留，不套用 Qoder 专用组轮合并 |
| 必需的 assistant 字段 | `api=ide-hub-import`、`provider=ide-hub`、`model=codex-history`、`stopReason=stop`；完整 usage/cost 数值字段为 0 | 这是显式导入标识与未知用量占位，不是实际 provider、模型调用、正常完成状态或零成本证明；真实源状态及可得的模型信息单独保留在 provenance |
| 时间与来源 | entry 时间由 SDK 生成；message 时间优先取源消息时间，其次所属 turn 时间，再次源 thread 时间；来源记录注明时间精度 | 不将迁移时间冒充真实发言时间，不按时间戳重排同时间消息 |
| 源 thread/turn/item ID、hash、原目录 | 普通 `ide-hub-migration` custom entry 与 Hub 现有迁移产物 | 不把 Codex 文件填入 Pi `parentSession`；后者代表 Pi 自身会话分叉关系 |
| 隐藏推理、工具执行记录/待审批、附件等不能原样迁入的内容 | 原始快照/Capsule 按总方案保留，可见文本迁入，未迁移项进入 Loss Report | 不创建可执行 toolCall，不复演命令，不静默遗漏；附件独占消息也必须有损失记录 |

上述导入 model 标识由当前 Pi 的开放字符串类型允许；`transformMessages` 的跨模型路径保留文本，不要求注册这个历史 provider。SDK 恢复时可能提示无法恢复 `ide-hub/codex-history`，再使用 Pi 已配置模型；预览和结果必须说明这是历史来源标识，不让用户为它配置 provider。无可用模型时历史仍应能导入和查看，实际续聊提示在 Pi 配置模型；不能错误要求 IDE Hub API Key。最终模型请求兼容性仍以真实续聊验收为准。

`usage=0` 在当前包的上下文估算中被视为无有效用量，回退文本估算，不会把长历史直接视为零 token。目标实际续聊可能依照 Pi 自己的窗口和压缩设置处理长上下文；迁移阶段不得调用模型压缩或套用现有 seed 的 128 KiB 窗口静默裁剪。原生历史完整保存与模型单次窗口不是一回事。

### 研究验证和工程复用

- 已运行公开 SDK 的纯内存探针：24 条合成 user/assistant 消息（含连续 assistant、相同时间戳），加来源/标题后共 26 条 tree entry；逐条 JSON 序列化并重建 manager，核对 header cwd、session ID、父子链、24 条正文/角色/顺序一致；`convertToLlm → transformMessages` 跨模型文本转换一致。只有 user 的 1 条历史也通过内存重建。探针没有写入 Pi 会话文件、没有调用模型。
- 以上不能证明原生文件发布、`SessionManager.list/open` 的落盘结果、终端打开和实际续聊。开发必须完成这些 Gate，不能把本次探针作为“迁移完成”的证据。
- 当前 `src/types.ts`、`src/request.ts`、`src/migration.ts` 尚无 Pi 目标；`prototype/app.js` 仅有 Pi 产品占位。复用 `src/codex/reader.ts`、`src/seed-context.ts` 的可见消息抽取、`src/workspace.ts` 的目录身份、`src/artifacts.ts` 及现有幂等/回读模式。Pi 不需要照搬 DSH 扩展桥、Cursor blob 协议或 ZCode 桌面索引。
- 适配按现有目标模块风格放入 `src/pi/`，接入现有请求 schema、CLI、Electron 主进程/窄 IPC、`prototype/` 向导和打开入口；不是新增另一套简化 UI。Node SDK 在主进程侧受控 helper 使用，不进 renderer，不引入 HTTP 服务。Pi 要求 Node ≥22.19.0，本机 Node 25.8.0 已满足；打包后的 helper/runtime 也须核实，不能只依赖开发终端 PATH。
- 测试沿用 Node/tsx 和现有 `test/*.test.ts` 入口，分别覆盖纯协议、文件发布/恢复、桌面契约及真实目标续聊。官方 SDK import 是否有启动网络副作用，必须在禁网条件下验证整个 helper；不能只靠 `modelInvoked:false` 字段自证。

## Changes

| ID | Product behavior | 方案依据 |
| --- | --- | --- |
| CHG-001 | 安装并识别 Pi；正式 Electron 界面展示实际版本、兼容/未安装原因，真实 Codex 会话可选择 Pi，沿用预览、执行、结果与打开入口。版本不兼容不写目标，不自动升级安装。 | 本轮先安装及 Pi 目标要求；总方案 §4.1、§8.2、§11；用户 prototype 要求 |
| CHG-002 | 以源 cwd 规范化后的 A 固定目标归属，Pi header、会话定位及恢复后工具工作目录保持 A；不创建 worktree，不改成 B 或 Git 根。目录不存在或身份不一致时写入前停止。 | 本轮明确 A → A；总方案 §7；现有 workspace 行为 |
| CHG-003 | 建立独立 Pi 原生会话，按源顺序保留全部可见 user/assistant 正文和角色，显示 Codex 标题、可追溯来源及明确 Loss Report。支持只有 user、连续同角色和长历史，不伪造 system root、assistant 回复或可执行工具。 | 用户原生历史及不得只塞 Markdown 的要求；总方案 §1、§6、§7.4、§8.3 Pi |
| CHG-004 | 迁移后可从 Pi 的 A 会话列表找到、打开、关闭并恢复；Hub 提供打开确切 Pi 会话的终端入口。实现方在同一会话实际验证上下文问答和承接下一步，新增消息可再次恢复。 | 本轮 Pi 目标；用户实际续聊及实现方验收要求；总方案 §13.2、§13.4、§18 |
| CHG-005 | 安装研究可联网；日常扫描/预览/导入/回读离线且不调用模型，不要求 Hub Key；源、MCP、账号和模型配置不因迁移改变。Pi 主动续聊使用其自身配置，与迁移分阶段验收。 | 用户先安装、本地应用、MCP 独立要求；总方案 §2.3、§9、§10 |
| CHG-006 | 同一源快照、目标目录和适配版本的重复迁移复用正确目标，保留已经发生的 Pi 续聊；失败不假报成功，可恢复或按本次目标精确清理，不覆盖其他会话。 | 总方案 §1、§7.1、§12、§13.2 |

## Out of scope

- 本轮不实现 Pi → Codex、Pi 作为源的全量扫描、ZIP 跨电脑导入导出、Pi MCP 迁移、实时双向同步；总方案相关需求仍保留。
- 不安装第三方 Pi GUI、MCP adapter 或扩展；不修改 Pi 安装包，不复制登录凭据，不实现 Pi 的替代聊天客户端。
- 不迁移隐藏推理、源 system prompt 私有结构、运行进程、未完成工具状态；不通过模型生成摘要替代完整可见历史。
- 本轮 spec 研究不实施业务代码、不创建用户 Pi 历史、不自动配置模型，不 commit/push。

## Constraints

- 原有本地 Electron + `prototype/` 布局、导航和其他未实现页面继续保留；会话与 MCP 操作完全独立。
- 当前 writer 基线限定本机官方 npm 包 `0.85.1` / JSONL v3，锁定相关代码指纹；不能仅凭版本号 v3 就开放未知包版本。旧包名和其他版本只读识别后依总方案 §8.2 验证再支持。
- 目录默认使用当前 Pi 数据根；已有自定义 agent/session 目录不得默默忽略，helper 与终端打开使用同一组已解析路径。预览不得调用会创建目录的 `getDefaultSessionDir` 或默认 `SessionManager.list`，也不得用带修复副作用的 loader 读取用户历史。
- 写入是复制/分叉语义；源停止执行并通过现有快照一致性检查。目标发布、原生回读与迁移记录按现有产物/幂等机制处理，不增加一套后台任务系统。
- 安装成功、内存探针成功、文件可见和真实续聊是不同证据层；缺少 Pi 模型配置时，明确“历史已导入，真实续聊未验证”，不把安装或离线结果算作最终验收。

## Acceptance

| ID | Given | When | Then | Required evidence | 方案依据 |
| --- | --- | --- | --- | --- | --- |
| AC-001 | 官方 Pi 0.85.1 已安装；Hub 扫描出真实 Codex 历史。 | 在正式桌面中选择 Pi 并预览；另测试未安装/未知版本。 | 展示真实版本、固定工作区、逐条历史、损失及 Pi 终端打开方式；预览不写 Pi 目录/会话；不兼容时原因具体且不能执行写入。 | 安装版本输出、正式 UI 演示、预览前后目标文件清单、不兼容分支测试。 | CHG-001、CHG-003；总方案 §8.2、§11 |
| AC-002 | 源 cwd 为 `/Users/domino/develop/IdeaProjects/temp`，另有同目录符号链接、失效目录和 B 目录案例。 | 迁移并恢复 Pi 会话。 | header cwd、目标定位与 Pi 实际工具 cwd 规范化后都是 A，符号链接同身份；失效目录/B 不得产生错误归属会话；自定义数据根时打开/列举仍指向同一目标。 | 源/目标 ID、header 和 SessionManager cwd 回读，Pi 只读执行 pwd 的结果；目录身份及自定义根测试。 | CHG-002；本轮 A → A；总方案 §7 |
| AC-003 | 合成源含连续 user/assistant、同时间戳、只有 user 的会话、超过现有 seed 窗口的长历史和不可移植项。 | 通过 writer 发布文件，严格逐行解析，再原生 open/buildSessionContext。 | 新 ID、v3 header、单一有效父子链和真实标题完整；原生上下文中可见消息的角色、数量、正文、顺序与投影一致；只有 user 也实际落盘可恢复；损失逐项可见，不能偷偷合并/截断或补假回复。 | JSONL 全量校验、原生回读与源逐条/正文 hash 对照、Loss Report、只有 user 文件及重开断言。 | CHG-003；总方案 §6、§7.4、§8.3、§13 |
| AC-004 | 目标已导入到 A。 | 从 Hub 点击“在终端中打开 Pi 会话”，并用 Pi 的 -r 或 /resume 找到该历史；退出后重开。 | 打开的是确切目标 ID，标题和全部历史可见，能继续输入；不是空白新会话、文本附件或另一工作目录。 | Pi 原生 TUI 演示/截图、列表记录、同一目标文件和 session ID 回读；验证打包桌面而非只测开发命令。 | CHG-001、CHG-002、CHG-004；用户原生使用要求；总方案 §13.4 |
| AC-005 | 已关闭再恢复的迁移会话含可核对的旧目标、约束、否决方案及未完成项，Pi 已有可用模型。 | 实现方在 Pi 原生 TUI 发出不包含答案的旧上下文问题，再要求继续一个明确下一步。 | 回答与源事实一致并承接下一步，两轮新增问答进入同一 session；关闭重开后旧历史与新增记录仍存在，无历史结构/provider 参数错误。 | 源事实对照、实际两轮问题/回复、TUI 证据、同 ID 持久化回读；内存探针、桩和仅返回成功均不替代。 | CHG-004；用户实现方真实续聊要求；总方案 §13.2、§13.4 |
| AC-006 | 安装已完成，迁移进程禁网；保存源文件及 MCP/账号/模型配置前基线，不提供 Hub 模型 Key。 | 扫描、预览、原生发布、回读；另检查 Pi 无模型配置场景。 | 迁移离线完成，无模型/扩展执行，源与配置内容不变；无模型仍可导入查看，明确需在 Pi 配置后续聊，不自动复制 Codex 认证。 | 实际禁网运行结果与进程/网络证据，前后内容指纹，无配置分支验证；安装联网与续聊调用独立记录。 | CHG-005、CHG-006；总方案 §2.3、§7.1、§9、§10 |
| AC-007 | 同一快照已迁移且 Pi 新增聊天；另模拟发布/记录中断或目标损坏。 | 重复迁移；恢复或精确清理中断任务。 | 正确目标被复用且新增聊天不变；损坏目标不被成功复用，错误具体；中断不发布半截会话为成功，清理仅限本次迁移，其他会话/源/MCP 不变。 | 同 ID 前后历史对照、发布和记录中断测试、坏行/断链校验、其他会话内容对照及精确清理结果。 | CHG-006；总方案 §8.2、§12、§13.2 |

## Traceability

| Change | Acceptance |
| --- | --- |
| CHG-001 | AC-001、AC-004 |
| CHG-002 | AC-002、AC-004 |
| CHG-003 | AC-001、AC-003 |
| CHG-004 | AC-004、AC-005 |
| CHG-005 | AC-006 |
| CHG-006 | AC-006、AC-007 |

## Open decisions

- None.

## Sources and evidence

| Source | Revision or date | Confirmed facts used |
| --- | --- | --- |
| [总方案](docs/ide-hub-implementation-plan.md) 与用户明确补充 | hash 见 Source baseline；2026-09-10 | 本地桌面、A → A、官方 SessionManager、原生历史、离线、MCP 独立、真实续聊、源只读和恢复要求 |
| [Pi 官方 Quickstart](https://pi.dev/docs/latest/quickstart) | 2026-09-10 访问 | 当前官方包名、终端启动、原生恢复入口；与固定版本本机代码交叉核实 |
| [Pi Session Format](https://pi.dev/docs/latest/session-format)、[官方源码仓库](https://github.com/earendil-works/pi) | 2026-09-10 访问 | 公开 v3 JSONL 树及 SessionManager 参考；在线 main 不作为版本锁 |
| npm 官方包元数据与本机安装 | `@earendil-works/pi-coding-agent@0.85.1`；`pi --version=0.85.1`；Node 25.8.0；npm 11.11.0 | 安装成功，包 engines 为 Node ≥22.19.0；旧 npm 包已 deprecated |
| `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` | SHA-256 `ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3` | v3、路径编码、公开构造和访问器、延迟落盘、读取修复/升级、树上下文、原生列表 |
| 同安装包 `dist/core/messages.js` | SHA-256 `a4e4865e343bf87f8078f75ff179a2a77cd7c2700cf8473476bd4dc5ed36adb6` | `convertToLlm`，custom 与普通 user/assistant 的转换区别 |
| 同安装包 `dist/core/sdk.js` | SHA-256 `6969bd56ba8e1628cd033bb15cb15fe38299f00b5ad84f4f8ef37a33a98681c9` | session model hint 恢复、本地模型选择及 createAgentSession 初始化依赖 |
| 同安装包依赖 `node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js` | SHA-256 `e51975857b2fefa7e9cc108850ddab5a2fd1753a399f3cde00d76cd700ce6d10` | 跨模型文本投影、跳过 error/aborted assistant，不照搬源执行状态 |
| 同安装包 `dist/index.js`、`dist/main.js`、`dist/config.js`、`dist/core/session-manager.d.ts`、`dist/core/compaction/compaction.js`、依赖 pi-ai `dist/types.d.ts` | 安装版本 0.85.1；锚点 `SessionManager`、`getCwd`、`ENV_SESSION_DIR`、`getHeader`、`estimateContextTokens`、`AssistantMessage` | 公开导出、原生恢复 cwd、环境目录、消息必需字段及全零用量估算 |
| 本轮内存探针 | 2026-09-10；官方 SDK 公共入口；24 条消息/26 个 tree entry；另 1 条 user-only | 序列化恢复、父子链、角色正文顺序、跨模型文本转换通过；未落盘、未调用模型、未验证 TUI 续聊 |
| [Codex reader](src/codex/reader.ts)、[可见消息抽取](src/seed-context.ts)、[workspace](src/workspace.ts)、[types](src/types.ts)、[迁移编排](src/migration.ts)、[桌面入口](desktop/main.cjs)、[prototype](prototype/app.js)、[测试配置](package.json) | commit `f6bd3187e56ecd3af8885216efa71b1ecde95ac9` | 现有复用位置和 Pi 尚未接入的事实，不由现有实现反推额外需求 |
