# SESSION-MIG-002：Codex 会话迁移到 Qoder CN

> 状态：已实现并通过真实原生历史 Gate  
> 平台：macOS  
> 版本基线：Qoder CN IDE `1.27.1` / `com.aliyun.lingma.ide`

## 1. 目标

选择一个 Codex 会话后，在 Qoder CN 中创建可从 Chat History 恢复的原生会话：

```text
canonical(sourceThread.cwd) = canonical(targetSession.projectUri)
```

迁移复制并分叉会话，不删除或修改 Codex 源会话，不调用模型，不迁移 MCP 配置。

## 2. 与国际版的共用和隔离

共用：

- Codex App Server 完整读取与源文件 fingerprint。
- Capsule、Seed Context、可见 User/Assistant 轮次投影。
- `session/new`、每轮一次 `session/appendHistoryTurn`、正文回读。
- 精确 session 元数据规范化、Chat History 列表验证和失败清理。

必须隔离：

| 项目 | Qoder 国际版 | Qoder CN |
|---|---|---|
| bundle id | `com.qoder.ide` | `com.aliyun.lingma.ide` |
| 应用 | `/Applications/Qoder IDE.app` | `/Applications/Qoder CN IDE.app` |
| 数据根目录 | `Qoder/SharedClientCache` | `QoderCN/SharedClientCache` |
| Unix socket | `qoder.sock` | `qodercn.sock` |
| `idePlatform` / `ideSeries` | `Qoder IDE` | `QoderCN IDE` |
| plugin identity | `Qoder` | `QoderCN` |

禁止用国际版 client identity 连接 CN runtime。该错误会导致正文可写入，但 `chat/listAllSessions` 按目标身份返回空列表。

## 3. 请求

```json
{
  "sourceProduct": "codex",
  "targetProduct": "qoder-cn",
  "sourceThreadId": "<thread-id>",
  "contextPolicy": "goal-recent-plan-v1",
  "dryRun": false
}
```

请求不允许目标目录覆盖、模型、API Key 或 MCP 字段。

## 4. 完成条件

- [x] 只识别 `com.aliyun.lingma.ide`，不误启动国际版或 Qoder CN 独立 App。
- [x] 使用 `QoderCN/SharedClientCache/qodercn.sock` 和 CN client identity。
- [x] 目标 workspace 与 Codex 源 cwd 完全相同。
- [x] 原生 User/Assistant 正文逐轮写入并完全回读。
- [x] `chat/listAllSessions` 返回目标 session，类型为 `assistant`。
- [x] 源文件和 MCP 指纹迁移前后不变。
- [x] 失败清理只处理精确 sessionId 且带 `sessionCreateSource=ide-hub-import` 的行。
- [ ] 在迁移后的 Qoder CN 会话实际发送下一条消息并完成连续性 Gate；已真实调用，但当前账号被 Qoder CN 服务端状态 `112`（套餐/额度）阻断。

## 5. 真实验收证据

```text
source_workspace = /Users/domino/develop/IdeaProjects/temp
source_thread = 01a05feb-7d16-7000-b06e-f4e1a4d43ea2
migration_id = 68dfa68f-e7ab-41da-a285-83e9ce122373
target_session = c2078118-3586-4e37-9b1e-db3d11607bc6
target_product = qoder-cn
target_bundle = com.aliyun.lingma.ide
projected_turns = 1
projected_messages = 2
history_visible = true
model_invoked = false
mcp_changed = false
```

目标会话已由 `chat/getSessionById` 回读，并由 Qoder CN 实际使用的 `chat/listAllSessions` 返回。自动化 `check`、29 项测试和 `build` 通过。

连续性 Gate 已分别使用模型列表中的 `gmodel` 和已启用的 `qfmodel` 真实发起请求，两次均由 Qoder CN 服务端返回 `finishCode=112` 和套餐页，证明阻塞来自当前账号服务权限，而不是本地迁移、runtime、client identity 或模型标识。两条失败探针已按目标 `sessionId + requestId` 精确回滚；回读确认目标会话恢复为迁移产生的 1 条原生记录且仍在 Chat History 列表可见。账号恢复可用后直接重跑本 Gate。
