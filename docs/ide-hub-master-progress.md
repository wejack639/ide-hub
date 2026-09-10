# IDE Hub 任务进度总控

> 文档角色：项目唯一进度真相源（Single Source of Truth）<br>
> 最后更新：2026-09-10<br>
> 当前阶段：Phase 0 多目标会话 Gate 收尾 + 桌面 MVP 适配扩展<br>
> 当前结论：正式本地 `IDE Hub.app` 已接入 Codex → Qoder 国际版 / Qoder CN / Cursor / DeepSeek Harness / ZCode 五个目标，但不代表全部连续性 Gate 通过。ZCode `3.10.2` 已完成离线原生迁移、重启后桌面打开、一轮真实上下文回复和续聊后幂等（13 条完整保留）；模型阻塞已解除，第二轮下一步验证因桌面控制 `cgWindowNotFound` 暂未完成。迁移本身不调用模型、不迁移或修改 MCP。

## 1. 使用规则

1. 所有开发任务、Gate、阻塞项和验收证据统一维护在本文档中。
2. 方案文档描述“怎么做”，本文档只回答“做到哪、下一步是什么、凭什么算完成”。
3. 原型、空目录、占位接口、Schema 文件存在、测试桩或输出 `DONE`，都不等于功能完成。
4. 任务只有在验收条件全部满足并填写证据后，才能标记为 `DONE`。
5. 会话迁移和 MCP 配置迁移是两条独立任务线，不建立隐式前后依赖。
6. 每完成一个任务，同步更新任务状态、证据、总览和变更记录。

状态定义：

| 状态 | 含义 |
|---|---|
| `TODO` | 尚未开始 |
| `IN_PROGRESS` | 正在实施，必须有当前负责人和下一动作 |
| `WAITING` | 等待前置任务完成，不是外部阻塞 |
| `BLOCKED` | 存在无法在当前范围内解决的外部阻塞，必须记录解除条件 |
| `DONE` | 验收通过且证据已记录 |
| `DROPPED` | 经决策明确移出范围，必须记录原因 |

## 2. 当前总览

### 2.1 真实完成度

| 维度 | 状态 | 说明 |
|---|---|---|
| 需求边界 | `DONE` | 本地桌面应用；离线；不调用模型；会话与 MCP 分离 |
| 实现方案 | `DONE` | 已覆盖架构、Adapter、会话 ZIP、全局 MCP、Gate 与测试策略 |
| 正式渲染层 | `DONE` | Electron 直接加载 `prototype/`；整体布局、导航、会话/ZIP/MCP/任务入口全部保留，演示会话已替换为真实 Codex 扫描 |
| 首条迁移 Spec | `DONE` | Codex → Qoder 国际版；源/目标强制属于同一 canonical workspace |
| Qoder CN 迁移 Spec | `DONE` | 与国际版共用轮次投影，独立 bundle、runtime、socket 和 client identity |
| Cursor 迁移 Spec | `DONE` | Codex → Cursor `3.18.9`；版本/Workbench 指纹锁定，A → canonical(A) |
| DeepSeek Harness 迁移 Spec | `DONE` | Codex → DSH `0.1.0-rc.6`；版本/包指纹/bridge 协议锁定，A → canonical(A) |
| ZCode 迁移 Spec | `DONE` | SESSION-MIG-005；ZCode 3.10.2 / CLI 0.16.5；原生 importedHistory 与同目录桌面任务 |
| ZCode 迁移实现 / 发布 Gate | `BLOCKED` | AC-004 重启打开、AC-007 真实续聊后复跑通过；AC-005 第一轮旧事实验证通过，第二轮下一步因桌面控制无法捕捉窗口待补验，不是模型不可用 |
| Phase 0 本地验证 | `IN_PROGRESS` | TypeScript 测试入口、请求/结果 Schema、Codex reader、原生轮次投影、journal 和测试已落地；CLI 仅为开发测试入口，不是用户入口 |
| 本地桌面应用 | `DONE` | Electron 44.1.1 本地 `.app`；IDE Hub 自身无 HTTP 服务；正式原型层可扫描 DSH 并启用一次性本地 bridge |
| 真实 IDE 迁移 | `IN_PROGRESS` | 国际版实际下一轮通过；CN 下一轮被账号状态 `112` 阻断；Cursor 与 DSH 原生历史、同工作区、打开、幂等和实际下一轮通过，Cursor 精确回滚待完成 |
| 跨电脑 ZIP 恢复 | `TODO` | 尚未生成或导入真实 Bundle |
| 全局 MCP 配置迁移 | `TODO` | 尚未真实写入或回滚任何目标产品配置 |

当前仓库事实：

- 已有：[实现方案](./ide-hub-implementation-plan.md)。
- 已有：[SESSION-MIG-001：Codex → Qoder 国际版](./specs/session-migration-001-codex-to-qoder-international.md)。
- 已有：[SESSION-MIG-002：Codex → Qoder CN](./specs/session-migration-002-codex-to-qoder-cn.md)。
- 已有：[SESSION-MIG-003：Codex → Cursor](./specs/session-migration-003-codex-to-cursor.md)。
- 已有：[SESSION-MIG-004：Codex → DeepSeek Harness](./specs/session-migration-004-codex-to-deepseek-harness.md)。
- 已有：[SESSION-MIG-005：Codex → ZCode](./specs/session-migration-005-codex-to-zcode.md) 与 [ZCode 验收记录](./verification/session-migration-005-zcode.md)。
- `prototype/` 已从参考原型升级为正式 Electron 渲染层；`desktop/` 下旧的简化 HTML/CSS/JS 已删除。
- 已有 TypeScript 核心、`schemas/`、`src/`、`test/` 和 `desktop/`；已打包 `release/IDE Hub-darwin-arm64/IDE Hub.app`。
- 桌面壳直接调用 TypeScript 迁移核心，不启动 Web 服务；Tauri/Rust 方案已由当前 Electron 实现取代。
- `codex-state/` 是现有独立项目，本阶段不计入 IDE Hub 实现进度。
- 已确认会话与 MCP 完全拆分：会话 ZIP 中不存在 MCP；MCP 配置包中不存在会话。

### 2.2 里程碑状态

| 里程碑 | 状态 | Gate 结果 | 依赖 |
|---|---|---|---|
| M0：产品边界与原型基线 | `DONE` | 会话、会话 ZIP、MCP 已拆分 | 无 |
| M1：Phase 0 本地可行性 Gate | `IN_PROGRESS` | Qoder 国际版、Cursor 和 DSH 连续性通过；断网与 Cursor 精确回滚尚未结束 | M0 |
| M2：Phase 1 桌面 MVP | `IN_PROGRESS` | prototype 布局已正式落地；真实会话列表与 7 步迁移向导完成；ZIP、MCP、任务中心保留入口并标记未实现 | M1 |
| M3：Phase 2 产品矩阵扩展 | `IN_PROGRESS` | DSH 目标发现与正式桌面入口完成；其他 source/target 待实施 | M2 |
| M4：Phase 3 实验原生投影 | `IN_PROGRESS` | DSH rc.6 原生 seed plugin、版本锁和连续性 Gate 已通过；Pi 待实施 | M2 |
| M5：Phase 4 受控同步 | `WAITING` | 可选，尚未进入 | M2/M4 |

### 2.3 当前焦点

当前 B3（SESSION-MIG-005）：Codex 负责 ZCode 同目录原生迁移。2026-09-10 已由实现方重启原生 IDE 并发送第一轮旧上下文问题，模型准确回答 Anneal/commit/选路/Goals 限制；复跑 `bcbe0c92...` 复用同一 Session，13 条记录逐条保留。下一动作是在桌面窗口可捕捉后，由实现方发送第二轮明确下一步并完成最后 UI 取证，不要求用户代测。具体证据见 [ZCode 验收记录](./verification/session-migration-005-zcode.md)。

前序 DSH 结果保留：

> SESSION-MIG-004 已完成 Codex → DSH 最短闭环；源会话 cwd=A 时，目标 SessionHeader.cwd 与 DSH Workspace 均为 canonical(A)，迁移阶段不调用模型、不触碰 MCP，续聊 Gate 与迁移操作分开记录。

DSH 最终会话为 `session-idehub-116368030a2fa5a2a44915824725c5c1`：21 个迁移 turn、42 条源可见消息、126 个 seed 事件；新增第 22 轮正确回答 `Extra High=xhigh`、`Max=max`，续聊后复跑仍复用同一 Session 且保留 381 个事件。开发期三个旧协议会话已通过 DSH 官方归档接口隐藏。下一步继续完成 Cursor 精确回滚、断网 Gate、会话 ZIP 与独立 MCP Gate。

## 3. 不可破坏的产品约束

| 编号 | 约束 | 自动验收要求 |
|---|---|---|
| INV-001 | 核心迁移完全离线 | E2E 阻断网络后仍通过；不调用模型推理接口 |
| INV-002 | 会话迁移不读写用户 MCP 配置 | 会话迁移前后源/目标 MCP 配置 hash 不变 |
| INV-003 | MCP 任务不依赖会话 | MCP task input/schema 中没有 Session/Capsule ID |
| INV-004 | 会话 ZIP 不包含 MCP | ZIP 内无 `mcp/`、MCP Registry 或源 MCP 配置 |
| INV-005 | MCP 配置包不包含会话 | 配置包内无 `sessions/`、Handoff、消息或附件 |
| INV-006 | 源会话只读 | 迁移前后源文件 size、mtime、hash 不变 |
| INV-007 | 私有消息正文禁止直写 | 版本锁定的索引元数据修正必须精确 session、事务化、可回读和可清理；未知版本禁止写入 |
| INV-008 | MCP 按产品迁移一次 | 任务粒度为源产品到目标产品；不得按会话重复写入 |
| INV-009 | 迁移失败可恢复 | 所有目标写入有独立备份、journal 和回滚验收 |
| INV-010 | 真实继续才算会话 Gate 通过 | Capsule 存在或空会话可打开不算完成 |
| INV-011 | 源/目标会话工作区相同 | 目标 cwd 只能由源 thread.cwd 派生；API/UI/CLI 无目标目录覆盖入口 |

## 4. 关键路径

```text
P0-01 工程骨架
  → P0-02 Schema 与领域隔离测试
  → P0-03 合成 fixture
  → P0-04 Adapter SDK / Journal
  → P0-05 Codex 源读取
  → P0-06 Qoder 国际版目标会话
  → P0-06C Cursor 目标会话
  → P0-07 会话 ZIP 跨目录恢复
  → P0-08 Codex → Qoder 国际版会话 Gate

P0-01
  → P0-02
  → P0-09 Codex/Cursor MCP Adapter
  → P0-10 全局 MCP diff/apply/rollback
  → P0-11 Codex → Cursor MCP Gate

P0-07 + P0-08 + P0-11 → M1 Gate 审核 → Phase 1
```

会话 Gate 与 MCP Gate 可以并行实施，但 M1 必须同时通过两条 Gate。

## 5. Phase 0 任务总表

### 5.1 基础设施与 Schema

| ID | 任务 | 状态 | 依赖 | 交付物 | 完成证据 |
|---|---|---|---|---|---|
| P0-01 | 创建最小 TypeScript core + desktop workspace | `DONE` | 无 | `package.json`、TypeScript core、Electron desktop、build/test/package scripts | `check`、24 项测试、`build`、`.app` 打包启动均通过 |
| P0-02 | 定义并隔离五类 Schema | `IN_PROGRESS` | P0-01 | Capsule、Handoff、Session Bundle、MCP Registry、MCP Bundle | 迁移请求/结果 Schema 已有；完整五类与领域负向测试待补 |
| P0-03 | 构造合成 fixture | `IN_PROGRESS` | P0-02 | 最小、普通、大会话、工具调用、中断、dirty workspace fixture | reader/projection/workspace fixture 已有；完整矩阵待补 |
| P0-04 | Adapter SDK 与双任务 Journal | `IN_PROGRESS` | P0-01/P0-02 | `AgentAdapter`、`McpAdapter`、SessionTask、McpTask | 会话 journal 已落地；通用 SDK 与独立 MCP task/journal 待补 |

P0-02 细分验收：

- `session-portable-bundle-v1` 只能引用 Capsule、Handoff、artifact 和 workspace delta。
- `mcp-config-bundle-v1` 只能引用 MCP Registry、源配置和字段映射。
- Session schema 中禁止出现 `mcpMigrationId`、`mcpServers`、目标 MCP 写入计划。
- MCP task schema 中禁止出现 `sessionId`、`hubSessionId`、`migrationId`、conversation 或 Handoff。

### 5.2 会话迁移主线

| ID | 任务 | 状态 | 依赖 | 交付物 | 完成证据 |
|---|---|---|---|---|---|
| P0-05 | Codex 源 Adapter | `DONE` | P0-03/P0-04 | list/read/status/snapshot/normalize；paginated/legacy reader | 24 项测试通过；真实 list 与 paginated dry-run 通过 |
| P0-06 | Qoder 国际版目标 Adapter | `DONE` | P0-03/P0-04 | IDE IPC native-history projection、精确元数据规范化、workspace 打开与逐轮正文验证 | Qoder IDE 1.27.1；同 cwd；原生 User/Assistant 问答可见并可打开；无新模型回复；不依赖 CLI/API Key |
| P0-06B | Qoder CN 目标 Adapter | `DONE` | P0-03/P0-04 | CN bundle/runtime discovery、独立 client identity、原生历史投影和精确失败清理 | Qoder CN IDE 1.27.1；真实 migration `68dfa68f-e7ab-41da-a285-83e9ce122373`；session `c2078118-3586-4e37-9b1e-db3d11607bc6` 在同 cwd 的 Chat History 列表可见 |
| P0-06C | Cursor 目标 Adapter | `DONE` | P0-03/P0-04 | Cursor `3.18.9` 指纹发现、Chat JSON v1/blob 投影、leading system-prompt root、本地扩展桥、原生导入、只读回读与精确打开 | 真实 migration `09cc222e-ffd3-469c-9573-b594b526608e` → session `c5bf5d0a-1ec4-4d95-a2a8-28530ea21c96`；同 cwd；所有 field-1 root 均为 32 字节；`systemPromptRootCount=1`、`rootHistoryValid=true` |
| P0-07 | 会话 ZIP 与路径映射 | `TODO` | P0-02/P0-03/P0-04 | pack/unpack/checksum/staging/path map | 两个隔离用户目录 round-trip 通过 |
| P0-08 | Codex → Qoder 国际版会话 Gate | `IN_PROGRESS` | P0-05/P0-06 | 本地 E2E、sentinel report、工作区一致性报告 | 实际下一轮回答命中 4 个迁移历史信号并在 IDE 可见；离线和幂等/回滚 Gate 待完成 |
| P0-08B | Codex → Qoder CN 会话 Gate | `BLOCKED` | P0-05/P0-06B | CN 本地 E2E、sentinel report、失败探针精确回滚 | 两个模型均已真实调用并返回 `finishCode=112` 套餐限制；解除条件：当前 Qoder CN 账号恢复模型服务权限 |
| P0-08C | Codex → Cursor 会话 Gate | `IN_PROGRESS` | P0-05/P0-06C | 本地 E2E、root history 回读、幂等、连续性与故障回滚 | session `c5bf5d0a-1ec4-4d95-a2a8-28530ea21c96` 已实际发送下一轮并持久化为第 2 turn；request `1dc3264d-af2d-4219-bd8b-be053f43c49a` 成功回答迁移历史；续聊后复跑 migration `99fac385-c652-430e-89c9-5b4bd0a90bca` 命中同一 session 并保留新增 turn；精确 delete-by-id 回滚待完成 |

### 5.3 全局 MCP 配置主线

| ID | 任务 | 状态 | 依赖 | 交付物 | 完成证据 |
|---|---|---|---|---|---|
| P0-09 | Codex/Cursor MCP 只读 Adapter | `TODO` | P0-02/P0-04 | effective config reader、scope/precedence | 合成配置和当前版本真实只读烟测 |
| P0-10 | 全局 MCP diff/apply/rollback | `TODO` | P0-09 | 产品级任务、逐 server diff、备份、原子写入、回滚 | 目标临时配置 round-trip 与故障注入通过 |
| P0-11 | Codex → Cursor MCP Gate | `TODO` | P0-10 | 独立 CLI E2E 与 MCP 配置包 round-trip | 见第 6.3 节 Gate |

### 5.4 Phase 0 Gate 审核

| ID | 任务 | 状态 | 依赖 | 交付物 | 完成证据 |
|---|---|---|---|---|---|
| P0-12 | M1 Gate 审核 | `WAITING` | P0-07/P0-08/P0-11 | Gate 报告、失败项清单、进入 Phase 1 决策 | 同工作区迁移、跨电脑 ZIP、MCP 三项 Gate 全通过 |

## 6. Phase 0 Gate

### 6.1 会话 Gate：Codex → Qoder 国际版

必须同时满足：

- [x] 从真实 Codex 会话只读生成 Capsule/Handoff。
- [x] 源会话最新 turn 完成，迁移前后 hash 不变。
- [x] 源 `thread.cwd=A`，目标会话 cwd 为同一个 canonical(A)。
- [x] 请求、开发 CLI 和正式桌面 UI 均不能覆盖目标目录。
- [ ] ZIP 中不存在 MCP Registry、MCP 源配置或 MCP 写入计划。
- [x] 当前真实迁移前后 Codex/Qoder MCP 语义 hash 不变。
- [x] Qoder IDE IPC 以 `session/new` + `session/appendHistoryTurn` 写入历史，未调用 `session/prompt` / `chat/ask`；不拼接私有 JSONL。
- [x] Qoder IDE 国际版 `com.qoder.ide` 已打开 A；目标会话在 Chat History 可见，并已从 IDE 打开显示原生 User/Assistant 问答；正文无迁移包装 Markdown。
- [x] 在迁移后的 Qoder 会话实际发送下一条消息；回答准确复述 `Anneal`、`Product Contract`、`Direct`、`Full Assurance`，并在 Qoder IDE 作为第二轮原生问答可见。
- [ ] 回滚只处理 Capsule/Handoff/目标会话入口，不改 MCP。

### 6.2 会话 Gate：Codex → Cursor

- [x] Cursor `3.18.9`、Bundle ID、Workbench SHA-256 和原生命令指纹匹配。
- [x] 源 `thread.cwd=A`，目标原生 `workspaceIdentifier` 回读为同一个 canonical(A)。
- [x] 通过 `developer.bulkImportChats` 导入 Chat JSON v1，不直写 Cursor 数据库。
- [x] `root_prompt_messages_json` 的每个 field-1 entry 均为 32 字节 SHA-256 BlobID；`blobs[hex(BlobID)]` 保存对应消息 JSON；第一个 blob 为 `role=system,id=system`，第二个为独立的 `<user_info>` 用户上下文。
- [x] 从 `composerHeaders`、`composerData` 和内容寻址 blob 只读回读，角色、数量、顺序与源投影一致。
- [x] 通过 `composer.openComposer` 精确打开目标 session。
- [x] 相同源快照重复迁移复用同一目标 ID，会话总数不增加。
- [x] Codex 源文件和两端 MCP 指纹在迁移前后不变；迁移阶段不调用模型。
- [x] 在迁移后的 Cursor 会话中真实发送下一条消息；Cursor 正确回答 `Anneal`、`Product Contract`、`Direct`、`Full Assurance`，新增问答已持久化为第 2 turn。
- [ ] 故障注入后通过 Cursor 原生接口精确删除本次目标；当前 `3.18.9` 未发现公开 delete-by-id 命令，禁止以数据库直写冒充回滚完成。

### 6.3 MCP Gate：Codex → Cursor

必须同时满足：

- [ ] 任务输入只包含源产品、目标产品、scope 和所选 server。
- [ ] 任务输入、journal 和配置包中不存在 Session/Capsule ID。
- [ ] 能读取 Codex 当前有效 MCP 配置和 Cursor 目标配置。
- [ ] 能展示新增、相同、冲突、不支持四类 diff。
- [ ] 同名 server 支持跳过、重命名、合并、替换。
- [ ] 写前备份、原子写入、写后重读验证通过。
- [ ] 回滚后 Cursor MCP 配置与迁移前语义一致。
- [ ] 重复执行时重新基于当前目标配置生成 diff，不按会话重复追加。
- [ ] MCP 独立配置包可在隔离目录导入，不包含会话数据。

### 6.4 Gate 判定

| 结果 | 处理 |
|---|---|
| 全部通过 | P0-12 标记 `DONE`，允许进入 Phase 1 |
| 可复现的产品限制 | 记录为目标能力降级，更新矩阵和验收预期后重跑 |
| 数据损坏、越界写入或领域混用 | Gate 失败，必须修复后重跑全部相关用例 |
| 只有 Schema/文件产物，没有真实下一轮 | 会话 Gate 失败 |
| MCP diff 生成但未验证写入和回滚 | MCP Gate 失败 |

## 7. Phase 1 桌面 MVP Backlog

原计划要求 P0-12 后再启动本节；用户于 2026-09-02 明确要求先实现正式桌面界面，因此首条桌面操作流提前实施，其余任务仍受对应 Gate 约束。

| ID | 任务 | 状态 | 依赖 | MVP 验收 |
|---|---|---|---|---|
| P1-01 | Electron 桌面壳与本地 IPC | `DONE` | 用户提前授权 | `file://` 本地页面；无 Web/localhost；隔离 preload 调用 TypeScript core；已打包启动 |
| P1-02 | 产品 Discovery 与会话列表 | `DONE` | P1-01 | 实际展示 Codex 185 个会话、Qoder 国际版 / CN 1.27.1、workspace 和会话详情 |
| P1-03 | 会话迁移操作流 | `DONE` | P1-02/P0-08 | prototype 7 步向导支持 Qoder 国际版、Qoder CN、Cursor 和 DSH，并接入真实迁移 IPC；目标 bridge 未准备时先显示一次性启用操作 |
| P1-04 | 会话 ZIP 导入/导出向导 | `WAITING` | P1-01/P0-07 | 单/批量会话、路径映射、workspace delta |
| P1-05 | 全局 MCP 配置页 | `WAITING` | P1-01/P0-11 | 产品级整套迁移；独立任务/备份/回滚 |
| P1-06 | MCP 独立配置包 UI | `WAITING` | P1-05 | 导入/导出一次，不包含会话 |
| P1-07 | Context Bridge 全局安装 | `WAITING` | P1-01/P0-08 | 每个目标产品配置一次；工具接收 `migrationId` |
| P1-08 | Claude Code/Cursor source Adapter | `WAITING` | P0-04 | 真实只读 fixture 与契约测试 |
| P1-09 | Codex/Qoder/Claude/Cursor/DSH target Adapter | `IN_PROGRESS` | P0-08 | Qoder 国际版/CN、Cursor 与 DSH target 已接入；Claude 及其余能力降级待实现 |
| P1-10 | 任务中心 | `WAITING` | P1-03/P1-05 | 会话任务和 MCP 任务可区分、可独立回滚 |
| P1-11 | macOS MVP 打包 | `IN_PROGRESS` | P1-01～P1-10 | arm64 `.app` 已本机打包并启动；签名、安装包、离线和两台电脑验收待完成 |

MVP Gate：

- 至少三条真实会话迁移路径完成 sentinel 连续性验证。
- 至少一次真实两台电脑之间的会话 ZIP 搬运和恢复。
- 至少两组产品级 MCP 双向迁移完成 apply/verify/rollback。
- 连续迁移多个会话时，目标 MCP 配置 hash 始终不变。

## 8. 后续阶段 Backlog

### Phase 2：产品矩阵扩展

| ID | 范围 | 状态 |
|---|---|---|
| P2-01 | CodeBuddy source/target Adapter | `WAITING` |
| P2-02 | ZCode source/MCP Adapter（原生 target 已由 P0-06E 实现） | `WAITING` |
| P2-03 | Pi source/target SDK Adapter | `WAITING` |
| P2-04S | DeepSeek Harness source Adapter | `WAITING` |
| P2-04T | DeepSeek Harness target discovery 与原生会话迁移 | `DONE` |
| P2-04M | DeepSeek Harness Cordis MCP renderer（独立全局 MCP 任务） | `WAITING` |
| P2-05 | Windows/Linux 路径、进程和配置发现 | `WAITING` |

### Phase 3：实验原生投影

| ID | 范围 | 状态 |
|---|---|---|
| P3-01 | Pi 规范化事件投影 | `WAITING` |
| P3-02 | DSH seed plugin 与版本锁定 | `DONE` |
| P3-03 | lineage 多次分叉与任意迁移点继续 | `WAITING` |

### Phase 4：受控同步（可选）

| ID | 范围 | 状态 |
|---|---|---|
| P4-01 | 完成 turn 后生成新快照 | `WAITING` |
| P4-02 | 两端继续后的分支管理 | `WAITING` |
| P4-03 | 冲突检测与人工选择 | `WAITING` |

## 9. 当前执行批次 B0/B1/B2/B3

目标：B0 按 SESSION-MIG-001/002 完成 Qoder 路径；B1 按 SESSION-MIG-003 完成 Cursor `3.18.9` 原生迁移；B2 按 SESSION-MIG-004 完成 DSH `0.1.0-rc.6` 原生迁移最短闭环；B3 按 SESSION-MIG-005 完成 ZCode `3.10.2` 同目录原生迁移与桌面连续性验证。

| 顺序 | 任务 | 状态 | 当前结果 |
|---|---|---|---|
| 1 | SM1-01 / P0-01 | `DONE` | 最小 TypeScript POC 可编译；请求无目标目录、MCP 或模型字段 |
| 2 | SM1-02 / P0-05 | `DONE` | Codex App Server paginated/legacy reader 与真实只读 smoke 通过 |
| 3 | SM1-03 | `DONE` | `thread.cwd=A` 唯一解析为 canonical(A)，含 device/inode 校验 |
| 4 | SM1-04 | `DONE` | 确定性 Capsule、审计 Seed Context、原生会话轮次投影、128 KiB loss report 已实现 |
| 5 | SM1-05 / P0-06 | `DONE` | Qoder IDE 1.27.1 本地 IPC 按轮写入 User/Assistant 原生历史；精确规范化后 Chat History 可见；不需要 Qoder CLI/API Key/模型 |
| 6 | SM1-06 | `DONE` | 只识别/启动 `com.qoder.ide`，打开 canonical(A) |
| 7 | SM1-07 | `IN_PROGRESS` | 失败路径会用 Qoder 会话删除接口清理精确 session；幂等重试和故障注入仍未完成 |
| 8 | SM1-08 / P0-08 | `IN_PROGRESS` | 实际下一轮请求 `6e59536a-6bfe-4dc5-b91d-176ba763d821` 回答命中全部 4 个历史信号并持久化；断网、幂等/回滚待验证 |
| 9 | P1-01/P1-02 | `DONE` | Electron 正式桌面操作界面和本地 IPC 已实现；打包 `.app` 真实扫描 185 个 Codex 会话 |
| 10 | SESSION-MIG-002 / P0-06B | `DONE` | Qoder CN bundle/runtime/client identity 隔离完成；真实原生会话 1 轮 2 消息、同 workspace、Chat History 列表可见；29 项测试通过 |
| 11 | P0-08B | `BLOCKED` | Qoder CN 下一轮已分别使用 `gmodel`、`qfmodel` 真实发起，两次均返回服务端 `112` 套餐限制；失败记录已精确回滚，待账号权限恢复后重跑 |
| 12 | SESSION-MIG-003 / P0-06C | `DONE` | Cursor 版本/Workbench/命令锁、Chat JSON v1 内容寻址 blob、leading system-prompt root、本地扩展桥、原生导入、同工作区回读和精确打开完成 |
| 13 | P0-08C | `IN_PROGRESS` | 旧 session `fb042951-6cd0-456f-9a36-4ee9cefe66e5`（0 system roots）与 `b54ba6c6-e51c-4d4b-84cd-9c71aaf3e314`（378-byte BlobID）禁止复用；新 session `c5bf5d0a-1ec4-4d95-a2a8-28530ea21c96` 实际下一轮成功；仅精确回滚未完成 |
| 14 | SESSION-MIG-004 / P2-04T / P3-02 | `DONE` | DSH rc.6 精确版本/包指纹、Web profile bridge 0.3.0、SessionEvent v0 seed、原生持久化、Workspace 挂载、同工作区回读和桌面入口完成 |
| 15 | P0-08D | `DONE` | migration `3f017f8c-e471-48a9-ab00-d1ea945efa4c` 创建目标 Session；真实第 22 轮正确承接历史；复跑 migration `6b46b3f0-c0de-436c-b19c-33ddc0c6018b` 复用同一 Session 并保留 381 个事件 |
| 16 | SESSION-MIG-005 / P0-06E | `DONE` | ZCode 原生逐条导入、精确任务索引、版本锁、源/目标断网子进程、完整预览、桌面迁移与项目打开；正式 UI migration `cf701981-b819-4790-8c3d-08d6c3916cb9` 同目录回读 5 条；131 条原生长历史及中断恢复测试通过 |
| 17 | P0-08E | `BLOCKED` | 模型已可用；实现方第一轮真实回复命中旧事实、重启打开通过；续聊后 migration `bcbe0c92-d7f4-4a1d-b73c-fd7b8ad2afff` 复用目标并保留 13 条记录，无 session/create。第二轮与回复 UI 补充取证受 cgWindowNotFound 阻塞 |

首个真实样本：

| 用途 | Workspace | Codex Thread | 模式 | 当前状态 |
|---|---|---|---|---|
| 主 smoke case | `/Users/domino/develop/IdeaProjects/temp` | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` | paginated | 桌面 UI 迁移、原生历史、实际下一轮和 IDE 显示均通过；目标 session `06e96f4a-7df5-4175-a39c-8284a2fd09e2` |
| Qoder CN smoke | `/Users/domino/develop/IdeaProjects/temp` | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` | paginated | 原生历史、同工作区与 Chat History 列表可见通过；目标 session `c2078118-3586-4e37-9b1e-db3d11607bc6`；实际下一轮被当前账号状态 `112` 阻断 |
| Cursor smoke | `/Users/domino/develop/IdeaProjects/temp` | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` | paginated | Cursor `3.18.9` 原生历史、32-byte BlobID、leading system root、同工作区、原生回读、打开和实际下一轮通过；目标 session `c5bf5d0a-1ec4-4d95-a2a8-28530ea21c96` |
| DSH smoke | `/Users/domino/develop/IdeaProjects/temp` | `01a079cc-0137-78a2-b44c-8246d39f68fd` | paginated | DSH `0.1.0-rc.6` 原生 SessionEvent 历史、同 Workspace、原生回读、真实下一轮和续聊后幂等复跑通过；目标 session `session-idehub-116368030a2fa5a2a44915824725c5c1` |
| ZCode smoke | `/Users/domino/develop/IdeaProjects/temp` | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` | paginated | ZCode 3.10.2；目标 `sess_idehub_3d23d31cadaa63b5f29182b1a896d2181942c779243e901c9ade0f044d819f8a`；5 条迁移前缀、用户原有 6 条后缀、实现方实际新增 2 条问答全部在复跑后保留；第二轮待补 |
| 兼容回归 | `/Users/domino/develop/IdeaProjects/temp` | `019ffe64-6259-7cc3-b567-3ac6425f7d6f` | legacy | reader 单测通过；未作为首个目标写入样本 |

B0/B1/B2/B3 明确不做：

- 不迁移或写入任何 MCP 配置。
- 不实现 ZIP 跨电脑导入导出。
- 不实现 Context Bridge。
- 不接入 Qoder、Cursor、DSH、ZCode 之外的其他目标产品。

## 10. 阻塞项与待决策

### 10.1 当前阻塞项

Qoder CN 连续性受账号状态 `112` 外部阻塞。Cursor 迁移实现无外部阻塞，但精确失败回滚受当前版本缺少公开 delete-by-id 原生命令限制，仍作为未通过 Gate 管理。DSH rc.6 目标路径无当前阻塞；其他 DSH 版本继续由版本 Gate 禁止写入。

ZCode 模型阻塞已于 2026-09-10 解除，第一轮真实上下文回复与 AC-007 真实续聊后复跑通过。当前仅 AC-005 第二轮/回复 UI 补充取证受桌面控制阻塞：ZCode、访达均报 `cgWindowNotFound`，重连/重置控制会话仍未恢复；需保持 Mac 解锁且窗口可见后由实现方继续，不需要用户代发消息。IDE Hub 不需要 Key。另：2026-09-09 扫描发现 Cursor 已升级到 3.19.7，当前 3.18.9 适配正确拒绝写入，旧版本通过的历史 Gate 不能当作新版已兼容。

### 10.2 待决策

| ID | 问题 | 最晚决策点 | 当前建议 |
|---|---|---|---|
| D-001 | Rust workspace 的 crate 粒度是否按方案一次建全 | P0-01 | 只建 B0 所需最小 crates，后续按 Gate 扩展 |
| D-002 | Schema 校验库选型 | P0-02 | 优先选择支持 JSON Schema 2020-12 且可做负向测试的库 |
| D-003 | Qoder IDE native-history projection 能否在断网且不调用模型时持久化 | P0-06 | IDE 本地逐轮历史写入和 Chat History 可见已通过；未调用推理方法；断网 Gate 尚未执行 |
| D-004 | MCP merge 的精确定义 | P0-10 | 字段级合并前先定义每种 transport/scope 的冲突规则 |

## 11. 风险总控

| 风险 | 预警信号 | 应对任务 | 状态 |
|---|---|---|---|
| 私有格式变化 | 未知 event/schema fingerprint | P0-03/P0-05 | `OPEN` |
| 会话与 MCP 再次耦合 | Session schema 出现 MCP 配置字段 | P0-02/P0-04 | `OPEN` |
| 只生成文件但上下文不可继续 | 缺少真实下一轮证据 | P0-08 | `CLOSED`：真实下一轮已通过并在 IDE 显示 |
| 会话 ZIP 无法在另一台电脑恢复 | 依赖源绝对路径 | P0-07/P0-08 | `OPEN` |
| MCP 重复迁移覆盖目标 | 任务携带 Session ID 或无幂等 diff | P0-10/P0-11 | `OPEN` |
| 目标配置损坏 | round-trip 或回滚失败 | P0-10 | `OPEN` |
| Cursor 导入后验证失败无法精确删除 | 无公开 delete-by-id 原生命令 | P0-08C | `OPEN`：不直写数据库；继续研究原生删除入口 |
| DSH Session v0 随版本变化 | 版本或核心包指纹不一致 | P2-04T/P3-02 | `CLOSED`：仅允许 rc.6 精确指纹；未知版本创建前失败 |

## 12. 进度更新模板

每次更新任务时使用：

```markdown
### <任务 ID> <任务名>

- 状态：TODO / IN_PROGRESS / WAITING / BLOCKED / DONE
- 负责人：
- 开始时间：
- 完成时间：
- 前置任务：
- 本次完成：
- 未完成：
- 验收命令：
- 验收结果：
- 证据文件：
- 阻塞项：
- 下一动作：
```

状态变更规则：

- `TODO → IN_PROGRESS`：已经产生实际实现工作，并填写下一动作。
- `IN_PROGRESS → DONE`：所有验收项通过，证据可复查。
- `IN_PROGRESS → BLOCKED`：记录外部阻塞、已尝试方案和解除条件。
- Gate 失败：相关任务回到 `IN_PROGRESS`，不得通过降低完成定义直接标记 `DONE`。

## 13. 变更记录

2026-09-10 补验 ZCode：原生 IDE 退出/重启后打开同一任务；实现方实际发送旧上下文问题并收到正确回复（正文 hash `3142a44e67971eefa8d847948fe03dffcb8894f11940ded67ed80b0a19ee9bfa`）；Electron 真进程复跑 `bcbe0c92...` 保留全部 13 条记录，无重新导入。AC-004/AC-007 通过，AC-005 第二轮因桌面控制故障待补。48 项测试与构建/类型检查通过；本轮未改生产迁移代码、未提交。

2026-09-09 新增 SESSION-MIG-005：ZCode 3.10.2 原生离线迁移及正式向导已实现，真实桌面迁移 `cf701981-b819-4790-8c3d-08d6c3916cb9` 回读同目录 5 条消息；48 项常规测试、单独 131 条原生长历史/恢复测试和 Electron 真进程迁移通过。完整发布 Gate 保留 `BLOCKED`（目标无可用模型），重启后的再次打开 UI 与真实续聊后复跑尚待完成，详见 [验收记录](./verification/session-migration-005-zcode.md)。

| 日期 | 变更 | 影响 |
|---|---|---|
| 2026-09-02 | 创建任务进度总控文档 | 建立真实进度基线；M0 完成，M1 尚未开始 |
| 2026-09-02 | 固化 Session/MCP 两条独立任务线 | 会话向导和会话 ZIP 不包含 MCP；MCP 按产品全局迁移一次 |
| 2026-09-02 | 完成 SESSION-MIG-001 并调整首个目标 | 第一条路径改为 Codex → Qoder 国际版；新增同一 canonical workspace 硬约束 |
| 2026-09-02 | 登记首个真实 Codex 测试工作区 | 使用 `/Users/domino/develop/IdeaProjects/temp` 的 paginated/legacy 两个会话；修正 App Server 分页读取要求 |
| 2026-09-02 | 实现 SESSION-MIG-001 Phase 0 CLI 并执行真实 Gate | 源读取、Seed、dry-run、hash 与降级路径通过；Qoder SDK 因独立 CLI 登录态缺失进入 HANDOFF_ONLY，原生会话 Gate 保持阻塞 |
| 2026-09-02 | 安装并登录 Qoder CLI 1.1.40，解除 native-seed 阻塞 | 原生 session `8e122887-f651-45c2-8bdd-b00f732494b9` 创建和同 workspace/Seed 验证通过；无 Assistant、usage 或 credits |
| 2026-09-02 | 撤销 Qoder CLI/SDK 完成结论，改为 IDE 原生历史适配 | CLI JSONL 不进入 IDE Chat History；实现 IDE Unix-socket RPC、精确 session 元数据事务和历史列表回读 |
| 2026-09-02 | 初版单条 Markdown 路径被验收否决 | session `ffc05b5d-c551-4b6a-a75f-c85c3ab4f2f8` 虽在 Chat History 可见，但只是把 Handoff Markdown 塞成 User 消息，不属于会话迁移；已删除 |
| 2026-09-02 | Qoder 原生 User/Assistant 历史 Gate 通过 | migration `fdc66360-6167-4c79-9cc0-c51f77a37ba1` 将 5 条源可见消息投影为 1 个原生问答轮次；session `7ff77ac4-9d6c-421c-9689-527696d12671` 已从 IDE 打开且正文无迁移包装；21 项测试通过 |
| 2026-09-02 | 正式本地桌面首屏与 macOS `.app` 落地 | Electron 44.1.1；本地 `file://` + 隔离 preload IPC；真实扫描 185 个 Codex 会话并由界面完成迁移；打包应用已启动验证 |
| 2026-09-02 | Codex → Qoder 实际下一轮连续性 Gate 通过 | migration `3f52cf27-b58e-4d64-8ceb-fe0f873b2cca`、session `06e96f4a-7df5-4175-a39c-8284a2fd09e2`；回答 hash `a6f738fd1fd254f894aa987ad7a3e8ca4f0322c3b88d55dcb906c02751682bbf`；24 项测试通过 |
| 2026-09-02 | prototype 正式渲染层与完整迁移向导落地 | Electron 直接加载 `prototype/index.html`；真实扫描 185 个 Codex 会话；ZIP/MCP/任务中心保留并标记未实现；桌面向导真实迁移 `9dbb2555-7424-4495-9741-8ca076f0cc02` → session `c4853eb4-fa20-4757-9964-fd68886a507c`，同一 `/Users/domino/develop/IdeaProjects/temp`、1 轮 2 消息、模型/MCP 均未调用或修改 |
| 2026-09-02 | Codex → Qoder CN 原生迁移落地 | 独立识别 `com.aliyun.lingma.ide`、`QoderCN/SharedClientCache/qodercn.sock` 和 `QoderCN` client identity；migration `68dfa68f-e7ab-41da-a285-83e9ce122373` → session `c2078118-3586-4e37-9b1e-db3d11607bc6`，同一 `/Users/domino/develop/IdeaProjects/temp`、1 轮 2 消息、Chat History 列表可见；失败探针遗留的 1 条孤立 record 已精确清理 |
| 2026-09-02 | Qoder CN 连续性 Gate 真实调用受账号限制 | `gmodel` 与启用的 `qfmodel` 均返回 `finishCode=112` 套餐页；新增失败 Gate 精确 record 回滚，2 条失败探针已清理，目标会话回读恢复为 1 条迁移记录；29 项测试通过 |
| 2026-09-03 | Codex → Cursor `3.18.9` 原生迁移落地 | 版本/Workbench/命令精确锁定；隔离用户目录原生导入和 blob 回读通过；真实 migration `72addebb-2d3f-4708-9678-44e7105b31d8` → session `fb042951-6cd0-456f-9a36-4ee9cefe66e5`，同一 `temp` 工作区、1 轮 2 消息；幂等复跑会话数 `5 → 5`；真实下一轮和精确回滚保持未完成；33 项测试通过 |
| 2026-09-04 | Cursor 第一次 root 修复尝试失败 | session `b54ba6c6-e51c-4d4b-84cd-9c71aaf3e314` 虽能显示且回读为 1 个 system root，但错误地把 378 字节内联 JSON 写入 BlobID 字段；真实下一轮报 `BlobID must be 32 bytes, got 378`，该会话永久禁止复用 |
| 2026-09-04 | Cursor 32-byte BlobID 与连续性 Gate 通过 | 协议升级为 `cursor-chat-json-v1-blob-roots-v3`：field 1 仅写 SHA-256 digest，第一个 blob 是 `role=system,id=system`；migration `09cc222e-ffd3-469c-9573-b594b526608e` → session `c5bf5d0a-1ec4-4d95-a2a8-28530ea21c96`；实际下一轮 request `1dc3264d-af2d-4219-bd8b-be053f43c49a` 成功，回答 hash `158e6b32624ded028ad1b1be61586ff7e1b629e554bd932c0f4c1cb53816e87a`，第 2 turn 已持久化；续聊后复跑 migration `99fac385-c652-430e-89c9-5b4bd0a90bca` 仍复用同一 session；36 项测试、检查、构建和桌面打包通过；精确回滚仍待完成 |
| 2026-09-09 | Codex → DeepSeek Harness rc.6 原生迁移与连续性 Gate 通过 | bridge 0.3.0 在 DSH 进程内创建 SessionEvent v0 seed 并挂载同一 Workspace；migration `3f017f8c-e471-48a9-ab00-d1ea945efa4c` → session `session-idehub-116368030a2fa5a2a44915824725c5c1`；实际第 22 轮正确回答旧历史中的 `xhigh/max` 映射，续聊后 migration `6b46b3f0-c0de-436c-b19c-33ddc0c6018b` 复用同一 Session 且事件数保持 381；迁移未调用模型或修改 MCP |
