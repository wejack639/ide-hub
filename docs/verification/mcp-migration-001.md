# MCP-MIG-001 验收记录

> 最后验证：2026-09-15
> 范围：Codex MCP → 单个目标 IDE 的 user scope；与会话迁移完全独立
> 成功口径：目标配置 round-trip + 目标应用原生识别 + 本地 stdio `initialize + tools/list`

## 1. 本轮纠偏

此前的实现只验证“写入目标文件后，IDE Hub 自己能够读回”，没有逐个通过目标应用的原生 loader 验证。因此页面会把实际不可见的配置显示成成功。

本轮确认并修复了两个真实路径错误：

- CodeBuddy CN 4.12.0 不读取旧实现写入的 `~/.codebuddycn/.mcp.json`。国际版与 CN 当前都读取 `~/.codebuddy/mcp.json`；两版应用身份和验证日志独立，但 user 配置存储共享。
- Qoder 桌面 IDE 的“添加 MCP”实际打开国际版 `~/.qoder/mcp.json`、CN `~/.qoder-cn/mcp.json`。独立 Qoder CLI 使用的 `settings.json` 不能证明桌面 IDE 已识别。

错误 CodeBuddy CN 任务已回滚，旧错误文件已移除。用户本次选择的 `mysql-dev` 已重新迁移到共享原生路径；receipt `21ce0971-a092-42b5-8a41-9b07a17b2393` 为 `COMPLETED`，CodeBuddy CN 设置页显示该服务和 32 个工具。

## 2. 成功状态约束

- `COMPLETED`：所有勾选项均通过配置 round-trip、目标原生识别和本地 stdio handshake。
- `COMPLETED_WITH_WARNINGS`：文件已写入，但目标应用未运行、原生验证超时，或远程 MCP 未联网探活；桌面页显示“目标应用识别待确认”和警告图标，不再显示绿色成功。
- `FAILED`：目标原生 loader 明确未发现所选 MCP，迁移器自动恢复写前配置。
- 旧 v1 receipt 没有原生识别字段，桌面页明确标成“旧任务未执行目标应用识别 Gate”。

## 3. 当前本机原生矩阵

每个支持目标使用不同名称的确定性本地 MCP 探针，分别执行真实写入、目标原生识别、`initialize + tools/list` 和回滚。探针提供 1 个工具，不调用模型，也不需要模型 API Key。

| 目标 | 当前版本 / 落点 | 目标原生验证 | 结果 |
|---|---|---|---|
| Qoder 国际版 | 1.29.0；`~/.qoder/mcp.json` | 写后 `Qoder/SharedClientCache/extension/local/mcp.json` 更新并发现精确探针名 | 通过；handshake 通过；精确回滚 |
| Qoder CN | 1.29.0；`~/.qoder-cn/mcp.json` | 设置页确认原生入口；写后 `QoderCN` effective cache 更新并发现精确探针名 | 通过；handshake 通过；精确回滚 |
| Cursor | 3.19.7；`~/.cursor/mcp.json` | `cursor agent mcp list` | 通过；handshake 通过；精确回滚 |
| DeepSeek Harness | rc.6；`~/.dsh/profiles/web/cordis.patch.yml` | `dsh --profile web --dump-config` | 通过；handshake 通过；精确回滚 |
| ZCode | 3.10.2；`~/.zcode/cli/config.json` | ZCode app-server `mcp/list` | 通过；handshake 通过；精确回滚 |
| Claude Code | 2.1.268；`~/.claude.json` | `claude mcp get <精确名称>` | 通过；handshake 通过；精确回滚 |
| CodeBuddy 国际版 | 4.12.0；`~/.codebuddy/mcp.json` | 国际版扩展在写后 reload，并记录该探针的工具发现 | 通过；handshake 通过；精确回滚 |
| CodeBuddy CN | 4.12.0；`~/.codebuddy/mcp.json` | CN 扩展在写后 reload，并记录该探针的工具发现 | 通过；handshake 通过；精确回滚 |
| Pi | 已安装；无原生 MCP 落点 | 核心没有 MCP adapter | 不支持；禁用“确定迁移”，未创建伪配置 |

CodeBuddy 双版共享 user 配置，因此全矩阵为每个目标生成独立探针名，避免前一版本的加载/删除事件污染后一版本的验证。

## 4. 写入、回滚和残留检查

- apply 前持久化独立 MCP journal 和内容寻址备份；只修改本次勾选的 server。
- 目标在预览后变化时拒绝覆盖，要求重新生成 diff。
- 若目标 IDE 在写后仅格式化文件或修改无关字段，回滚只恢复本次 server 并保留外部变化；若本次 server 自身已被外部修改，则拒绝覆盖并报告冲突。
- 全矩阵完成后检查 Qoder 双版、Cursor、DSH、ZCode、Claude 和 CodeBuddy 原生配置，均无 `ide-hub-native-probe-*` 残留。
- CodeBuddy CN 旧错误路径不存在；共享原生路径中的用户 `mysql-dev` 保留，这是用户要求的真实迁移结果，不是测试探针。

## 5. 自动验证

执行命令：

```text
npm test
npm run check
npm run build
git diff --check
npm run desktop:package
IDE_HUB_ALLOW_NATIVE_MCP_MATRIX=1 node --import tsx test/manual-mcp-native-matrix.ts
```

覆盖项包括：逐项勾选、单目标 Schema、四种冲突策略、JSONC 保留、错误原生路径、原生 loader 拒绝后自动回滚、外部格式化后的选择性回滚、外部修改同名 server 的冲突保护、中断恢复、权限失败、文件占用、DSH schema/version、ZCode precedence、Pi 无 adapter 和独立 MCP 配置包。

结果：110 项测试中 107 通过、3 项既有安装包 Gate 按环境跳过、0 失败；TypeScript check、build 与 `git diff --check` 通过。原生 MCP 矩阵对 8 个支持目标全部返回 `COMPLETED`，随后全部 `ROLLED_BACK`。macOS arm64 桌面包已重建并启动；`app.asar` 回读确认包含 Qoder/CodeBuddy 新路径和警告态文案/图标。

## 6. Acceptance 状态

| AC | 状态 | 当前证据 |
|---|---|---|
| AC-001 | 通过 | 独立 MCP 页面和 IPC；请求、journal、receipt、bundle 不含会话字段 |
| AC-002 | 通过 | Codex effective reader、user/project precedence fixture 和真实扫描 |
| AC-003 | 通过 | Cursor 原生 list、handshake、回滚均通过 |
| AC-004 | 通过 | 七个 JSON/JSONC 目标逐版原生识别；Qoder 路径与 CodeBuddy 共享存储已按实际版本修正 |
| AC-005 | 通过 | DSH rc.6 原生 Cordis dump-config、handshake、回滚 |
| AC-006 | 当前能力分支通过 | Pi 无 adapter 时准确不可执行；不伪造 `mcp.json` |
| AC-007 | 通过 | 四种同名策略及 endpoint 不同禁止 merge |
| AC-008 | 通过 | 只写勾选项；单目标；stale preview 拒绝；no-op；外部格式化后选择性回滚 |
| AC-009 | 部分通过 | 坏 JSON、未知 schema/version、symlink、权限、文件占用、中断和恢复冲突已覆盖；磁盘耗尽专项注入仍待补 |
| AC-010 | 通过 | bundle checksum、隔离目录导入、project cwd remap 和会话字段拒绝 |
| AC-011 | 通过 | 本地验证不调用模型；stdio handshake；远程 transport 默认不联网探活 |

## 7. 尚未冒充完成的项

- Pi 的受信任第三方 MCP adapter 正向分支未执行，因为本机没有该产品能力；当前只能准确报告“不支持”。
- 发布级故障矩阵仍缺磁盘耗尽专项注入。这不影响本轮七类、八个目标 user scope 的原生识别结论。
