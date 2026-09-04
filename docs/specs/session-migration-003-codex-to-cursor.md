---
contract_id: SESSION-MIG-003
version: 3
status: implemented-continuity-gate-passed
route: direct
source_revision: ide-hub-plan-d1446a27-user-2026-09-03
---

# Codex 会话迁移到 Cursor Product Contract

## Source baseline

- 产品基线：[IDE Hub 实现方案](../ide-hub-implementation-plan.md)，文件 SHA-256：`d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb`。
- 本轮用户增量要求：研究 Cursor 会话机制，实现 Codex 到 Cursor 的真实会话迁移；Codex 会话属于目录 A 时，Cursor 中的目标会话也必须属于同一个目录 A。
- 本 Contract 将方案中的 Cursor 目标适配器收敛为一个最短闭环，仅覆盖当前已验证的 Cursor `3.18.9`。未在本 Contract 中列出的能力不进入本次实现。

## Objective

在 IDE Hub 本地桌面应用中，把一个非活跃 Codex 会话复制迁移为 Cursor 原生会话，并强制绑定到源会话的真实工作区；迁移后用户可在 Cursor 的 Chat History 中找到、打开该会话，并发送下一条消息继续上下文。

最短闭环：

`扫描 Codex 会话 → 选择 Cursor → 校验同一工作区和 Cursor 版本 → 生成 Cursor 原生导入载荷 → 调用 Cursor 内置导入 → 从 Cursor 原生存储回读验证 → 在 Cursor 中打开并继续下一轮`

## Background

对本机 Cursor `3.18.9` 的只读研究得到以下实现事实：

- Cursor IDE 的会话索引和主体保存在 Cursor 用户数据目录，工作区映射由 `workspaceStorage` 管理；仅写入 `agent-transcripts` Markdown 或 JSONL 不会让会话成为 Chat History 中可继续的原生会话。
- 当前桌面包内置 `developer.importChat` 和 `developer.bulkImportChats` 命令。导入器读取版本为 `1` 的 Cursor Chat JSON，将会话写入 Cursor 自己的持久化层，并把新会话的 `workspaceIdentifier` 设置为导入时当前打开的工作区。
- Cursor Chat JSON v1 的主体是 Base64 编码的 `ConversationState` protobuf，并通过 `blobs` 携带用户消息、助手消息和 turn 等被引用对象。当前 Cursor `3.18.9` 的 `root_prompt_messages_json` 每个 field-1 entry 必须是 32 字节 SHA-256 BlobID；对应正文按 `blobs[hex(BlobID)] = base64(message JSON)` 保存。把内联 JSON bytes 直接写入 field 1 虽可能被导入和显示，但实际下一轮会被 Agent 后端拒绝为 `BlobID must be 32 bytes`。
- 可继续的 Agent 历史必须以 Cursor 可识别的 system-prompt root 开头。当前原生样本的第一个 blob 是 `role: system,id: system`，`content` 为 text block 数组；工作区 `<user_info>` 是独立的第二个 `role: user` root。只有用户/助手可见消息而没有 system root 时，界面可以显示历史，但下一轮会被后端拒绝为 `Cursor history contains 0 system prompt roots`。
- Cursor CLI 的公开能力用于打开工作区及 CLI Agent 会话，不提供任意 IDE Chat History 会话导入参数；本 Contract 不安装、不登录也不依赖 Cursor Agent CLI。
- Cursor SDK 的本地会话存储属于 SDK Agent 机制，并且创建或继续模型会话需要 Cursor 凭据；它不作为本 Contract 的 IDE 原生会话导入通道。

因此，本 Contract 使用“版本锁定的 Cursor 内置导入命令”完成目标写入，不直接修改 `state.vscdb`、`workspaceStorage`、`cursorDiskKV` 或 `agent-transcripts`。

## Changes

| ID | Product behavior | 方案依据 |
| --- | --- | --- |
| CHG-001 | 本机检测到兼容 Cursor 后，正式桌面界面中的 Cursor 产品和迁移目标可选择；继续复用现有七步向导。预检必须展示源会话、线程 ID、源文件、源与目标规范工作区、Cursor 版本和协议、能力等级、Loss Report，以及“不调用模型、不需要 IDE Hub API Key、不安装 Cursor Agent CLI”。MCP 不进入该流程。 | 实现方案“正式桌面原型落地要求”“目标平台能力矩阵”“私有适配边界”；本轮用户要求 Codex 到 Cursor。 |
| CHG-002 | 源会话属于目录 A 时，Cursor 必须以 A 为当前工作区执行导入。源和目标均经 `realpath` 规范化，路径完全相同，路径存在时文件系统 identity 相同，原生回读的 `workspaceIdentifier` 也对应 A；任一条件不成立均写前停止且不可绕过。 | 实现方案“路径绑定策略”“写入规则”；本轮用户明确要求 A 到 A。 |
| CHG-003 | 适配器复用统一 IR，将 Codex 可见用户和助手消息按原顺序投影为 Cursor Chat JSON v1：先生成 `role=system,id=system` 的 system root，再生成独立 `<user_info>` 用户上下文和原顺序历史；所有 root、turn、`UserMessage` 和 `AssistantMessage` step 均内容寻址，protobuf 引用字段只写 32 字节 SHA-256 BlobID，正文写入导出包 `blobs`。不可无损映射的事件进入执行前可见的 Loss Report，不伪造工具调用、审批、内部 reasoning 或附件语义；BlobID 长度不为 32、system root 数量不为 1、root 不在首位、root history 与源投影不一致，或可见消息缺失/乱序时不得成功。 | 实现方案“统一 IR”“上下文桥接”“Loss Report”“完成标准”；本机 Cursor `3.18.9` 原生会话和导入器的 Chat JSON v1/protobuf/blob 协议。 |
| CHG-004 | IDE Hub 让 Cursor 在 A 中执行内置导入命令，不直接修改 `state.vscdb`、KV、工作区索引或 transcript。写后从 Cursor 原生会话索引和主体回读目标 ID、标题、工作区及可见消息，并验证 Chat History 可见、Cursor 可打开；全部通过后任务才能进入 `completed`。 | 实现方案“目标 Writer”“真实迁移成功标准”“能力 D 边界”；本机 Cursor `3.18.9` 内置导入命令。 |
| CHG-005 | 扫描、读取、规范化、载荷生成、Cursor 本地导入和回读均不调用模型、不联网、不索取 IDE Hub 模型 API Key，也不安装或登录 Cursor Agent CLI。迁移后用户主动发下一条消息时只使用 Cursor 现有账号。迁移前后 Codex 源快照、Codex MCP 配置和 Cursor MCP 配置哈希必须不变。 | 实现方案“是否需要联网和 API Key”“产品底线”“MCP 独立性”。 |
| CHG-006 | 仅当 Cursor 为 `3.18.9`、Bundle ID 为 `com.todesktop.230313mzl4w4u92`、workbench SHA-256 为 `519a4800d3a3f6f7ab228681a202ef26cfe07ef991dd460aa82ca8145ecbb4eb`、内置导入命令可调用且接受 Chat JSON `version: 1` 时启用写入。任一指纹或协议不符均写前关闭能力，不得以 Markdown、剪贴板、CLI Agent 或数据库直写降级后宣称成功。 | 实现方案“版本变化策略”“能力 D 启用条件”；2026-09-03 本机只读研究。 |
| CHG-007 | 每次迁移使用稳定源指纹和迁移 ID；幂等 key 必须包含 Cursor 投影协议版本和 bridge 版本。只有相同源快照、目标工作区、适配器及协议版本才可复用同一目标会话；协议升级后不得复用旧格式会话。写前验证载荷可解码且引用完整；若目标已创建但回读失败，只删除本次目标会话并恢复写前状态。无法证明精确回滚时不得对真实 Cursor 配置启用写入。 | 实现方案“状态机”“失败补偿”“幂等策略”“验收标准”。 |

## Out of scope

- Cursor 到 Codex 的反向迁移。
- Cursor `3.18.9` 之外版本的写入支持。
- 把 Cursor CLI Agent 或 Cursor SDK 会话当作 Cursor IDE Chat History。
- 安装、登录或配置 Cursor Agent CLI。
- 迁移 Codex 工具调用、审批记录、内部 reasoning、终端状态和不可移植附件的完整执行语义。
- 会话 ZIP 导入导出。
- MCP 配置迁移或修改。
- Codex 之外的源产品。
- Web 服务、云端中转或 IDE Hub 模型调用。

## Constraints

- 仅迁移非活跃 Codex 会话；活跃会话先要求用户结束当前 turn 或创建稳定快照。
- 源会话始终只读，迁移语义为复制加分叉，不移动、不删除源会话。
- 目标工作区固定为源工作区，不提供目标路径覆盖。
- Cursor 写入必须由 Cursor 自身的导入器完成；IDE Hub 只能生成导入载荷、触发命令和只读验证。
- 原生回读、历史列表可见和真实下一轮连续性缺一不可。
- 临时导入载荷在任务成功或回滚后清理；审计记录只保存哈希、计数、路径、版本和结果，不保存用户完整对话副本。
- 桌面渲染层只通过 Electron IPC 调用迁移核心，不在渲染进程直接访问 Cursor 或 Codex 存储。
- 不把 MCP 操作、ZIP 操作或其他目标适配器扩入本 Contract。

## Acceptance

| ID | Given | When | Then | Required evidence | 方案依据 |
| --- | --- | --- | --- | --- | --- |
| AC-001 | 本机安装了指纹匹配的 Cursor `3.18.9`，IDE Hub 已扫描真实 Codex 会话。 | 用户在正式桌面 UI 中选择 Cursor。 | 七步向导的预检展示源工作区、目标工作区、Cursor 指纹、协议版本、Loss Report 和“本地迁移不调用模型”，且没有 MCP 操作。 | UI 截图；检测结果；迁移计划 JSON。 | CHG-001、CHG-005、CHG-006；实现方案正式桌面原型和预检要求。 |
| AC-002 | `/Users/domino/develop/IdeaProjects/temp` 下存在可迁移的真实 Codex 会话。 | Cursor 打开同一目录时执行迁移，并以其他目录重复预检。 | 同目录迁移的原生 `workspaceIdentifier` 对应相同规范路径；其他目录在写入前失败。 | 源快照；源/目标 `realpath` 与文件系统 identity；成功任务记录；错误目录预检失败记录。 | CHG-002；用户 A 到 A 要求；实现方案路径绑定策略。 |
| AC-003 | 源会话包含多轮可见用户和助手消息。 | IDE Hub 完成 Cursor 导入和原生回读。 | 会话出现在 Cursor Chat History 中并可由 Cursor 打开；`systemPromptRootCount=1`、`systemPromptRootFirst=true`、`rootHistoryValid=true`，且回读消息的角色、数量和顺序与源投影一致。 | Cursor Chat History 截图；目标会话 ID；原生回读摘要；root 数量/顺序；逐条消息哈希对比。 | CHG-003、CHG-004；实现方案真实迁移成功标准。 |
| AC-004 | 源会话历史包含只靠上文才能回答的项目定位、spec 定义和任务链信息，且迁移会话已经可以在 Cursor 中打开。 | 在导入会话中发送不包含答案的连续性问题。 | Cursor 正确给出项目名、spec 定位及两条任务链，新增 User/Assistant 问答在同一会话持久化为下一 turn。 | 下一条用户消息；Cursor 实际回复；request ID；新增 turn 原生回读。 | CHG-004；实现方案真实下一轮连续性 Gate。 |
| AC-005 | IDE Hub 开始迁移，Cursor 已有用户自己的登录状态。 | 执行扫描、载荷生成、导入和回读。 | 迁移阶段没有模型调用、外部网络请求、IDE Hub API Key 输入、Cursor Agent CLI 安装或登录；手工继续聊天仅使用 Cursor 现有账号。 | 网络观察记录；进程执行记录；UI 录屏或操作日志；模型调用边界说明。 | CHG-005；实现方案本地离线和账号边界。 |
| AC-006 | 已记录 Codex 源快照及两端 MCP 配置的迁移前哈希。 | 完成一次成功迁移。 | Codex 源快照、Codex MCP 配置和 Cursor MCP 配置哈希均不变。 | 三组迁移前后 SHA-256 对比。 | CHG-005；实现方案源只读和 MCP 独立性。 |
| AC-007 | 已成功迁移一个源快照，并准备目标创建后的验证失败注入点。 | 重复同一迁移并执行一次故障注入迁移。 | 重复执行不新增第二个会话；故障只回滚本次目标会话，既有 Cursor 会话保持不变。 | 两次执行的迁移 ID、目标会话 ID 和会话总数；故障注入记录；回滚前后目标会话清单。 | CHG-007；实现方案幂等、失败补偿和回滚验收。 |
| AC-008 | 分别提供版本、workbench 指纹、导入命令和 Chat JSON 协议不兼容的 fixture。 | 对每个 fixture 执行预检。 | Cursor 写入能力在创建目标会话前关闭，目标会话计数不变，任务不报告迁移成功。 | 四类 fixture 测试结果；目标会话计数；任务错误码。 | CHG-006；实现方案未知版本关闭写入。 |
| AC-009 | 隔离 Cursor 用户数据目录已准备，真实 Cursor 配置未被写入。 | 先完成 fixture 往返、sentinel 和回滚测试，再迁移 3 个不同真实 Codex 会话。 | 隔离测试全部通过，且 3 个真实会话均通过原生回读、历史列表和打开验证。 | 自动化测试报告；3 条真实迁移审计记录；3 组 Cursor 历史列表和会话打开证据。 | CHG-004、CHG-006、CHG-007；实现方案适配器测试矩阵和真实回归要求。 |

## Traceability

| Change | Acceptance coverage | Source anchor |
|---|---|---|
| CHG-001 | AC-001 | 实现方案正式桌面原型落地要求；本轮用户指令。 |
| CHG-002 | AC-002 | 实现方案路径绑定策略；本轮用户 A 到 A 要求。 |
| CHG-003 | AC-003、AC-004 | 实现方案统一 IR、Loss Report、真实连续性标准。 |
| CHG-004 | AC-003、AC-004、AC-009 | 实现方案目标 Writer、原生回读和真实回归 Gate。 |
| CHG-005 | AC-001、AC-005、AC-006 | 实现方案离线边界、源只读、MCP 独立性。 |
| CHG-006 | AC-001、AC-008、AC-009 | 实现方案版本指纹和未知版本写入关闭策略。 |
| CHG-007 | AC-007、AC-009 | 实现方案状态机、幂等和失败回滚。 |

## Open decisions

- None.

## 2026-09-04 implementation evidence

- 第一处根因：首版迁移仅生成可见 user/assistant 历史，没有 Cursor Agent 后端要求的 leading system-prompt root；旧 session `fb042951-6cd0-456f-9a36-4ee9cefe66e5` 只能查看，实际续聊报 `Cursor history contains 0 system prompt roots`。
- 第二处根因：v2 修复错误地把内联 JSON bytes 直接写入 `root_prompt_messages_json` field 1；session `b54ba6c6-e51c-4d4b-84cd-9c71aaf3e314` 的首项长度为 378，实际续聊报 `BlobID must be 32 bytes, got 378`。能导入、显示和本地回读不代表 Agent 后端能接受。
- 最终修复协议：`cursor-chat-json-v1-blob-roots-v3`。field 1 只写 32 字节 SHA-256 digest；`blobs[hexDigest]` 保存消息 JSON；第一个消息为 `role=system,id=system`，第二个为独立 `<user_info>` 用户上下文。写前和原生回读同时校验 BlobID 长度、system root 数量/首位和完整历史。
- 协议隔离：mapping schema 为 `ide-hub-cursor-mapping-v2`，幂等 key 包含投影协议和 bridge 版本，不会复用上述两个损坏会话。
- 真实新迁移：migration `09cc222e-ffd3-469c-9573-b594b526608e` → session `c5bf5d0a-1ec4-4d95-a2a8-28530ea21c96`，workspace 为 `/Users/domino/develop/IdeaProjects/temp`；导入后 4 个 root field 均为 32 字节，`systemPromptRootCount=1`、`systemPromptRootFirst=true`、`rootHistoryValid=true`、1 轮 2 条可见消息。
- 真实连续性 Gate：在上述同一 session 发送不包含答案的历史追问，request `1dc3264d-af2d-4219-bd8b-be053f43c49a` 成功；Cursor 回答 `Anneal | 可冻结、可验证的 Product Contract（而非大而全的 PRD 或实现步骤） | Direct | Full Assurance`，回答 SHA-256 为 `158e6b32624ded028ad1b1be61586ff7e1b629e554bd932c0f4c1cb53816e87a`。原生回读为 2 turns，续聊后 7 个 root field 仍全部为 32 字节；Cursor 日志记录 `agent.turn.outcome=success`。
- 续聊后幂等 Gate：migration `99fac385-c652-430e-89c9-5b4bd0a90bca` 命中 `TARGET_REUSED`，仍返回 session `c5bf5d0a-1ec4-4d95-a2a8-28530ea21c96`；验证采用“源迁移历史必须是目标历史前缀”，保留用户已新增的第 2 turn，会话数不增加。
- 自动验证：新增“field 1 必须为 32 字节”“内联 JSON 必须拒绝”和“续聊后重复迁移保留新增 turn”的回归用例；36 项测试、TypeScript 检查、生产构建和 macOS arm64 桌面打包全部通过。
- 未完成项不属于连续性：当前 Cursor `3.18.9` 未暴露精确 delete-by-id 原生命令，AC-007 的失败回滚 Gate 仍保持未通过，不以数据库直写冒充完成。

## Sources and evidence

| Source | Revision or date | Confirmed use in this Contract |
|---|---|---|
| [IDE Hub 实现方案](../ide-hub-implementation-plan.md) | SHA-256 `d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb` | 产品边界、统一 IR、同工作区、版本锁、回读、连续性、幂等、回滚、离线和 MCP 独立性。 |
| 本轮用户指令 | 2026-09-03 | Codex 到 Cursor；源目录 A 必须保持为目标目录 A。 |
| `/Applications/Cursor.app` | Cursor `3.18.9`；Bundle ID `com.todesktop.230313mzl4w4u92` | 当前目标版本和应用身份。 |
| `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js` | SHA-256 `519a4800d3a3f6f7ab228681a202ef26cfe07ef991dd460aa82ca8145ecbb4eb` | `developer.importChat`、`developer.bulkImportChats`、Chat JSON v1、工作区绑定和 protobuf/blob 导入机制。 |
| `~/Library/Application Support/Cursor/User/workspaceStorage` 与 `globalStorage/state.vscdb` | 2026-09-03 只读检查 | 工作区映射、原生会话索引和分片主体的当前本地结构；不作为直接写入接口。 |
| `~/.cursor/projects` | 2026-09-03 只读检查 | transcript 文件不能单独构成 IDE 原生 Chat History 会话。 |
| [Cursor CLI Overview](https://cursor.com/docs/cli/overview) | 2026-09-03 访问 | 排除安装 Cursor Agent CLI 作为 IDE 原生导入前提。 |
| [Cursor SDK for Python](https://cursor.com/docs/sdk/python) | 2026-09-03 访问 | 区分 SDK Agent 会话与本 Contract 的 IDE Chat History 目标。 |
| [Cursor Deeplinks](https://cursor.com/docs/reference/deeplinks) | 2026-09-03 访问 | Deeplink 只覆盖提示词、命令和规则，不作为自动原生会话导入通道。 |
