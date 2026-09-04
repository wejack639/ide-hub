# SESSION-MIG-001：Codex 会话迁移到 Qoder 国际版

> 状态：Implemented / IDE History Gate Passed / Continuity Gate Passed  
> 日期：2026-09-02  
> 范围：macOS，本机单会话，Codex → Qoder IDE 国际版  
> 目标版本基线：`codex-cli 0.151.0` / App Server v2；Qoder IDE `com.qoder.ide` 1.27.1  
> 不包含：MCP、ZIP 跨电脑、批量迁移、Qoder CN、其他 IDE

## 1. 目标

用户选择一个 Codex 会话后，IDE Hub 在 Qoder 国际版中创建一个可继续的原生会话，并满足：

```text
Codex 会话 cwd = A
       ↓
Qoder 会话 cwd = canonical(A)
```

迁移时不允许选择另一个目标目录。源会话属于 A，目标会话就必须属于同一个 A。

迁移完成后，用户打开 Qoder IDE 国际版即可在 A 工作区继续，不需要重新说明目标、已完成工作、关键约束和最近上下文。

## 2. 关键定义

### 2.1 “会话在 A 目录下”

指会话元数据中的工作目录 `cwd/project root` 为 A，不是会话 JSONL 文件物理存放在 A。

- Codex 会话文件通常位于 Codex 用户数据目录。
- Qoder 会话文件通常位于 Qoder 用户数据目录。
- IDE Hub 判断会话归属时只使用会话元数据中的工作目录，不使用 JSONL 父目录，也不自行推断 Git 根目录。

### 2.2 Qoder 国际版

本 Spec 固定目标为 Qoder IDE 国际版：

| 项目 | 值 |
|---|---|
| macOS bundle id | `com.qoder.ide` |
| 当前本机应用 | `/Applications/Qoder IDE.app` |
| 当前本机版本 | `1.27.1` |
| 用户数据目录 | 默认 `~/.qoder` |
| 环境变量前缀 | `QODER_*` |

以下目标不属于本 Spec：

- Qoder CN IDE：`com.aliyun.lingma.ide`
- Qoder CN App：`com.qodercn.app`
- Qoder 独立 App：`com.qoder.app`

## 3. 不可变规则

### INV-SM-001：工作区必须相同

```text
canonical(sourceThread.cwd) == canonical(targetSession.cwd)
```

- 调用接口中不得出现 `targetWorkspace`。
- UI 中不得出现目标目录选择器。
- CLI 中不得提供 `--target-workspace` 或 `--cwd` 覆盖参数。
- Qoder 启动参数必须由源会话 `cwd` 派生。
- 不允许把 A 下的 Codex 会话迁移为 B 下的 Qoder 会话。

### INV-SM-002：源会话只读

迁移前后，Codex 源 rollout 的内容 hash、size 和 mtime 必须一致。

### INV-SM-003：不调用模型

- IDE Hub 不配置 OpenAI、Qoder 或其他模型 API Key。
- 上下文提取、裁剪和 Handoff 生成全部使用确定性代码。
- 迁移只允许调用 Qoder IDE 本地后端的 `session/new`、`session/appendHistoryTurn`、会话元数据与查询接口。
- 禁止调用会触发推理的 `session/prompt`、`chat/ask`；目标会话可以包含从 Codex 导入的 Assistant 历史，但不得产生新的模型回复。
- 用户迁移完成后在 Qoder 中正式继续对话，属于 Qoder 自身正常使用，不属于迁移阶段。

### INV-SM-004：不修改 MCP

- 请求、任务、Capsule、Handoff 和 journal 中不得包含 MCP 配置。
- 迁移前后 Codex 与 Qoder 的有效 `mcpServers` 语义 hash 必须不变。

### INV-SM-005：正文由 Qoder IDE 原生后端持久化

- 不自行拼接、复制或修改 `~/.qoder/projects/**/*.jsonl`，不自行加密消息正文。
- Codex 的可见 User/Assistant 历史必须按对话轮次经 Qoder IDE 本地 IPC 的 `session/appendHistoryTurn` 写入，由 Qoder 后端完成正文加密和关联表持久化。
- Qoder IDE 1.27.1 会把该专用 RPC 创建的外部历史标为 `voice`，不会出现在普通 Chat History。适配器允许在锁定版本和精确 sessionId/workspace 条件下，以单个 SQLite 事务把本次新建记录的 `chat_session.session_type`、`chat_record.session_type` 改为 `assistant`，并写入 `sessionCreateSource=ide-hub-import`。
- 上述事务不得修改消息正文、其他会话或 MCP；写后必须通过 `chat/getSessionById` 和 `chat/listAllSessions` 重新验证，失败则用 Qoder 会话删除接口清理本次 session。

## 4. 用户故事

```gherkin
Given Codex 中存在一个已完成且 cwd 为 A 的会话
And Qoder IDE 国际版已安装
When 用户选择该会话并执行“迁移到 Qoder 国际版”
Then IDE Hub 从 Codex 只读提取上下文
And 创建 cwd 为 canonical(A) 的 Qoder 原生会话
And 将 Codex 的 User/Assistant 历史按原生问答轮次加入该会话但不触发模型调用
And 用 Qoder IDE 国际版打开 canonical(A)
And Qoder CN 不会被启动
And 用户可在该 Qoder 会话中直接继续
```

## 5. 范围

### 5.1 本期包含

- 发现本机 Codex App Server。
- 列出并读取一个 Codex 本地会话。
- 从 `thread.cwd` 解析唯一工作区。
- 生成确定性的 Capsule、审计用 Seed Context 与 Qoder 会话轮次投影。
- 启动/复用 Qoder IDE，通过其本地 IPC 创建由 Qoder 分配 ID 的持久会话。
- 强制 Qoder 会话 `cwd=canonical(A)`。
- 使用 Qoder IDE 自身状态，不安装或登录 Qoder CLI，不新增 PAT/API Key。
- 打开 Qoder IDE 国际版的 A 工作区。
- 逐轮验证目标会话 ID、工作区、User 正文和 Assistant 正文。
- 记录 lineage 与迁移 journal。

### 5.2 本期不包含

- MCP 读取、展示、迁移或写入。
- Codex 的 reasoning、工具调用、审批等私有事件 1:1 投影成 Qoder 私有事件。
- Codex 的 reasoning、审批、终端进程和检查点原样恢复。
- Qoder CN。
- 同时迁移多个会话。
- ZIP 导入导出和跨电脑路径映射。
- 自动发送迁移后的第一条业务问题。
- 用模型总结或压缩上下文。
- 多根 workspace、remote workspace、容器路径和 worktree 重映射。

## 6. 产品能力依据

### 6.1 Codex 源读取

优先使用 [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)：

- `thread/list`：可按 `cwd` 筛选本地会话。
- `thread/read`：只读获取指定 thread 的元数据。
- `thread/turns/list`、`thread/items/list`：分页读取当前 paginated thread 的完整历史。
- Thread 是会话，Turn 是轮次，Item 是消息、工具调用和文件修改等事件。

读取规则：

- `historyMode=paginated`：使用 `thread/read(includeTurns:false)`，再通过 `thread/turns/list` 和 `thread/items/list` 翻页直到 cursor 为空。
- `historyMode=legacy`：允许 `thread/read(includeTurns:true)`。
- 不允许把单次响应截断后的内容当成完整快照。
- 所有分页结果必须按稳定顺序重组，并记录页数、item 数和最终 cursor。

首期不以直接解析 Codex JSONL 作为主路径。JSONL 只用于源文件 hash 校验和 App Server 不可用时的诊断，不作为降级写入接口。

### 6.2 Qoder 目标创建

Qoder IDE 1.27.1 运行时在 `~/Library/Application Support/Qoder/SharedClientCache/.info.json` 公布本地 Unix socket。实测可使用 JSON-RPC 调用：

- `session/new`：在指定 `cwd` 创建 Qoder 原生 session。
- `session/appendHistoryTurn`：追加外部历史，不经过 `session/prompt`，不触发模型。
- `chat/getSessionById`：读取并验证正文、workspace 和 session type。
- `chat/listAllSessions`：验证会话真实出现在 A 工作区的 Chat History。
- `chat/renameSession`、`chat/deleteSessionById`：设置可识别标题和精确清理本次会话。

迁移直接复用用户正在使用的 Qoder IDE，不依赖 Qoder CLI、Qoder Agent SDK、API Key 或额外登录流程。该接口和元数据适配按 Qoder IDE `1.27.1` 锁定；版本超出已验证范围时禁止写入。

## 7. 迁移策略

### 7.1 迁移级别

本 Spec 使用“原生会话 + 原生 User/Assistant 轮次投影”模式：

- 目标是一个真实、可恢复的 Qoder 会话。
- Codex 每条 User 消息开启一个 Qoder 对话轮次；其后连续的 Assistant 可见消息按源顺序合并为该轮的一个 Assistant 回答。
- 每个对话轮次单独调用一次 `session/appendHistoryTurn`；禁止把整个消息数组一次性提交，因为实测会丢失第二条及之后的 User 消息。
- 迁移标记只写入 `chat_session.extra` / `chat_record.extra` 元数据，不进入聊天正文。
- reasoning、工具调用、审批等非可见消息保留在 Capsule 中，不伪装为 Qoder 原生 Tool 事件。
- Qoder 后续对话自然追加在该会话中。

### 7.2 会话轮次投影

投影输入只包含 Codex 可见的 `userMessage` 与 `agentMessage`。目标轮次结构为：

```ts
type ProjectedTurn = {
  requestId: string;
  sourceTurnIds: string[];
  sourceItemIds: Array<string | null>;
  sourceMessageCount: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
};
```

规则：

- 每条 User 形成一个新目标轮次，User-only 尾轮允许保留。
- 同一 User 后的多条 Assistant 可见消息用两个换行连接，正文和顺序不得改变。
- 不得在正文添加 migrationId、sourceThreadId、说明标题或其他包装 Markdown。
- `conversation-projection.json` 保存源 item 到目标 requestId 的映射。
- `seed-context.md` 继续作为 IDE Hub 审计/ZIP 兼容产物，但绝不写入 Qoder 会话。
- Capsule 保留全部规范化事件；非对话事件的损失统计写入 `loss-report.json`。

### 7.3 目标会话写入

Phase 0 使用 Qoder IDE 本地 JSON-RPC，核心调用如下：

```ts
const { sessionId } = await qoderIde.request("session/new", {
  cwd: canonicalWorkspace,
  mcpServers: [],
  _meta: { "ai-coding/mode": "agent", "ai-coding/workspace-path": canonicalWorkspace },
});

for (const turn of conversationProjection.turns) {
  await qoderIde.request("session/appendHistoryTurn", {
    sessionId,
    requestId: turn.requestId,
    messages: turn.messages,
  });
}
```

正文写入后执行受版本约束的可见性元数据事务，再通过 `chat/getSessionById` 逐个 requestId 比较问题/回答正文，并用带 `workspacePath` 的 `chat/listAllSessions` 验证历史可见性。迁移代码中不得出现 `session/prompt` 或 `chat/ask`。

### 7.4 打开目标 IDE

macOS 首期命令语义：

```bash
/usr/bin/open -a "/Applications/Qoder IDE.app" <canonical-A>
```

启动前后必须校验目标 bundle id 为 `com.qoder.ide`。不得按显示名称模糊匹配并启动 Qoder CN。

## 8. 工作区解析

### 8.1 解析算法

```text
sourceRaw = thread.cwd
require sourceRaw is absolute
require sourceRaw exists and is a directory
sourceCanonical = realpath(sourceRaw)
targetCanonical = sourceCanonical
```

记录以下字段：

```json
{
  "sourceWorkspaceRaw": "/path/as-stored/by/codex",
  "workspaceCanonical": "/resolved/path/A",
  "workspaceIdentity": {
    "device": 0,
    "inode": 0
  }
}
```

### 8.2 特殊情况

| 情况 | 处理 |
|---|---|
| A 不存在 | 失败：`SOURCE_WORKSPACE_NOT_FOUND` |
| A 不是目录 | 失败：`SOURCE_WORKSPACE_NOT_DIRECTORY` |
| A 是符号链接 | 使用 `realpath(A)` 创建目标会话，保留原路径用于展示 |
| Codex cwd 是相对路径 | 失败：`SOURCE_WORKSPACE_NOT_ABSOLUTE` |
| 多根 workspace | 首期失败：`MULTI_ROOT_WORKSPACE_UNSUPPORTED` |
| 目标被解析为 B | 失败并删除本次新建目标会话：`TARGET_WORKSPACE_MISMATCH` |
| A 是 Git 子目录 | 保持 A，不提升到 Git 根目录 |

## 9. API 与命令

### 9.1 请求模型

```json
{
  "sourceProduct": "codex",
  "targetProduct": "qoder-international",
  "sourceThreadId": "<thread-id>",
  "contextPolicy": "goal-recent-plan-v1",
  "dryRun": false
}
```

请求中明确禁止：

```text
targetWorkspace
targetCwd
mcpServers
mcpMigrationId
apiKey
model
```

### 9.2 CLI

```bash
ide-hub session migrate \
  --source codex \
  --target qoder-international \
  --thread <thread-id>
```

Dry-run：

```bash
ide-hub session migrate \
  --source codex \
  --target qoder-international \
  --thread <thread-id> \
  --dry-run
```

Dry-run 只输出源工作区、目标工作区、上下文大小、loss report 和计划操作，不创建 Qoder 会话、不启动 IDE。

### 9.3 成功结果

```json
{
  "migrationId": "<uuid>",
  "status": "COMPLETED",
  "sourceThreadId": "<codex-thread-id>",
  "targetSessionId": "<qoder-session-id>",
  "workspace": "/canonical/A",
  "modelInvoked": false,
  "mcpChanged": false,
  "continuation": {
    "product": "qoder-international",
    "bundleId": "com.qoder.ide"
  }
}
```

## 10. 状态机

```text
CREATED
  → SOURCE_DISCOVERED
  → SOURCE_STABLE
  → WORKSPACE_RESOLVED
  → SOURCE_SNAPSHOTTED
  → SEED_CONTEXT_BUILT
  → CONVERSATION_PROJECTED
  → TARGET_SESSION_CREATED
  → TARGET_VERIFIED
  → QODER_OPENED
  → COMPLETED
```

失败状态：

```text
FAILED_PRECHECK
FAILED_SOURCE_CHANGED
FAILED_TARGET_CREATE
FAILED_TARGET_VERIFY
CLEANUP_REQUIRED
```

状态要求：

- `TARGET_SESSION_CREATED` 之前不得写入 Qoder 用户数据。
- `COMPLETED` 必须已经拿到 `targetSessionId` 并验证 workspace。
- 只生成 Capsule/Handoff 不得标记 `COMPLETED`。
- Qoder 打开了 A，但目标会话未创建，不得标记 `COMPLETED`。

## 11. 本地产物

```text
~/Library/Application Support/IDE Hub/
└── migrations/<migration-id>/
    ├── request.json
    ├── source-snapshot.json
    ├── capsule.jsonl
    ├── seed-context.md
    ├── conversation-projection.json
    ├── loss-report.json
    ├── target-result.json
    └── journal.jsonl
```

- 首期不向 A 写入 `.ide-hub/`。
- Capsule 中的文件路径优先存 A 下的相对路径。
- 本地产物只用于审计、重试和回滚定位，不是 Qoder 会话存储。

## 12. 错误码

| 错误码 | 含义 |
|---|---|
| `CODEX_APP_SERVER_UNAVAILABLE` | 无法连接 Codex App Server |
| `SOURCE_THREAD_NOT_FOUND` | 源 thread 不存在 |
| `SOURCE_CONVERSATION_EMPTY` | 源 thread 没有可迁移的 User/Assistant 可见消息 |
| `SOURCE_TURN_RUNNING` | 源会话仍有活动 turn |
| `SOURCE_CHANGED_DURING_SNAPSHOT` | 快照过程中源会话变化 |
| `SOURCE_WORKSPACE_NOT_FOUND` | 源 cwd 不存在 |
| `SOURCE_WORKSPACE_NOT_DIRECTORY` | 源 cwd 不是目录 |
| `SOURCE_WORKSPACE_NOT_ABSOLUTE` | 源 cwd 不是绝对路径 |
| `MULTI_ROOT_WORKSPACE_UNSUPPORTED` | 首期不支持多根工作区 |
| `QODER_INTERNATIONAL_NOT_INSTALLED` | 未发现 `com.qoder.ide` |
| `QODER_CN_SELECTED` | 发现目标实际为 CN，立即拒绝 |
| `QODER_RUNTIME_UNAVAILABLE` | Qoder IDE 未运行、IPC socket 不可连接或本地后端调用失败 |
| `QODER_AUTH_EXPIRED` | Qoder IDE 自身登录态失效；提示用户在 IDE 内登录，不索取 API Key |
| `MODEL_CALL_DETECTED` | 迁移阶段检测到模型请求或 usage，Gate 失败 |
| `TARGET_SESSION_NOT_PERSISTED` | Qoder IDE 后端返回但会话无法读回 |
| `TARGET_WORKSPACE_MISMATCH` | 目标会话 cwd 不是 canonical(A) |
| `TARGET_SESSION_NOT_VISIBLE_IN_IDE` | Qoder IDE 的 A 工作区不可恢复该会话 |
| `MCP_CHANGED_DURING_SESSION_MIGRATION` | MCP 语义 hash 变化，Gate 失败 |

## 13. 回滚与重试

- Codex 源永远不回滚，因为源只读。
- `TARGET_SESSION_CREATED` 之前失败，只删除 IDE Hub 本次迁移目录。
- 已创建 Qoder 会话时，只能使用 Qoder 官方会话删除能力处理。
- 删除前必须重新列出会话并以 `targetSessionId + canonical(A)` 双重匹配；无法精确匹配时进入 `CLEANUP_REQUIRED`，不得按私有路径删除文件。
- 同一 `migrationId` 重试必须复用同一个 `targetSessionId`，不得产生重复会话。
- 新建迁移任务必须生成新 `migrationId` 和新 `targetSessionId`。

## 14. 验收标准

### 14.1 自动验收

- [ ] 请求 Schema 中没有目标目录字段。
- [ ] A 会话迁移结果的目标 cwd 为 canonical(A)。
- [ ] 伪造或内部注入 B 时返回 `TARGET_WORKSPACE_MISMATCH`。
- [ ] 符号链接路径能按文件身份正确匹配。
- [ ] 源会话迁移前后 hash、size、mtime 不变。
- [ ] Seed Context 生成两次字节完全一致。
- [ ] 128 KiB 超限策略稳定，`loss-report.json` 数量正确。
- [x] 目标写入只调用 `session/new` 与 `session/appendHistoryTurn`，未调用 `session/prompt` 或 `chat/ask`。
- [x] 导入的 Assistant 历史与源正文一致，且迁移过程没有生成新回复，`modelInvoked=false`。
- [x] 每个源 User 轮次独立写入一个 Qoder `chat_record`，后续 User 不丢失。
- [x] Qoder 正文不包含 `[IDE Hub Migration Context]`、migrationId 或 sourceThreadId 包装信息。
- [ ] 断网条件下能完成迁移；不能完成则本 Spec 的 IDE-native history Gate 失败。
- [ ] Codex/Qoder MCP 有效配置语义 hash 不变。
- [ ] 目标 bundle id 必须为 `com.qoder.ide`。
- [ ] Qoder CN 安装存在时也不会被误启动。

### 14.2 真实烟测

准备 Codex 会话：

1. cwd 为真实 A。
2. 会话中写入唯一 sentinel：`IDE_HUB_SENTINEL_<uuid>`。
3. 记录一个明确目标、一个约束、一个已涉及文件和一个未完成动作。
4. 等待最新 turn 完成。

迁移后验证：

- [x] Qoder IDE 国际版打开的目录是 A。
- [x] Qoder Chat History 能定位并打开 `targetSessionId`。
- [x] 目标会话 workspace 元数据解析后仍为 A。
- [x] 原始 User 问题与 Assistant 回答以 Qoder 原生角色显示，正文回读与投影完全一致。
- [ ] 用户在 Qoder 手工发送“复述迁移目标和下一步，不要执行”。
- [ ] Qoder 能复述 sentinel，并指出正确的未完成动作。
- [ ] 这次人工继续使用 Qoder 自己的账号/模型；IDE Hub 没有 API Key。

### 14.3 完成定义

以下条件全部满足，SESSION-MIG-001 才能标记 `DONE`：

1. 自动验收全部通过。
2. 至少一个真实 Codex → Qoder 国际版迁移成功。
3. 目标和源工作区均为同一个 canonical(A)。
4. Qoder 原生会话可恢复并继续。
5. 人工 sentinel 连续性验证通过。
6. 迁移阶段无模型调用、无 MCP 变化、无源会话变化。
7. Gate 报告记录命令、版本、session ID、workspace、hash 和结果。

### 14.4 首个真实测试样本

用户已授权使用以下目录中的 Codex 会话做 SESSION-MIG-001 测试：

```text
sourceWorkspaceRaw = /Users/domino/develop/IdeaProjects/temp
workspaceCanonical = /Users/domino/develop/IdeaProjects/temp
device = 16777233
inode = 61642089
```

2026-09-02 只读 App Server 探针结果：

| 用途 | Thread ID | History mode | 状态 | cwd |
|---|---|---|---|---|
| 主 smoke case | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` | `paginated` | thread `notLoaded`，最新 turn `completed` | `/Users/domino/develop/IdeaProjects/temp` |
| legacy 回归 | `019ffe64-6259-7cc3-b567-3ac6425f7d6f` | `legacy` | `notLoaded` | `/Users/domino/develop/IdeaProjects/temp` |

主 smoke case 验收标记：

```text
mosonlab/anneal
Product Contract
```

主样本只读基线（2026-09-02 采集）：

```text
rollout_size = 1184934
rollout_mtime = 2026-09-02T10:28:55+0800
rollout_sha256 = 6330c398ae02eacb7e21e39f588723f19ed147c71bec8b05e9ec669874e97811
```

要求：

- 测试只读源会话，不向源会话追加 sentinel。
- 正式迁移开始前重新采集基线；如果与上述探针值不同，记录新值并确认 thread 仍为 completed，不把旧 hash 当作永久常量。
- `mosonlab/anneal` 必须进入 Qoder 原生 User 问题。
- `Product Contract` 必须进入 Qoder 原生 Assistant 回答。
- 目标 Qoder 会话 cwd 必须仍是 `/Users/domino/develop/IdeaProjects/temp`。
- 主样本必须走 paginated reader，不得使用已废弃的全历史 hydration。
- legacy 样本用于证明 reader 能按 `historyMode` 选择兼容路径，不作为首个 Qoder 写入 Gate 的前置条件。

## 15. 实现任务拆分

| 顺序 | ID | 任务 | 交付物 |
|---|---|---|---|
| 1 | SM1-01 | 定义请求、结果、状态与错误码 | Schema + 单测 |
| 2 | SM1-02 | Codex App Server 只读 reader | list/read/status/snapshot |
| 3 | SM1-03 | Workspace identity | realpath/device/inode 校验 |
| 4 | SM1-04 | 确定性 Capsule/会话投影 builder | Capsule、审计 Seed、conversation projection、loss report |
| 5 | SM1-05 | Qoder IDE native-history POC | IDE IPC、同 cwd、无模型持久化、Chat History 可见 |
| 6 | SM1-06 | Qoder International discovery/launcher | bundle 校验、打开 A |
| 7 | SM1-07 | Journal、幂等重试与精确回滚 | 故障注入测试 |
| 8 | SM1-08 | 真实 E2E Gate | sentinel 与 hash 报告 |

实现顺序不得跳过 SM1-05：必须先证明 Qoder IDE 本地后端能创建不触发模型、且在 Chat History 可见的持久会话，再接入正式桌面流程。

## 16. Gate 失败后的处理

如果当前 Qoder IDE 版本无法在不调用模型的情况下持久化并展示原生 User/Assistant 历史：

1. 不直写 Qoder JSONL。
2. 迁移失败并返回明确错误，不能把只生成 Handoff 当成本需求完成。
3. 保持源会话和 MCP 不变。
4. 更新版本能力矩阵和本 Spec 后再实现新适配。

先前基于 Qoder CLI/Agent SDK 的实现只创建了 CLI JSONL，Qoder IDE Chat History 显示 `0 Results`，因此该路径已废弃，不能作为完成证据。

## 17. 2026-09-02 实现与 Gate 结果

已实现：

- 正式 Electron 本地桌面操作界面：真实会话列表、搜索、选择、同工作区确认、迁移进度、结果和打开 Qoder 工作区；无 HTTP/localhost 服务。
- TypeScript CLI、请求/结果 Schema 和明确错误码。
- Codex App Server paginated/legacy 只读 reader。
- workspace realpath/device/inode 绑定。
- 确定性 Capsule、Seed Context 与 128 KiB loss report。
- 可见消息到 Qoder 原生 User/Assistant 轮次的确定性投影；每轮一次 `appendHistoryTurn`，正文不含迁移包装。
- Qoder International bundle/runtime discovery、IDE Unix-socket JSON-RPC、精确可见性元数据事务、目标读回验证和系统应用启动。
- 源文件 hash/size/mtime 与 Codex/Qoder MCP 语义 hash 前后校验。
- 失败后用 Qoder 会话删除接口精确清理本次新建 session。
- Qoder `session/update` 流式通知接收、实际下一轮回答判定，以及同一 request ID 的原生问答持久化回读。

真实样本：

```text
workspace = /Users/domino/develop/IdeaProjects/temp
source_thread = 01a05feb-7d16-7000-b06e-f4e1a4d43ea2
source_sha256_before = 6330c398ae02eacb7e21e39f588723f19ed147c71bec8b05e9ec669874e97811
source_sha256_after  = 6330c398ae02eacb7e21e39f588723f19ed147c71bec8b05e9ec669874e97811
source_visible_messages = 5
projected_native_turns = 1
projected_native_messages = 2
projection_sha256 = 248c78fa682cba3a7639611176ba47ba8672352050ec81954f83099efd852eaa
native_turn_projection = PASSED
ide_history_visible = true
target_session = 06e96f4a-7df5-4175-a39c-8284a2fd09e2
model_invoked = false
mcp_changed = false
result = COMPLETED
migration_id = 3f52cf27-b58e-4d64-8ceb-fe0f873b2cca

continuity_request_id = 6e59536a-6bfe-4dc5-b91d-176ba763d821
continuity_model = gmodel
continuity_answer_sha256 = a6f738fd1fd254f894aa987ad7a3e8ca4f0322c3b88d55dcb906c02751682bbf
continuity_signals = Anneal, Product Contract, Direct, Full Assurance
continuity_persisted_in_qoder = true
continuity_gate = PASSED
```

证据目录：

```text
~/Library/Application Support/IDE Hub/migrations/3f52cf27-b58e-4d64-8ceb-fe0f873b2cca
```

尚未通过：

- 原生目标存在后的幂等重试与官方精确回滚 Gate。
- 断网条件下的原生历史投影 Gate。

Qoder IDE 原生历史与连续性 Gate 均已通过：在 `/Users/domino/develop/IdeaProjects/temp` 的 Chat History 中打开 session `06e96f4a-7df5-4175-a39c-8284a2fd09e2`，界面先显示迁移的原生 User/Assistant 问答，再显示连续性验证问题及 Qoder 的第二轮回答。回答准确指出项目为 `Anneal`，好 spec 是可冻结、可验证的 `Product Contract`，两种任务链为 `Direct` 与 `Full Assurance`。

迁移阶段仍未调用模型，也不需要 Qoder CLI 或额外 API Key。连续性 Gate 是迁移完成后的独立验收步骤，明确使用 Qoder IDE 当前登录账号和模型 `gmodel`；它不是 IDE Hub 迁移运行依赖。错误的单条 Markdown 会话和本轮无效/过期测试会话均已精确删除，当前保留上述通过 Gate 的目标会话。自动化 `check`、24 项测试与 `build` 均通过。
