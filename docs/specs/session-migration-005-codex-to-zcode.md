---
contract_id: SESSION-MIG-005
version: 1
status: ready
route: direct
source_revision: ide-hub-8943d57-plan-d1446a27-zcode-3.10.2-cli-0.16.5
---

# Codex 会话迁移到 ZCode Product Contract

## Source baseline

- 产品基线：[IDE Hub 实现方案](../ide-hub-implementation-plan.md)，SHA-256 `d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb`；本仓库研究起点为 commit `8943d5701714bc82dd92031b275216ff679eb784`。
- 本轮用户要求：研究 ZCode 会话原理，支持 Codex → ZCode；Codex 会话属于目录 A，迁移后也必须是 ZCode 在目录 A 下的会话。
- 延续用户已明确的交付要求：在 IDE 内找到并打开历史，在同一会话继续上下文；把 Markdown 放进输入框不算完成；由实现方实际验证下一轮，不能把未验证结果交给用户测试。正式桌面渲染层使用 `prototype/`，会话与全局 MCP 操作独立。
- 本文只定型 Codex → ZCode 这一交付切片；ZIP、反向迁移及独立 MCP 等总方案需求仍保留在原方案，不因此删除或视为完成。
- 原方案 §4.1、§8.3、§14 中 ZCode“未安装、仅 C 级交接”的研究状态由本轮本机证据更新。原生续聊目标以用户上述要求为准；原方案的源端只读、离线迁移、版本适配、可预览和精确回滚等约束继续适用。原方案不修改。

## Objective

在 IDE Hub 本地桌面应用中，将一个已停止执行的 Codex 会话复制成 ZCode 可打开、可继续的原生会话，源、目标工作区规范化后都是 A，源会话保留。

最短闭环：`扫描真实 Codex 会话 → 选择 ZCode → 检查版本与同目录 → 预览历史和损失 → 原生导入 → 登记桌面任务 → 打开 ZCode 的 A 项目 → 同一会话实际继续下一轮`。

`ready` 表示产品要求与开发入口已明确，允许开始实现；不表示 ZCode 迁移、桌面展示或真实续聊已经通过验收。

## Background

### 本机存储与上下文原理

2026-09-09 只读检查确认：

| 层 | 本机证据 | 与迁移的关系 |
| --- | --- | --- |
| 桌面应用 | `/Applications/ZCode.app`，`CFBundleShortVersionString=3.10.2`，bundle ID `dev.zcode.app` | 用户操作的正式目标应用 |
| 内置后端 | `Contents/Resources/glm/zcode.cjs`，内置 CLI 版本常量 `0.16.5`；桌面启动参数包含 `app-server --stdio` | 使用安装包内运行时，无需用户另装 CLI 或在终端登录 |
| 会话正文 | `~/.zcode/cli/db/db.sqlite` 的 `session`、`message`、`part` | `session.directory/path` 保存工作目录；`part` 保存正文；不能只写 `message.data.content` |
| 桌面列表 | `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` | 按 `workspace_key`、`task_id` 识别任务，列表使用 `provider=glm`；仅有后端会话不等于桌面可见 |
| 工作区 | 后端 `buildWorkspaceRef` 与桌面 `getWorkspaceKey` | 本地普通项目用绝对目录作为 `workspacePath/workspaceKey`；`workspaceIdentity` 是目标协议字符串，不是 IDE Hub 的设备号/inode 对象 |
| 恢复上下文 | `session/resume` → `sessionStore.messages` → `app.resume` | 从持久化的消息与 parts 恢复；历史列表和下一轮均需验证，不能用一张任务卡替代上下文 |

数据库只读探测使用 Node `DatabaseSync({readOnly:true})`。本机会话库已应用 `0001`～`0018` migrations，存在 `message.sequence`、`part.sequence` 和自动填充序号的 triggers；当前 `session` 与桌面 `tasks` 均无记录，尚无真实 ZCode 历史样本。

### 当前版本存在原生历史导入入口

在内置 `zcode.cjs` 中定位到 `session/create` 的 `importedHistory` schema 和 handler：

```ts
// 当前版本的协议形状示意；不是 IDE Hub 新增 API。
{
  sessionId: "sess_idehub_example", // 实现时生成本次迁移独占的稳定 ID
  workspace: { workspacePath: A, workspaceKey: A },
  persistence: "immediate",
  titleGenerationEnabled: false,
  importedHistory: {
    source: "claudeCode", // 当前协议唯一允许的字面量，详见下文
    title: "Codex · 源会话标题",
    createdAt: 0, // 实现时填真实 epoch milliseconds
    updatedAt: 0,
    messages: [{ role: "user", content: "原文", timestamp: 0 }]
  }
}
```

- `importedHistory.messages` 至少一条，仅接受 `user/assistant`、字符串 `content` 和可选毫秒时间戳。参数对象是 strict schema，不能额外塞入 Codex 私有字段。
- 后端自行 `createSession`、`saveMessage`、`savePart`，保存目录、生成稳定消息 ID、设置已完成 assistant 的 `finish=stop` 并关联最近 user，随后执行 `app.resume()`。连续或相同时间戳被调整为严格递增顺序。无需 IDE Hub 生成目标 system prompt、工具结果或消息表 JSON。
- **兼容限制必须显式保留**：该接口的 `source` 仅接受 `claudeCode`，传 `codex` 会被 schema 拒绝。使用这个入口属于当前版本的兼容投影，不宣称 ZCode 官方支持 Codex 导入。wire 中保留其必需字面量；IDE Hub 来源、任务标题、迁移记录始终标明 Codex，保存 `sourceThreadId` 和源 hash。兼容字段不能成为产品来源判定依据，预览中说明这个限制。
- 再次用同一 ID 调用导入会按迁移标记移除旧导入消息后重写。因此已经续聊的会话只能先回读并复用，不允许通过再次 `session/create(importedHistory)` 实现幂等。
- 桌面 host 的现有 Claude 导入链为 `createSession(importedHistory) → syncTaskIndexSnapshot → syncTaskIndexMeta`，证明消息创建与任务登记是两个步骤。它的 `importClaudeSessions` 从 Claude 本地数据读入，不是通用外部载荷入口；本任务不往用户 `.claude` 目录制造中间会话。
- 安装包还带 `restore-legacy-sessions` 官方脚本，但其写死 `version=0.14.5`、使用旧 project ID 算法，并分别提交两库；不选为本轮 writer。它只作为 `provider=glm` 和两库关联的旁证。

对安装包中实际 `persistImportedSessionHistory` 函数（压缩符号 `UDi`）做了提取后的纯内存探针：24 条合成 User/Assistant 消息，验证 24 个消息与 24 个文本 part、原顺序正文、父子关联、相同时间戳调整、`directory/path=A`。依赖的存储和模型引用解析使用桩；没有运行完整 app-server、写真实数据库或调用模型。该探针不能证明 RPC 启动、完整原生校验、桌面可见或续聊成功。

### 开发落点与尚待实测的技术项

- 复用 `src/codex/reader.ts`、`src/seed-context.ts` 中的可见消息抽取、`src/workspace.ts`、`src/artifacts.ts` 与现有迁移编排。ZCode 接受逐条 User/Assistant，直接按源顺序投影；不因复用 Qoder 专用组轮函数而默认合并连续 Assistant。新增目标适配接入 `src/migration.ts`、types/request/schema、`desktop/main.cjs`、`prototype/app.js` 的现有流程。
- 正文 writer 使用内置 app-server 的上述导入入口；桌面登记优先使用可调用的现有 host 任务服务。若宿主服务没有可用外部入口，沿用原方案允许的精确索引适配，仅对本次目标 ID 插入 `tasks` 元数据，核心消息库由 ZCode 自己写。必须锁定版本、备份、回读和精确清理；不替换整个任务索引。
- 桌面索引普通本地路径需满足 `workspace_key=workspace_path=A`、`task_id=目标 Session ID`、`provider=glm`、`deleted=0`、`archived=0`。`migration_source` 不盲写 `codex` 或 `claudeCode` 来触发未知桌面分支；真实 lineage 放在 IDE Hub 记录，标题标识 Codex。字段取值以目标回读为依据，不能凭空构造模型 ID 或复用 Codex 模型配置。
- 开发首个探针必须在隔离目标数据中核实 app-server 启动、原生 create/resume、模型配置依赖、宿主任务登记和退出/打开行为，然后再对真实测试目录执行。不能把“未调用 send”推断为完全离线：初始化可能加载 MCP、插件、遥测或模型目录，需要实际证明离线创建。当前代码 `protocolMcpServersToRuntimeMcpConfig([])` 返回 `undefined`，所以 `mcpServers: []` 本身不能证明禁止加载已有 MCP。不得为通过迁移修改用户全局配置。
- 完整 runtime 启动参数、无需读取凭据的离线配置方式、宿主可调用接口以及直接定位目标任务的打开入口尚待开发实测。未验证前不得宣布这些能力可用；若只能打开项目，应给出准确标题和 Session ID 并实际演示找到该会话，不能虚报“一键打开指定会话”。

## Changes

| ID | Product behavior | 方案依据 |
| --- | --- | --- |
| CHG-001 | 正式 Electron 界面发现 ZCode 安装及兼容状态，真实 Codex 会话可选择 ZCode 为目标，复用现有向导、历史预览、Loss Report、执行结果和打开入口。未知版本或缺少必需能力时给出具体原因，不写目标。 | 总方案 §8.2、§11；用户已确认 prototype 落地；本轮 ZCode 目标要求 |
| CHG-002 | 将源 cwd 规范化为 A，并使 ZCode session 的 directory/path、Workspace 和桌面任务均指向 A；不自动上移 Git 根、不创建 worktree、不允许改成 B。源目录不存在或不是目录时写入前停止；符号链接按同一目录身份处理。 | 本轮用户明确 A → A；总方案 §7 工作区流程；现有 `src/workspace.ts` 语义 |
| CHG-003 | 创建独立 ZCode 原生 Session，按源顺序保留可见 User/Assistant 正文与角色；目标标题标明 Codex，来源关系可回查。不支持的工具执行状态、隐藏推理、附件等列入 Loss Report，不伪造待执行工具或把全文塞成一条 user。协议兼容标签与真实来源分开记录。 | 用户已明确原生历史和续聊要求；总方案 §1、§6.2～§6.5、§7.4、§18 |
| CHG-004 | 导入后在 ZCode 的 A 项目任务列表中可找到并打开该会话，显示原顺序历史；关闭后重新打开仍能读取。实现方在同一 Session 实际发出依赖旧上下文的问题并核实正确回复及新增消息持久化，才完成发布验收。 | 用户已明确 IDE 使用和实现方续聊验证；总方案 §13.2、§13.4、§18 |
| CHG-005 | 扫描、投影、写入、索引登记和回读离线执行，不触发模型请求，不要求 IDE Hub API Key。会话流程不迁移或修改 MCP、模型凭据；目标端主动续聊使用 ZCode 已有模型设置。 | 总方案 §1、§2.3、§9.1、§10；用户确认本地应用及 MCP 独立 |
| CHG-006 | 源只读；同一源快照、目标工作区与适配版本重复执行复用已验证的目标，保留目标后续聊天。部分失败不报告成功，能按本次目标 ID 精确清理或恢复；不能覆盖用户已有会话或整库回滚。 | 总方案 §1、§7.1、§12、§13.2、§18 |

## Out of scope

- 本轮不实现 ZCode → Codex、ZCode 源会话扫描、跨电脑 ZIP 或 ZCode MCP 迁移；这些总方案能力保持原有待实现范围。
- 不复制账号、隐藏推理、运行进程、待审批状态或源模型的内部请求结构，不提供实时双向同步。
- 不增加方案之外的范围，不改 ZCode 安装包，不把当前兼容投影视为跨版本稳定公开协议。

## Constraints

- IDE Hub 保持现有 Electron 本地桌面形态，正式渲染层基于 `prototype/`；保留其他尚未实现页面及其状态。
- 本轮写入兼容基线为 macOS ZCode `3.10.2` / 内置 CLI `0.16.5`；使用本机已验证包及协议、schema 指纹。其他版本先只读识别，依照总方案 §8.2 验证后再开放写入。
- 核心正文通过目标原生接口创建；私有索引仅允许最小、可回读和可精确回滚的元数据适配。备份须覆盖 SQLite WAL 中已提交内容；两库写入不能假装具有一个原子事务。
- 离线迁移与续聊实测是两个阶段：前者不得调用模型，后者由实现方使用目标已有配置实际执行。无模型配置时如实保留续聊未验证状态，不把缺少模型当作历史转换必须配置 IDE Hub API Key 的理由。

## Acceptance

| ID | Given | When | Then | Required evidence | 方案依据 |
| --- | --- | --- | --- | --- | --- |
| AC-001 | 安装兼容 ZCode，IDE Hub 已扫描到真实 Codex 会话。 | 在正式桌面界面选择 ZCode 并预览。 | 展示实际版本、固定工作区、历史与损失、来源兼容说明；未知版本不开放写入；预览不创建目标。 | 正式 UI 演示与预览结果；不支持版本的无写入验证。 | CHG-001、CHG-003；总方案 §8.2、§11 |
| AC-002 | 源会话 cwd 是 `/Users/domino/develop/IdeaProjects/temp` 或其符号链接。 | 执行迁移并在 ZCode 打开。 | 原生回读 directory/path、协议 Workspace、桌面任务路径规范化后都等于该目录；B 目录和失效目录在写入前失败。 | 同一 source/target ID 的路径回读，目录身份断言与失败路径测试。 | CHG-002；本轮 A → A 要求 |
| AC-003 | 已完成源会话含普通问答、连续 Assistant、同时间戳、超过默认历史窗口的消息以及不可移植项。 | 原生创建、关闭、重新 resume 并读取全部消息。 | 可见正文、角色、数量和顺序与源可见消息投影一致，无窗口截断；模型历史可恢复；Loss Report 列明未迁移项。只有 SQL 行或部分 snapshot 不算通过。 | 完整原生消息回读与源对照，重开结果，Loss Report；覆盖首尾及超过默认窗口的历史。 | CHG-003、CHG-004；总方案 §6、§7.4、§13 |
| AC-004 | 后端历史已创建。 | 在 ZCode 的 A 项目任务列表找到并打开目标，再关闭重开。 | 标题、目标 Session ID、Workspace 和全部迁移历史一致，输入区可继续；不能只有 CLI 可见或出现空白任务。 | ZCode 实际桌面截图/演示、tasks 索引与同 ID 原生回读。 | CHG-001、CHG-002、CHG-004；用户 IDE 使用要求 |
| AC-005 | 已关闭并恢复的目标会话包含可核对的目标、约束、已否决方案和未完成项。 | 实现方在 ZCode UI 内发送不含答案的上下文问题，再要求继续明确的下一步。 | 回复准确引用迁移历史并承接下一步；新增问答持久化于同一 Session，旧历史仍为前缀。 | 源事实、实际问题/回复、同一 target ID 的新增消息回读与 UI 证据；不能只用桩或文本生成测试替代。 | CHG-004；用户连续性 Gate 要求；总方案 §13.2、§13.4 |
| AC-006 | 对迁移进程启用可观察的外网阻断，保存源与两端 MCP 的迁移前基线。 | 执行创建、索引登记和回读。 | 离线迁移成功，无模型调用和外网依赖；源正文与 MCP 内容不变；不要求 IDE Hub Key，不执行 MCP 配置迁移。 | 阻断条件下的迁移结果、请求/进程证据、前后内容指纹；与续聊阶段分开记录。 | CHG-005、CHG-006；总方案 §2.3、§7.1、§9.1、§10、§13.2 |
| AC-007 | 目标已迁移并新增真实聊天，或创建/索引登记中断。 | 重复执行相同快照；另对中断任务恢复或精确回滚。 | 复跑复用同一目标并保留新增聊天，不再调用重写历史的导入；中断不虚报成功，清理仅限本次目标，其他任务与 MCP 不变。 | 同 ID 与消息前缀/后缀回读、调用记录；正文成功而索引失败的恢复/清理测试与其他任务对照。 | CHG-006；总方案 §12、§13.2、§13.4 |

## Traceability

| Change | Acceptance |
| --- | --- |
| CHG-001 | AC-001、AC-004 |
| CHG-002 | AC-002、AC-004 |
| CHG-003 | AC-001、AC-003 |
| CHG-004 | AC-003、AC-004、AC-005 |
| CHG-005 | AC-006 |
| CHG-006 | AC-006、AC-007 |

## Open decisions

- None.

## Sources and evidence

| Source | Revision or date | Confirmed facts used |
| --- | --- | --- |
| [总方案](../ide-hub-implementation-plan.md) 与本轮/既有明确用户修正 | 文件 hash 见 Source baseline；研究日期 2026-09-09 | 本地桌面、A → A、原生历史、真实续聊、源只读、MCP 独立、失败清理与版本策略 |
| [ZCode Agent 官方文档](https://zcode.z.ai/cn/docs/agents) | 2026-09-09 访问；在线资料不等于本机版本合同 | 内部会话分叉继承历史，仍操作同一工作区；不证明任意外部会话导入 |
| `/Applications/ZCode.app/Contents/Info.plist` 与 `app.asar/package.json` | 桌面 `3.10.2`，`dev.zcode.app` | 当前安装基线 |
| `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` | SHA-256 `3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc`；版本常量 `0.16.5` | 搜索锚点 `session/create`、`importedHistory`、`Ebn`、`UDi`、`mMe`、`kbt`、`protocolMcpServersToRuntimeMcpConfig`；原生导入、限定 source、重写风险、恢复与 MCP 空数组行为 |
| `app.asar/out/host/index.js` | SHA-256 `72e57751ed5563338335a52cd688c7fba0707ef72d8ce782356b1f0b39c77462` | `buildSessionCreateParams`、`importClaudeSessions`、`syncTaskIndexSnapshot`、`syncTaskIndexMeta`、`getWorkspaceKey`；正文与桌面任务分别登记，provider 筛选 |
| `app.asar/out/preload/index.cjs` | SHA-256 `42d2f1977d700ac09eab1ece16159ff05403a1d9a5256afecd3400245e1f2afd` | 桌面同版本协议包含 `importedHistory` schema；不等于任意外部进程可调用所有宿主方法 |
| 安装包 `glm/packages/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/scripts/restore-conversation.mjs` | 当前 `3.10.2` 安装包 | 旧恢复写入两库、文本 parts、provider 以及两个独立 COMMIT；不作为本轮 writer |
| 本机 `~/.zcode/cli/db/db.sqlite`、`~/.zcode/v2/tasks-index.sqlite` 只读查询 | 2026-09-09；已应用 `0018`，session/tasks 均为零 | 当前 schema、sequence triggers 与缺少真实目标会话样本 |
| 安装包导入函数的纯内存探针 | 2026-09-09；24 条合成消息，无真实 DB 写入 | 顺序、正文、父子关联与目录赋值通过；完整原生运行、桌面展示和续聊未验证 |
| [现有源读取](../../src/codex/reader.ts)、[可见消息抽取](../../src/seed-context.ts)、[工作区检查](../../src/workspace.ts)、[迁移入口](../../src/migration.ts)、[桌面渲染层](../../prototype/app.js) | commit `8943d57` | 可复用的实现与验收入口；ZCode 适配尚未实现 |

无 spec 外新增产品建议。完整 RPC、离线初始化、桌面打开及真实续聊为本文明确的开发验证项，不把只读研究结果标记为迁移已完成。
