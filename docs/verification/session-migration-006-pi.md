# SESSION-MIG-006 开发与验收记录

日期：2026-09-10。合同：[Codex → Pi](../specs/SESSION-MIG-006-spec.md)。

结论：Pi 0.85.1 的 SESSION-MIG-006 全部 AC 已完成验收：原生迁移、A → A、完整预览、禁网落盘回读、原生列表与恢复、桌面打开、失败恢复，以及真实模型续聊后的幂等均通过。2026-09-10 按用户授权在 Pi 配置智谱官方 `glm-5.3-flash`，独立调用成功；实现方在同一迁移会话实际完成旧上下文问答、下一步 brief 和一次纠偏修订，关闭重开后正式桌面复跑仍保留全部记录。模型配置和聊天是本次单独授权的操作，不属于迁移流程，IDE Hub 不保存 Key。

## 改动范围与实现依据

- 最近似案例为 ZCode 的独立目标编排和现有 Codex reader / workspace / artifacts；Pi 不需要 DSH 扩展桥或 IDE 数据库索引。新增生产模块限定 `src/pi/{discovery,protocol,helper,runtime,migration}.ts`，没有新增 npm 依赖、Web 服务、全局配置或后台任务系统。
- 官方 SDK `SessionManager.inMemory` 生成父子链，公开访问器导出完整 v3 JSONL，独占发布后由独立 Node 进程原生 open/list/buildSessionContext。选择此路线解决 SDK 延迟保存 user-only 会话的问题，不通过补假 assistant 或模型调用触发保存。
- 源可见消息抽取增加可选保留空白开关，原有目标仍用原来的默认行为。Pi 逐条保留连续角色与长文本，不用 seed 窗口裁剪；时间精度、来源状态和未知用量单独标注。
- Pi helper 和本次迁移的 Codex App Server 使用 macOS `sandbox-exec (deny network*)`。helper 不携带模型 Key 环境变量，不启动 AgentSession/扩展资源加载器。MCP、账号、模型配置仅计算指纹，不输出或迁移正文。
- 幂等键包含源 thread、源文件 hash、canonical workspace、目标目录和适配协议。先登记 intent 及完整产物，再独占发布目标；中断复跑回读已有目标，保留其后缀。精确清理函数只允许删除内容仍与初始导入完全一致的文件，拒绝已产生续聊/状态变化的目标；不提供整目录删除，UI 全局回滚入口仍保持原有“未实现”。
- 复用 prototype 导航、七步向导、窄 IPC；新增 Pi 真实发现、全量预览和“在终端中打开 Pi 会话”。发布包解包 SDK helper 到 `app.asar.unpacked`，解析绝对 Node/Pi 路径，不依赖 Finder 启动时存在 Homebrew PATH。
- 未修改用户已有的 `.agent/`、`.agents/`、`.windsurf/` workflow 变更；未 commit/push。

## 自动化与原生实测

常规入口：`npm run check`、`npm run build`、`npm test`。

Pi 安装包集成入口：

```sh
IDE_HUB_PI_INTEGRATION=1 node --import tsx --test test/pi-runtime.test.ts
```

独立临时目录验证 131 条长历史、只有 user、相同时间戳、连续 assistant、原生列表/重开、未安装/未知版本、不同工作区拒绝、预览无 Pi 写入、发布中断恢复、坏行/断链拒绝、追加后复跑不覆盖、只清理本次未续聊文件。后缀 fixture 明确是合成数据，不作为模型续聊证据。首轮通过的隔离目录：`/private/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-pi-native-ITiROj`。

真实打包桌面测试：

```sh
npm run desktop:package
IDE_HUB_PI_REAL_THREAD=01a05feb-7d16-7000-b06e-f4e1a4d43ea2 node test/pi-desktop-probe.cjs
```

测试启动正式 `.app`，通过真实 renderer 的源会话/迁移按钮走七步向导、调用现有 IPC，再打开精确目标。不是 mock renderer，也不修改产品为 Web 应用；临时调试端口仅属于测试启动的 Electron 进程，测试结束关闭。

| 实测项 | 证据 |
| --- | --- |
| 测试工作区 A | `/Users/domino/develop/IdeaProjects/temp` |
| Codex Thread | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` |
| 正式 UI migration | `878da891-85d0-4901-812d-af6f7aeeb082` |
| 原生恢复后的正式 UI 复跑 | `0d7993b1-6c91-4d76-b965-fa365ef3819a`；`reused=true`，5 条可见模型历史、9 个 tree entry 保留（含本轮只读 pwd 记录） |
| Pi Session | `idehub-c51a145a91660a3cf7c301535697d7ab377c87233d5540d00b472e17c5a72e5b` |
| Pi 原生文件 | `~/.pi/agent/sessions/--Users-domino-develop-IdeaProjects-temp--/2026-09-02T02-21-03-000Z_idehub-c51a145a91660a3cf7c301535697d7ab377c87233d5540d00b472e17c5a72e5b.jsonl` |
| 全量回读 | 1 个源 turn，5 条 User/Assistant，7271 bytes 可见文本；16 项 reasoning、23 项 commandExecution 仅归档 |
| 源与配置不变 | journal 含 `POST_CONDITIONS_VERIFIED`；组合 MCP/配置指纹 `cead2308f33740c2085052342f43f7bad897657363fa5fb1ed5e691de1561d44` |
| 桌面打开入口 | `openTarget` 返回 `openMode=terminal-session`，传入确切 session 文件、cwd 与目录参数 |
| 原生交互恢复 | 在 Pi 0.85.1 交互 PTY 中打开上述文件，显示 Codex 标题及全部历史；`/resume` 的 Current Folder 列出同一标题，选中后出现 `Resumed session`；退出输出相同 ID 的恢复命令 |
| 实际工具 cwd | Pi 内执行只读 `!!pwd` 返回 `/Users/domino/develop/IdeaProjects/temp`，原生文件新增 `bashExecution`，`exitCode=0`、`excludeFromContext=true`；未调用模型 |
| 桌面截图/结果 | `/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-pi-desktop-0iU7vc/` 下 `screenshots/preview.png`、`screenshots/result.png`、`result.json` |

上述真实源正文、截图和原生运行产物只保留在本机，不提交到仓库。仓库测试使用合成消息。Terminal.app 的直接 UI 控件访问不被本次控制工具允许，因此没有声称获得其原生窗口截图；Pi 自身 TUI 的历史显示、选择器和恢复由交互 PTY 实际验证。

构建、类型检查及最终完整回归通过；开启 Pi 原生集成的测试共 54 项，53 通过、1 项 ZCode 独立安装包测试未启用。最终集成目录 `/private/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-pi-native-cUyNkw` 另覆盖符号链接复用和自定义会话目录的实际原生回读。`npm run desktop:package` 成功；正式桌面真实迁移探针连续两次通过，第二次证据在 `/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-pi-desktop-WmkWYs/`。

## Gate 状态

| AC | 状态 | 说明 |
| --- | --- | --- |
| AC-001 | 通过 | 正式桌面发现、全量预览、损失和版本拒绝；预览不创建 Pi 目录/目标 |
| AC-002 | 通过 | header / SDK / 实际 Pi `pwd` 均为 A；不同目录拒绝；路径引用与默认/自定义目录测试 |
| AC-003 | 通过 | 禁网原生落盘、131 条长历史与 user-only、新进程完整上下文回读、严格坏行/父子链校验 |
| AC-004 | 通过 | 打包桌面打开确切文件；Pi 原生 TUI 展示历史、Current Folder 列表发现并恢复 |
| AC-005 | 通过 | GLM-5.3-Flash 原生 TUI 旧事实问答、下一步及纠偏修订共 3 轮实际调用；同 ID 退出重开，原历史及新增记录完整；过程和语义核对见下节 |
| AC-006 | 通过 | 导入禁网、源及配置指纹不变；无模型仍能导入、展示、恢复；安装/主动打开/聊天另计 |
| AC-007 | 通过 | 合成后缀、中断恢复、损坏拒绝和精确清理通过；真实 3 轮问答后正式桌面复跑 `bfe0aab3...` 复用同一 Session，完整目标文件 hash 不变 |

## 2026-09-10 真实模型补验

### 模型配置及独立调用

最初缺模型的阻塞已解除。用户明确提供临时 Key 并授权配置及补验后，仅修改 Pi 本机配置：

- `~/.pi/agent/auth.json`：新增 `bigmodel` API Key，文件权限 `0600`；Key 未写入项目、模型定义、验收文档或迁移产物。
- `~/.pi/agent/models.json`：增加 `bigmodel/glm-5.3-flash`，复用 Pi 0.85.1 自带同型号的 ZAI 兼容参数和 thinking level 映射，使用官方通用端点 `https://open.bigmodel.cn/api/paas/v4`，不是 Coding Plan 专用端点。[智谱官方 API 文档](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)
- `~/.pi/agent/settings.json`：保留 `theme=dark`，默认 provider/model 设为上述模型，thinking level 为 `low`。没有修改系统环境变量、Pi 安装包或 IDE Hub 配置。

`pi --offline --list-models glm-5.3-flash` 识别到该模型。通过 Pi 本身执行无会话、无工具的独立请求“只回复 PI_GLM_OK，不要添加其他内容。”，实际收到 `PI_GLM_OK`，退出码 0。没有使用 mock 或仅凭 HTTP 状态判断模型可用。这里 `--offline` 只关闭 Pi 启动网络操作，不禁止用户明确发起的模型调用；迁移 helper 的内核禁网机制保持不变。

### 同一迁移会话原生 TUI 续聊

使用上表中的确切 Pi 文件和 A 目录启动 Pi 交互 PTY，不新建/分叉会话。禁用工具、扩展、技能和额外上下文文件，仅让模型依据迁入历史回答。首次原生恢复明确提示导入标识 `ide-hub/codex-history` 不是真实模型，并自动选择配置好的 `bigmodel/glm-5.3-flash`；新增真实回复后再次恢复不再出现该提示。

1. **旧事实问题**：询问此前分析的项目和固定 commit、两种执行路线及输入、Goals 保存 spec 与真正执行入口、否决的写法和待人决策情形。问题未提供项目名、commit、路线名称或答案。回复准确给出 Anneal、`6aafb9c`、Direct 的完整 Feature Brief、Full Assurance 的 Product Contract、Goals 仅存储展示、任务卡 description/模板实例化驱动执行；与原始迁入正文逐项核对。
2. **明确下一步**：要求沿用旧历史订单确认例子，写六段式最小 brief，并逐项对应 Changes 与 Acceptance。回复继承了 `orderId + requestId` 幂等和跨订单 `409` 语义，但自行加入了未确认的失败重试和事务规则。该额外内容不作为正确事实验收，原始回复未删除或改写。
3. **重开后纠偏**：关闭 Pi 再打开同一文件，确认前两轮仍显示；指出未确认扩展并要求删除、把未知现状列为待确认。最终 brief 仅保留旧例子的两个 Change 和对应 Acceptance，未确认的失败/事务语义不再成为强制约束。之后再退出重开，旧历史、全部三轮和当前模型均正常恢复。

| 实际新增回复 | 原生 user / assistant entry | 完成时间（UTC） | 可见回复 SHA-256 |
| --- | --- | --- | --- |
| 旧上下文核对 | `9fa8f69e` / `74ea9b4a` | 09:13:27.465 | `472650bbad4a916f2ad75c61d033a37a5307c27017706678575ec1fcf1c47651` |
| 下一步初稿，保留纠偏记录 | `4be46dcb` / `de23ab4b` | 09:14:24.400 | `7fa7a3688b99fd404f9bf996fc6bef81c698502c68e3026e3b4c3ab55b98ae24` |
| 下一步修订 | `aa67495b` / `0d5a8b08` | 09:15:56.629 | `8f299c67247d7fd2084db0062d9924d949e26b45b519436142f74d6ca8a71a60` |

三条实际 assistant 均为 `provider=bigmodel`、`model=glm-5.3-flash`、`api=openai-completions`、`stopReason=stop`，用量非零，无工具调用、provider 参数或历史结构错误。自定义模型未配置计费单价，Pi 的 cost=0 不能解释为官方调用免费。本次证明固定版本和该真实样本的原生连续性，不表示模型永不偏离要求，也不代表其他 Pi 版本已兼容。

### 重开、正式桌面幂等及配置核对

- 独立原生 helper 严格解析、`SessionManager.open/list/buildSessionContext` 回读通过：同一 Session ID、cwd=A、`listed=true`、15 个 tree entry / 16 行 JSONL；上下文 11 条（5 条原历史 + 3 轮新增问答）。原先 `!!pwd` 为 excludeFromContext 记录，不算模型问答。
- 全部 5 条旧历史的角色、正文、顺序逐条一致；原始导入 11314 bytes 前缀及补验前 11747 bytes 文件前缀 hash 均未变。新增消息按 `user → assistant` 追加，没有伪造回复或重置历史。
- 正式打包 UI 复跑 migration `bfe0aab3-f466-43cb-8eaa-857c741dc046`，原生回读 `reused=true`，打开入口仍为 `terminal-session`。三轮真实问答保留；复跑前后目标文件均 20815 bytes，SHA-256 均为 `883003513a59349f8c03361d8c07f80564b8d1b0adde535a53b90421694403de`。
- 用户授权配置后重新取得基线；真实续聊、重开、重复迁移前后 Codex 与 Pi 配置指纹全部相同。复跑 journal 的组合 MCP/配置指纹为 `9951e21b9db1ee6dd6b5b3d2b1f9d887124227a7848761b1f6a56b076b9414e7`。不能与配置模型前的旧基线混比。
- Codex 源文件始终为 1184934 bytes、mtimeMs=`1788316135291.303`、SHA-256=`6330c398ae02eacb7e21e39f588723f19ed147c71bec8b05e9ec669874e97811`。
- 新一轮 `npm run check && npm run build && IDE_HUB_PI_INTEGRATION=1 npm test` 通过：54 项，53 通过、1 项无关 ZCode 安装包测试未启用；Pi 集成目录 `.../T/idehub-pi-native-fCiHsH`。312 个仓库跟踪/未忽略文件检查未发现本次临时 Key，auth 权限确认为 0600。

完整问题、可见回复、前后指纹和断言结果仅保留本机：`~/Library/Application Support/IDE Hub/migrations/bfe0aab3-f466-43cb-8eaa-857c741dc046/pi-continuity-verification.json`；同目录还有 `pi-native-readback.json`、`journal.jsonl`。正式桌面截图和结果在 `/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-pi-desktop-rpLozc/`。

自动迁移结果仍保持 `modelInvoked=false` / `continuationVerified=false`，因为迁移自身不发消息。这里的人工实现方实际续聊验收单独记录，不将一次样本验收伪装为每次迁移自动验证。Pi 目标当前无剩余外部阻塞；Pi 作为源、ZIP、MCP 和扩展事件投影不在本合同范围。未 commit/push。
