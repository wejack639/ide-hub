# SESSION-MIG-007 开发与验收记录

日期：2026-09-11。基线：[spec v2](../specs/SESSION-MIG-007-spec.md)，用户已批准新建独立原生 JSONL。

结论（2026-09-11 17:03 补验）：**普通交互 TUI 直接发送已通过。** 沿用用户现有 CCSwitch → deepseekv4.1flash，在 Claude Code 2.1.268、2.1.170 分别完成两轮真实问答、Bash `pwd` 和退出重开；源目录与目标目录始终为 A，没有改 Key、模型或 CCSwitch 配置。2.1.170 已验证基线的 AC-001～007 完成。另须区分：本机默认 CLI 现已是 2.1.268，现有迁移器仍只允许向已验证的 2.1.170 写入，因此 **2.1.268 已有会话续聊通过，不代表正式桌面已支持向该新版新迁移**。本轮没有放宽版本检查或降级用户安装。

## 改动范围

- 最近似案例：Pi 的离线 helper、独占文件发布、迁移前缀回验及续聊后幂等；Claude 必须改用 UUID、自己的目录编码、parentUuid 链和原生 CLI 恢复，不复用 Pi session 格式。
- 预计新增 `src/claude/` 下 discovery/protocol/helper/runtime/migration 五个模块；修改已有请求类型/schema、CLI、迁移编排、MCP 指纹、Electron IPC、prototype 和打包入口。
- 新依赖仅固定版本官方 `@anthropic-ai/claude-agent-sdk@0.3.170`，用于原生只读回读；本机 Claude Code 2.1.170 已安装，无需升级。原生结构、失败恢复及路径测试沿用 Node/tsx。
- 不新增后台任务系统、其他产品适配、MCP/模型配置迁移、ZIP 或新 UI；不修改用户已有会话。真实模型验证使用 Claude Code 自己已有配置。

## 验收状态

| AC | 状态 | 已有证据 / 未完成项 |
| --- | --- | --- |
| AC-001 | 通过 | 正式打包 prototype 七步向导；真实发现、完整正文/损失/文件路径预览、确认写入；未安装/不兼容分支测试；预览不创建目标 |
| AC-002 | 通过 | 源 canonical cwd、目标每条消息 cwd、官方 SDK、实际启动进程 cwd 和原生 `!pwd` 均为 A；符号链接、特殊路径、错误目录及自定义数据根测试 |
| AC-003 | 通过 | 131 条长历史落盘与独立 SDK 回读逐条一致；连续同角色、user-only 不补假回答；坏行、重复 UUID、断链拒绝；真实源 5 条完整保留 |
| AC-004 | 通过（2.1.170 基线） | 打包桌面打开、CLI picker 发现及同 ID 历史恢复通过；本轮普通 TUI 两轮直接发送成功并退出重开，新增问答仍可见。未验证 Claude Desktop/IDE 扩展 |
| AC-005 | 通过（2.1.170 基线） | 普通 TUI 经现有 CCSwitch 完成旧事实问题及明确下一步，实际 Bash pwd 返回 A，退出重开与同 ID 持久化通过；2.1.268 另完成相同入口补验 |
| AC-006 | 通过 | 整个真实迁移 CLI 在内核禁网策略下完成；无认证的隔离 config 根亦能导入/回读。源/MCP 前后指纹一致，迁移未复制或调用 Key |
| AC-007 | 通过 | 发布中断恢复、同快照复用、损坏拒绝和精确回滚通过；两轮真实成功问答及工具结果后，正式 UI 复跑保持同 ID 和完整文件 hash，原始前缀及所有新增记录保留 |

迁移结果保持 `modelInvoked=false`、journal 保持 `continuationVerified=false`。一次实现方验收也不会让每次迁移自动发消息或宣称自动验证续聊。

## 实现与使用

- 新增固定版本 `src/claude/{discovery,protocol,helper,runtime,migration}.ts`；复用既有源快照、Capsule、可见消息抽取、目录身份、Loss Report、journal 与错误结构。
- writer 只独占发布本次独立 UUID 的完整 JSONL，不写旧会话、索引数据库或模型配置。记录线性 `parentUuid`、原始角色/正文/顺序和独立 `custom-title`；完整来源映射位于 Hub 的 `claude-provenance.json`。
- 历史 `model=ide-hub/codex-history`、`usage=0` 是来源/未知用量占位，不是 Claude 真实生成或计费用量。原生 CLI 实测提示不能恢复该模型标识，改用用户默认模型。没有伪造 Claude 模型名、system 根或隐藏推理。
- 原始 JSONL 全行与链完整性校验先于官方 SDK。配套 SDK 独立 helper 只调用 `getSessionInfo/listSessions/getSessionMessages`，不调用 `query`、登录或模型。helper 与 Codex App Server 使用 `sandbox-exec (deny network*)`。
- 会话数据根在发现、计划、发布、回读和终端恢复一致。默认路径为 `~/.claude/projects/<Claude 编码的 canonical A>/<UUID>.jsonl`，不把 Git 根目录当作 A。长目录键采用固定 SDK 的截断/hash 算法。默认终端启动不强行注入 `CLAUDE_CONFIG_DIR`：即使设为 `~/.claude` 也会改变全局状态文件选址；只有用户显式自定义数据根时才传入。此差异已补测试并修复。
- intent ledger 与完整待发布产物先持久化，目标独占发布；中断复跑恢复同一 ID。重复迁移严格核对原始导入前缀并保留新增记录，不以当前整文件 hash 变化为理由覆盖。
- 正式界面入口：选择 Codex 会话 → **迁移到 Claude Code** → 查看完整投影/损失/实际 JSONL 路径 → 确认迁移 → **在终端中打开 Claude Code 会话**。实际使用 `cd A`、一致的数据根和 `--resume <确切 ID>`；不发送 prompt，不使用 `--continue`、`--fork-session` 或绕过权限选项。
- Claude 结果页新增“回滚本次导入”：确认后只删除原始内容仍完全一致的本次目标；已有续聊或原生状态变化时拒绝。源、其他会话和 Hub 归档保留，因此可重新迁移。失败发布可通过同一源快照重试恢复。
- 打包只携带固定只读 SDK JS/helper，不携带 SDK 的另一份 CLI 二进制。最终 `.app` 约 293 MiB；归档检查无 `.agent/.agents/.windsurf` 私有目录。没有改全局 Git 配置、提交或推送。
- 修正 spec 从根目录移动到 `docs/specs/` 后的相对链接，不变更合同要求。

## 自动化和真实离线验证

```sh
npm run check
npm run build
IDE_HUB_CLAUDE_INTEGRATION=1 npm test
npm run desktop:package
IDE_HUB_CLAUDE_REAL_THREAD=01a05feb-7d16-7000-b06e-f4e1a4d43ea2 \
  IDE_HUB_CLAUDE_OPEN=1 node test/claude-desktop-probe.cjs
```

首轮测试 59 项：57 通过，2 项无关 Pi/ZCode 安装包集成未启用，0 失败；类型、构建、JavaScript 语法和 `git diff --check` 通过。Claude 集成目录：`/private/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-claude-native-eUDGAi`。131 条长历史超过 seed 窗口、空模型配置、自定义根、符号链接、只有 user、中断和已有新增后缀均实际落盘读取；合成后缀不是模型证据。后续启动参数修复的最终测试为 60 项、58 通过、2 跳过，见下文。本次仅补验和更新文档，未重跑完整测试套件。

整个真实迁移进程另在内核禁网策略下运行成功，不仅依赖结果字段自证：

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  node dist/src/cli.js session migrate --source codex --target claude-code \
  --thread 01a05feb-7d16-7000-b06e-f4e1a4d43ea2
```

该次 migration `1986efb4-2cd9-4516-97b7-7c34959d92ed` 完成，退出码 0。没有安装、升级 Claude Code 或创建 Hub 模型配置。

## 真实源与桌面证据

| 对象 | 证据 |
| --- | --- |
| A | `/Users/domino/develop/IdeaProjects/temp` |
| Codex Thread | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` |
| 源历史 | 1 个 source turn，5 条 user/assistant，7271 bytes 可见正文；16 项 reasoning、23 项 commandExecution 仅归档 |
| Claude Session | `2f28f86f-533a-88c2-a2f1-cfd128e7bfdb` |
| 原生文件 | `~/.claude/projects/-Users-domino-develop-IdeaProjects-temp/2f28f86f-533a-88c2-a2f1-cfd128e7bfdb.jsonl` |
| 首次真实迁移 | `f7d815a7-dcbd-41c0-a3c9-07d18282be85` |
| 正式桌面打开/复跑 | `229cc5c9-6be1-4df1-a717-2adc709a9708`，`reused=true`，通过真实渲染按钮触发打开 |
| 桌面复跑文件一致 | 打开之前前后 hash 均为 `cd3daf892962c2e122a3a0058989eb9b5a6539e041601c4dc07e3b3c85480e05`；含原生失败问答/运行记录，无新重复目标 |
| 源未改 | 1184934 bytes，mtimeMs `1788316135291.303`，SHA-256 `6330c398ae02eacb7e21e39f588723f19ed147c71bec8b05e9ec669874e97811` |
| 配置未改 | 上述桌面 migration 的组合 MCP 指纹 `295608f38fdd279616615e372ac6870748630b9641d72d058c071930e1110306`，journal `POST_CONDITIONS_VERIFIED` |
| 实际打开进程 | 桌面按钮启动 `.../claude/versions/2.1.170 --resume 2f28f86f-533a-88c2-a2f1-cfd128e7bfdb`；当时 PID 8704，`lsof -a -p 8704 -d cwd -Fn` 返回 A；取证后只停止该测试进程 |
| 原生列表 | 在 A 启动 CLI `--resume` picker，显示 `temp` 和 `Codex · https://github.com/mosonlab/anneal ...`；选中实际恢复，旧正文与失败问答可见 |
| 实际本地工具 | 同一恢复会话输入 `!pwd`，原生 shell-mode 返回 A；没有模型调用，不计为 AC-005 第二轮 |

正式桌面截图已实际查看：`/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-claude-desktop-RryVGk/` 下 `preview.png`、`write-plan.png`、`result.png` 和 `result.json`。首次 UI 证据另在 `.../idehub-claude-desktop-bU4NLn/`。保留原型布局、导航以及 ZIP/MCP/任务中心的未实现入口。

原生交互界面使用实现方拥有的 PTY 验证，未通过 Terminal.app UI 访问限制绕行取图，也不把 IDE Hub 截图说成 Claude 原生截图。真实源正文、原生 JSONL、完整截图和迁移产物只保留在本机，不提交到公开仓库。

一次并行调试的桌面探针在 CLI 同时恢复会话时检测到目标文件 hash 变化，因此失败；关闭该原生写入者后，串行重跑 hash 一致通过。没有为使测试通过删除原生新增记录或放宽幂等校验。

## 首轮交互尝试（历史记录，不能泛化为代理不可用）

实现方已从迁入历史发出第一轮问题：询问此前项目/固定 commit、路线与输入、Goals spec 的执行语义、否决写法、人决策边界，以及文件改动/测试是否有事实记录。问题没有提供答案，要求只依据历史、不读文件或联网。CLI 返回 `Not logged in · Please run /login`，没有模型成功回答；失败问答保留在同一原生会话。

只读排查结果：

- `claude auth status` 返回 `loggedIn=true, authMethod=api_key`，仅证明检测到 Key 来源，不是交互认证可用证明。
- 现有 `~/.claude/settings.json` 配置了 API Key 和模型；`~/.claude.json` 的 `customApiKeyResponses.rejected` 命中这把现有 Key，approved 未命中。只比较并输出布尔结果，不记录 Key 或片段。
- 已安装 CLI 的交互路径受 approved 状态影响；这只解释 TUI 提示，不能推出其他原生 CLI 调用也不可用。后来确认被识别的值是 CCSwitch 的代理占位符 `PROXY_MANAGED`，并非用户真实上游 Key。
- 当时询问启用 Key 是不必要的扩展；用户明确要求沿用 CCSwitch 直接聊、不改 Key。本轮已用现有路由完成真实调用，没有修改批准列表、凭据、模型或代理配置。

## CCSwitch 原生真实续聊补验

用户明确当前使用 CCSwitch 接 DS V4.1 Flash。进程 1314 的实际数据库是 `~/.claude/cc-switch.db`，不是旧 `~/.cc-switch/cc-switch.db`；只读查询确认 Claude 当前 provider 为 `deepseekv4.1flash`，本地代理监听 `127.0.0.1:15721`。没有读出或复制该 provider 的上游凭据。

在 A 使用已安装的 Claude Code 2.1.170 执行两次 `-p <问题> --resume 2f28f86f-533a-88c2-a2f1-cfd128e7bfdb --output-format json`。不传模型/认证覆盖、不改用户配置；仅测试调用按轮次禁用无关工具/MCP。第一轮禁止工具，第二轮只提供 Bash 并允许 `pwd`。这是 Claude 自己的实际模型与持久化路径，不是直接 HTTP 拼接历史或伪造回复。

1. **旧事实问题**不含答案：回复正确给出 Anneal、固定 commit `6aafb9c...`、Direct/Feature Brief、Full Assurance/Product Contract、Goals 仅保存展示而由任务 description/模板驱动执行，以及否决模糊需求、人决策边界。明确旧可见历史无文件改动或测试通过记录，没有把建议伪装为已完成。
2. **明确下一步**：要求先 `pwd`，再沿用旧订单例子写六段最小 brief。原生 Bash 实际返回 A；回复保留相同 orderId/requestId 重复返回第一次结果，以及同 requestId 跨 orderId 返回 409 两条旧规则，Changes 与 Acceptance 对应，未确认现状明确写待确认，没有实施代码或增加重试/事务规则。

| 回复 | 原生 assistant UUID | 时间 UTC | 可见正文 SHA-256 |
| --- | --- | --- | --- |
| 旧事实核对 | `4123950c-b960-4755-8d0a-949b09ca3228` | 08:30:54.218 | `bf4b703008b51efe52f66394a59927a413b17b315d09b3a342d5eba753d05570` |
| 下一步 brief | `7132bfec-e0d0-4a2f-9afa-05c1f4727c75` | 08:32:17.682 | `1fb85a0bbae6c81521bdc0cc73e09b13a25619b446d1d1f06204d7ea6800bcd4` |

CCSwitch 的三条对应请求（第一轮 1 次、第二轮工具前后共 2 次）均 `status_code=200`、`model=deepseek-flash`、相同目标 Session ID：`ee454088-083a-4f1b-a655-e5dbd8d63a04`、`a3703048-d6b6-4b37-adf5-49ff1bbf448f`、`1445568b-0574-4e15-a41f-db8a01f252a2`。CLI 的请求别名为 Claude Opus，不能据此把真实路由说成 Anthropic；代理记录及实际原生 assistant 的 model 均确认是 DeepSeek。CLI 按 Claude 别名估算的费用也不作为真实上游账单。

### 重开与幂等

- 两次 print 进程均成功退出，随后新交互 TUI 从同一 A、同一 ID 恢复，实际显示第二轮 brief 和 shell 执行记录；21 条官方原生回读消息、完整逐行/父链校验通过。
- 在 TUI 再发一条简短核对问题仍返回 `Not logged in`，这一失败记录同样保留。故这里确认的是 **CLI print 两轮真实续聊 + TUI 重开显示**，不是普通 TUI 发送也已成功。
- 正式打包 UI 复跑 migration `98f19990-f8bd-46a4-800f-16f6ca804377`，前后目标 hash 均为 `fd6675801f198fa36ff6eae4f8943a5d0500cd07bf1faff193c5c5df24e8e8e0`；独立断言全部 5 条迁入正文与源角色/文本一致，原始导入字节前缀不变，真实两轮、Bash 工具结果及失败记录全部保留。
- 完整可见问答、工具、代理请求元数据和断言证据仅在本机：`~/Library/Application Support/IDE Hub/migrations/98f19990-f8bd-46a4-800f-16f6ca804377/claude-continuity-verification.json`；不复制新生成的模型隐藏推理。
- 桌面截图/结果：`.../T/idehub-claude-desktop-TQkNXK/`。本轮补了默认/自定义配置根启动回归，58 项测试通过，2 项其他产品安装包集成未启用；类型、构建和打包通过。最终 Claude 隔离集成目录 `.../T/idehub-claude-native-wHffKP`。
- 启动参数修复后的正式桌面打开再验通过：migration `e63f5382-b033-4032-8cbc-dfaa5c529194`，截图/结果在 `.../T/idehub-claude-desktop-IusSDW/`。实际按钮启动确切 `--resume` ID，进程 PID 18732 的 cwd 为 A；测试完成后只停止该进程。

该轮用户要求不改 Key 已遵守；未将修改认证设为真实模型测试的前置条件。当时普通 TUI 发送仍未通过，后由下面的实际补验解除。未 commit/push。

## 普通 TUI 直接发送补验（登录阻塞已解除）

用户回复“再试吧，应该可以了”后，先探测当前默认 CLI 为 2.1.268，再显式使用仍在本机的已验证 2.1.170。两版均从 A 用普通 `--resume 2f28f86f-533a-88c2-a2f1-cfd128e7bfdb` 启动，在交互输入框实际发送两条消息；没有使用 `-p`、更换 Key/模型或修改批准列表。

- 第一轮只问旧事实、不提供答案、不调用工具。两版均正确回答 Anneal、固定 commit、两条路线与输入、Goals spec 不自动执行、订单两条规则，并明确无已改代码或已通过测试记录。
- 第二轮承接旧订单例子，先实际执行唯一的 Bash `pwd`，结果为 `/Users/domino/develop/IdeaProjects/temp`；2.1.268 写“准备—操作—观察结果”，2.1.170 写两个 Given/When/Then 场景。均保留两条旧规则、未知项待确认，不实施开发、不声称测试通过。
- 两版均 `/exit` 正常退出，再从 A 重开同 ID，在原生 TUI 实际显示新增回复。之后退出全部本轮拥有的 TUI 进程，未停止用户自己的 Claude 进程。

| CLI / 回合 | assistant UUID | UTC | 可见正文 SHA-256 |
| --- | --- | --- | --- |
| 2.1.268 / 旧事实 | `1a570e36-f104-446b-b8a3-780b05d0883a` | 08:58:00.993 | `071c33ab5833712c960264ab12a9b11058dacac77307bab131e3af4410c9f8b6` |
| 2.1.268 / 下一步 | `57ed8868-4c9e-4f0b-ab2d-0a16cd20fd48` | 08:58:58.868 | `aacec0cfb477bb3ae4ba3903e7ce02c689cd99823efcc80fb2c1e3bed7731f74` |
| 2.1.170 / 旧事实 | `2fddd6a1-8ec2-418a-aabc-571eba5a620f` | 09:00:45.277 | `1cb3bae604c336be1a94c77fb18894b8eda7fb72950804517883c0ac5a2ef00e` |
| 2.1.170 / 下一步 | `37951178-a1a3-4f3e-bff5-ecda8b14bbe5` | 09:01:36.546 | `ea9c7db86cb46e29c7f56fd797c0dc51fcb047f448a32c7f30465a564e4219e6` |

该时间段同 Session 的 8 条 CCSwitch 请求日志均为 HTTP 200、`model=deepseek-flash`；包含工具前后及原生附加请求，不把请求数说成对话轮数。`settings.json` 指纹前后仍为 `7b17bb99831b70c40b6ed7ad55a5d5c24718f0755c823e59a32883c9b44575f0`。

关闭 TUI 后，通过真实迁移核心显式发现已验证 2.1.170 复跑：migration `4bf308a2-2353-445a-9dd2-ab857f6f860c`，`reused=true`，同一目标 ID；前后完整文件 SHA-256 均为 `45bedda3fd6b9bc0495e27f0189152f335948d660a0b8f37a82c1e2011d6867e`。原始导入字节前缀未变、5 条源正文及角色逐条一致、Codex 源 SHA 未变，严格链校验及官方 SDK 的 40 条消息回读/列表通过。此轮是核心复跑，不冒充 2.1.268 正式桌面复跑。

本机证据：`~/Library/Application Support/IDE Hub/migrations/4bf308a2-2353-445a-9dd2-ab857f6f860c/claude-tui-continuity-verification.json`，只收录本轮可见问答、pwd 工具、代理非敏感元数据及断言结果。此前失败记录没有删除。

版本范围：默认发现实际返回 `compatible=false`、`当前支持 Claude Code 2.1.170，发现 2.1.268`；显式发现 2.1.170 返回兼容。新版新迁移/正式桌面入口的适配是独立待办，不能仅凭旧文件续聊成功解除 writer 版本校验。本轮未改生产代码、用户配置、CLI 默认指向，未 commit/push。
