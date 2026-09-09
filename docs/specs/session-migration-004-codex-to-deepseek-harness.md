---
contract_id: SESSION-MIG-004
version: 1
status: ready
route: direct
source_revision: ide-hub-plan-d1446a27-dsh-0.1.0-rc.6-user-2026-09-04
---

# Codex 会话迁移到 DeepSeek Harness Product Contract

## Source baseline

- 产品基线：[IDE Hub 实现方案](../ide-hub-implementation-plan.md)，文件 SHA-256：`d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb`。
- 本轮用户增量要求：研究 DeepSeek Harness 会话原理，实现 Codex 到 DeepSeek Harness 的会话迁移；Codex 会话属于目录 A 时，DeepSeek Harness 中的目标会话也必须属于同一个目录 A。
- 已确认测试工作区：`/Users/domino/develop/IdeaProjects/temp`。
- 本 Contract 把总方案中的 DeepSeek Harness 原生 seed 实验收敛为一个当前可开发的最短闭环，仅锁定本机已安装的 `@deepseek-ai/dsh 0.1.0-rc.6`。未在本 Contract 中列出的能力不进入本次实现。

## Objective

在 IDE Hub 本地桌面应用中，把一个非活跃 Codex 会话复制为 DeepSeek Harness 原生 Session，并强制绑定到源会话的真实工作区；迁移后用户可在 DeepSeek Harness 的同一 Workspace 中找到、打开该会话，并在同一 Session 内发送下一条消息继续上下文。

最短闭环：

`扫描 Codex 会话 → 选择 DeepSeek Harness → 校验 DSH 版本、bridge 和同一工作区 → 投影为合法 SessionEvent seed → 由 DSH 进程创建并持久化 Session → 绑定 Workspace 并原生回读 → 在同一 Session 中继续下一轮`

## Background

对本机安装和官方实现的只读研究得到以下事实：

- 本机目标不是独立的 macOS IDE `.app`，而是 `/opt/homebrew/bin/dsh` 提供的 DeepSeek Harness `0.1.0-rc.6`；官方交互面是 `dsh web` 加本地 Web UI。IDE Hub 自身仍是 Electron 桌面应用，不改成 Web 应用。
- DSH Session 是追加式 `SessionEvent` 日志，事件日志是对话事实源，用户和助手消息由日志派生，不存在可单独导入后仍能续聊的 Markdown 消息库。
- `SessionHeader` 独立保存 `version`、`id`、`createdAt`、`cwd`、seed 边界和 `agentPreset` 等元数据。Workspace 使用 `realpath` 规范化目录，并同时要求 Session ID 被登记且 `SessionHeader.cwd` 与 Workspace 路径相同。
- 本机默认后端把会话保存在 `~/.dsh/sessions/--规范化工作区--/编码后会话ID/session.jsonl.zstd`。首个逻辑记录是 header，后续是连续序号的事件；直接复制、拼接或自行压缩文件不能完成 Workspace 登记和运行时校验。
- `0.1.0-rc.6` 的公开运行时允许插件调用 `ctx.agents.create({ sessionId, seed, meta })` 创建带历史的 Agent/Session，并用 `ctx.agents.resume({ resumeSessionId })` 从持久化日志恢复。seed 必须从 `seq=0` 连续，所有 turn/step 闭合，且没有悬空 tool call。
- 对本机 `dsh-session 0.1.0-rc.6` 的 detached probe 已验证：由一组闭合的 `turn/start`、`step/start`、`user/message`、`assistant/message`、`step/end`、`turn/end` 事件构成的 seed 可以通过原生校验，派生出原顺序 User/Assistant 消息，并由 Session 构造器追加 `session/end-seed`。
- DSH 当前 npm 最新版已是 `0.1.2-rc.1`，其 session、persistence 和 workspace API 已发生变化；同时 Session format 仍为未承诺跨版本兼容的 `v0`。因此本 Contract 不把“版本号仍是 v0”当作兼容证明。

## Changes

| ID | Product behavior | 方案依据 |
| --- | --- | --- |
| CHG-001 | IDE Hub 扫描本机 `dsh`、Web profile 和 IDE Hub DSH bridge。仅当 `dsh --version` 为 `0.1.0-rc.6`、已安装包指纹匹配且 bridge 已在目标 profile 中启用时，正式桌面界面的 DeepSeek Harness 产品与迁移目标才可选择；继续复用现有七步会话迁移向导。 | 实现方案“DeepSeek Harness”“版本变化策略”“正式桌面原型落地要求”；本轮用户要求 Codex 到 DeepSeek Harness。 |
| CHG-002 | 源 Codex 会话属于目录 A 时，目标 Session 的 `SessionHeader.cwd` 和 DeepSeek Harness Workspace 均必须是 A。源目录、header cwd 和 Workspace path 都使用 `realpath` 规范化并完全相同；目录不存在、不是目录或任一规范路径不相同时，在写入前停止且不可绕过。 | 实现方案“路径绑定策略”“DeepSeek Harness”；本轮用户明确要求 A 到 A；DSH Workspace 官方 cwd 成员关系。 |
| CHG-003 | 适配器复用现有 Codex 读取和统一可见消息投影，把 User/Assistant 正文按源顺序生成 DSH `SessionEvent v0` seed。每个投影 turn 使用闭合的 turn/step 边界；消息具有稳定 ID、`surfaceOp=append` 和合法文本 block；助手历史保留 Codex 来源标识但不伪造 DSH replay state。seed 的 `seq` 必须从 0 连续，事件必须可被目标版本原生 Session 校验并派生为与源投影角色、数量、顺序和正文一致的消息。不可移植事件进入 Loss Report，不伪造工具执行、审批、终端状态、内部 reasoning、附件或目标 request header。 | 实现方案“统一 IR”“Loss Report”“DeepSeek Harness 原生投影”；本机 DSH `SessionEvent`、seed 和 surface 校验结果。 |
| CHG-004 | IDE Hub DSH bridge 作为目标 Web profile 中一次安装的本地插件运行，迁移时在 DSH 同一进程内调用 `ctx.agents.create({ sessionId, seed, meta })`，其中 `meta.cwd=A`、seed 边界和目标 `agentPreset` 明确；创建过程不投递 prompt、不触发模型。持久化完成后，bridge 创建或复用 A 对应的 Workspace，调用原生 `attachSession` 登记目标 Session，并用本地 title 能力设置以 `Codex ·` 开头的源会话标题。禁止 IDE Hub 直接写、移动或拼接 `session.jsonl.zstd`、workspace storage 或 projection cache。 | 实现方案“目标 Writer”“DeepSeek Harness”“源端只读、目标端优先官方 API/SDK”；DSH Agent、persistence 和 Workspace 官方接口。 |
| CHG-005 | 任务只有在 DSH 原生回读同时证明 header cwd 为 A、seed 事件结构有效、派生 User/Assistant 消息与源投影一致、Workspace A 已登记目标 Session、目标 UI 可找到并打开时，才报告 `COMPLETED`。发布验收还必须由实现方在该迁移 Session 内实际发送下一条不含答案的上下文问题，得到依赖迁移历史的正确回复，并从原生日志回读新增 turn；只生成 Handoff、只出现历史卡片或只通过 detached fixture 均不算完成。 | 实现方案“真实迁移成功标准”“DeepSeek Harness”“完成标准是目标端真实继续一轮”；本轮用户要求实现会话迁移。 |
| CHG-006 | 会话扫描、读取、投影、DSH 原生创建、Workspace 绑定和回读均不调用模型、不访问外网、不要求 IDE Hub 模型 API Key，也不修改 Codex、DeepSeek Harness 的 MCP 配置或模型凭据。迁移后的用户主动续聊只使用 DeepSeek Harness 已有 provider/model 配置。bridge 只需按目标 profile 安装一次，不随每个会话重复安装或改配置。 | 实现方案“是否需要联网和 API Key”“会话与 MCP 完全拆分”“DeepSeek Harness plugin”；用户已确认本地应用及 MCP 独立迁移。 |
| CHG-007 | 同一源快照、目标工作区、DSH 版本、SessionEvent 投影协议和 bridge 版本重复迁移时复用同一目标 Session，不新增重复历史。任一投影协议或目标版本变化后不得复用旧目标；未知 DSH 版本、包指纹或 Session API 不匹配时在创建前关闭写入能力，不能降级为 Handoff 后宣称原生迁移成功。 | 实现方案“幂等策略”“版本变化策略”“真实迁移成功标准”；DSH Session format v0 不承诺跨版本兼容。 |

## Out of scope

- DeepSeek Harness 到 Codex 的反向迁移。
- DeepSeek Harness `0.1.0-rc.6` 之外版本的写入支持，包括当前 npm 最新的 `0.1.2-rc.1`。
- 把 Handoff Markdown、剪贴板提示或外部 JSONL 文件称为 DeepSeek Harness 原生会话迁移。
- 迁移 Codex 工具调用、审批、内部 reasoning、终端状态和不可移植附件的完整执行语义。
- 会话 ZIP 导入导出。
- MCP 配置、模型 provider、API Key 或账号配置迁移。
- Codex 之外的源产品。
- 把 IDE Hub 改成 Web 应用，或由 IDE Hub 启动公网服务、云端中转和模型调用。

## Constraints

- 仅迁移非活跃 Codex 会话；源会话存在进行中 turn 时不得取不稳定快照。
- 源 Codex 会话始终只读，迁移语义是复制加分叉，不移动、不删除源会话。
- 目标工作区固定为源工作区，不提供目标路径覆盖。
- DSH bridge 是原生 seed 写入的必要目标适配器，属于一次安装的产品插件，不属于 MCP server，也不进入每次会话的迁移数据。
- 目标写入必须在 DeepSeek Harness 进程内通过其 Session、Agent、persistence 和 Workspace 服务完成；IDE Hub 不直接修改 DSH 私有存储。
- 迁移阶段不调用模型；真实下一轮连续性 Gate 使用 DeepSeek Harness 已配置的目标模型，并作为实现验收执行，不把用户当作未验证迁移器的测试者。
- 桌面渲染层只通过 Electron IPC 调用迁移核心；IDE Hub 不增加 localhost Web 服务。与目标 DSH 本地 runtime 的通信只服务于本次目标写入和回读。
- 不把 MCP、ZIP、其他目标适配器或 DSH 新版本适配扩入本 Contract。

## Acceptance

| ID | Given | When | Then | Required evidence | 方案依据 |
| --- | --- | --- | --- | --- | --- |
| AC-001 | 本机 `/opt/homebrew/bin/dsh` 为 `0.1.0-rc.6`，Web profile 和 IDE Hub DSH bridge 已准备。 | 用户在正式桌面 UI 中选择真实 Codex 会话。 | DeepSeek Harness 产品与迁移目标可选择；七步向导展示 DSH 版本、profile、bridge、源和目标工作区、SessionEvent 协议、Loss Report，以及“不调用模型、不迁移 MCP”。 | UI 截图；`dsh --version` 输出；profile/bridge 发现结果；迁移计划 JSON。 | CHG-001、CHG-006；实现方案桌面 UI、版本 Gate 和 MCP 独立性。 |
| AC-002 | `/Users/domino/develop/IdeaProjects/temp` 下存在可迁移的真实 Codex 会话。 | 分别以同目录和其他目录执行预检。 | 同目录计划中的源路径、目标 header cwd 和 DSH Workspace path 都规范化为该测试目录；其他目录在任何目标 Session 创建前失败。 | 三方 `realpath`；文件系统 identity；成功预检记录；错误目录预检失败记录；写入前后目标 Session 数量。 | CHG-002；用户 A 到 A 要求；实现方案路径绑定策略。 |
| AC-003 | fixture 包含多轮 Codex User/Assistant 可见消息和不可移植事件。 | 生成 DSH seed 并交给目标版本的 detached Session 校验。 | seed 从 `seq=0` 连续、turn/step 全部闭合、无悬空 tool call；原生派生消息的角色、数量、顺序和正文哈希与源投影一致；Loss Report 列出未投影事件。 | seed 摘要；原生校验结果；边界计数；逐条消息哈希对比；Loss Report。 | CHG-003；实现方案统一 IR 和 Loss Report；DSH seed 约束。 |
| AC-004 | DSH bridge 运行在目标 Web profile，测试 Codex 会话已完成投影。 | IDE Hub 执行一次真实迁移。 | DSH persistence 回读到目标 Session；header cwd 为测试目录；Workspace 已登记该 Session；DeepSeek Harness UI 在该 Workspace 下显示以 `Codex ·` 开头的源会话标题，可以打开并看到原顺序历史。 | migration ID 和 target Session ID；原生 header/事件/派生消息回读；Workspace sessionIds；DSH UI 截图。 | CHG-004、CHG-005；实现方案原生 writer、回读和历史可见标准。 |
| AC-005 | 已迁移的目标 Session 历史含只有上文才有答案的 sentinel 信息，且目标 Session 已被关闭后重新 resume。 | 实现方在 DeepSeek Harness UI 的同一 Session 中发送不包含答案的连续性问题。 | DSH 基于迁移历史正确回答；新增 User/Assistant 问答持久化在同一 target Session ID 的后续 turn 中，原有迁移历史保持为前缀。 | 连续性问题；DSH 实际回复；target Session ID；新增 turn 的原生日志和派生消息回读；回复哈希。 | CHG-005；实现方案真实下一轮连续性 Gate。 |
| AC-006 | 已记录源快照、Codex MCP、DSH MCP、DSH provider/credential 配置的迁移前哈希，bridge 已在迁移前安装。 | 执行扫描、投影、创建、绑定和回读。 | 迁移阶段没有模型请求和外网请求；源快照及上述配置哈希均不变。用户后续续聊产生的模型请求与迁移阶段分开记录。 | 进程/网络观察记录；迁移日志；前后 SHA-256 对比；续聊请求边界记录。 | CHG-006；实现方案离线、源只读和 MCP 独立性。 |
| AC-007 | 一个源快照已经成功迁移，目标 Session 内还完成了一轮新增对话。 | 对完全相同的源快照再次执行迁移。 | IDE Hub 返回同一 target Session ID，不新增第二个 Session，不覆盖或删除迁移后新增的 turn，源投影仍是目标派生历史的前缀。 | 两次 migration ID；相同 target Session ID；前后 Session 数量；续聊前后原生事件列表。 | CHG-007；实现方案幂等策略；真实会话继续后的重复迁移语义。 |
| AC-008 | 分别提供 DSH 版本、包指纹、bridge 协议和 SessionEvent API 不匹配的 fixture。 | 对每个 fixture 执行预检。 | 写入能力在创建目标 Session 前关闭，目标 Session 数量不变，任务不报告原生迁移成功，也不以 Handoff 降级冒充成功。 | 四类 fixture 结果；错误码；写入前后 Session 数量；任务终态。 | CHG-001、CHG-007；实现方案版本变化策略和真实成功标准。 |

## Traceability

| Change | Acceptance |
| --- | --- |
| CHG-001 | AC-001、AC-008 |
| CHG-002 | AC-002、AC-004 |
| CHG-003 | AC-003、AC-004、AC-005 |
| CHG-004 | AC-004、AC-005 |
| CHG-005 | AC-004、AC-005 |
| CHG-006 | AC-001、AC-006 |
| CHG-007 | AC-007、AC-008 |

## Open decisions

- None.

## Sources and evidence

| Source | Revision or date | Confirmed facts used |
| --- | --- | --- |
| [IDE Hub 实现方案](../ide-hub-implementation-plan.md) | SHA-256 `d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb` | 本地桌面边界、统一 IR、同工作区、DSH plugin、版本锁、原生回读、连续性 Gate 和 MCP 独立性。 |
| 本轮用户指令 | 2026-09-04 | Codex 到 DeepSeek Harness；源目录 A 必须保持为目标目录 A。 |
| 用户已确认测试工作区 | `/Users/domino/develop/IdeaProjects/temp` | 真实 Codex 会话和同工作区验收入口。 |
| `/opt/homebrew/bin/dsh` 与本机全局 npm 安装 | `@deepseek-ai/dsh 0.1.0-rc.6`；2026-09-04 只读检查 | 目标程序形态、实际版本、Web profile 和已安装 package graph。 |
| 本机 `dsh-session`、`dsh-agent`、`dsh-session-persistence-jsonl`、`dsh-workspace` 发布包 | 均为 `0.1.0-rc.6`；核心文件 SHA-256 已记录 | `SessionEvent v0`、`ctx.agents.create/resume`、JSONL Zstd persistence、canonical cwd 和 Workspace membership。 |
| 本机现有 `~/.dsh/sessions` 会话 | 2026-09-04 只读解析一个真实 header 和 4021 个逻辑事件，不读取凭据 | 实际 header、project/session 目录、事件类型、消息 source 和原生 persistence 形态。 |
| 本机 detached Session seed probe | 2026-09-04 | 闭合最小事件 seed 通过 `0.1.0-rc.6` 原生校验，派生 User/Assistant 历史，并自动产生 `session/end-seed`。 |
| [DeepSeek Harness Sessions](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session) | 2026-09-04 访问；官方仓库 master `76fda729799fe9b3848dbe2c211d4b231032b81e` | 事件溯源模型、seed/replay、消息派生和格式兼容边界。 |
| [DeepSeek Harness Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md) | 2026-09-04 访问 | header、persistence seam、原生 load/inspect 和单一事实源。 |
| [DeepSeek Harness JSONL persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md) | 2026-09-04 访问 | project/session 目录布局、Zstandard 多帧、header 和连续事件约束。 |
| [DeepSeek Harness Workspaces](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workspace) | 2026-09-04 访问 | canonical path、`SessionHeader.cwd` 和 `attachSession` 成员关系。 |
| npm `@deepseek-ai/dsh` metadata | 最新 `0.1.2-rc.1`；2026-09-04 查询 | 证明上游版本与 API 已演进，不能把相同 Session format `v0` 当作跨版本兼容。 |
