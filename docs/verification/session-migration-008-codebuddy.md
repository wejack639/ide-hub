# SESSION-MIG-008 开发与验收记录

日期：2026-09-14。合同：[Codex → CodeBuddy 国际版 / CodeBuddy CN](../specs/SESSION-MIG-008-spec.md)。

当前结论：双目标迁移、正式桌面入口、两版官方 Import 和真实连续性 Gate 均已跑通。国际版 `4.12.0` 与 CN `4.11.2` 都把同一 Codex 样本导入 A 对应的原生 History；两版随后分别完成“旧事实 → 明确下一步”两轮真实续聊，关闭聊天页后又从 History 打开同一 Session。Hub 按目标版本日志、`originalId/id`、A 的 MD5 分区、request/message 关系及逐消息正文回读到全部新增问答。尚未执行的是 AC-008 要求的两版真实官方删除演示；实现和负向测试已就绪，当前证据会话保留。

## 实现范围

- 新增 `src/codebuddy/{discovery,protocol,storage,migration}.ts`。国际版和 CN 使用独立 installation profile、bundle、构建 commit、内置扩展 SHA-256、用户数据日志根和目标 ID 前缀；共享的只有无产品状态的 archive encoder/validator。
- 生成 CodeBuddy 官方 `codebuddy.conversation` schema version 1 单会话 JSON。逐条保留全部可见 User / Assistant 正文、角色、顺序和换行；不补 system/tool/assistant，不写模型、用量、账号或 Key。超过 20 MiB 直接失败，不截断或回退 Markdown。
- 迁移固定由 Codex cwd 解析 canonical A，使用所选 App 自带 desktop launcher 的 `--reuse-window A` 打开正确版本，不调用 `buddy chat` / `buddycn chat`。归档就绪后返回 `WAITING_TARGET_IMPORT`；用户完成官方 History Import 且原生回读全部通过后才返回 `COMPLETED`。
- 幂等映射按目标版本、源 thread、源文件 SHA-256、canonical A 和协议生成。同目标同快照复用同一原生会话，并严格保留、校验目标新增 request/message；两版不能互相认领。
- 正式 `prototype/` 中增加两个独立产品项、会话详情入口、七步向导、真实预览、等待 Import、检查完成、打开 A、Finder 定位归档和恢复入口。ZIP、MCP、任务中心仍保持独立未实现页面。
- 恢复不直接删除 CodeBuddy 私有 History。Hub 先核对确切 mapping 与新增聊天计数；有续聊时默认拒绝。用户明确同意后在所选版本官方 History 删除，Hub 只有确认工作区索引与目标目录均消失才撤销本次幂等映射。源、归档、其他会话、另一版本和 MCP 不变。

## 真实样本与官方 Import

| 对象 | 国际版 | CN |
| --- | --- | --- |
| App / bundle | CodeBuddy 4.12.0 / `com.tencent.codebuddy` | CodeBuddy CN 4.11.2 / `com.tencent.codebuddycn` |
| 产品 commit | `b4c35ed08ffb428910211608831a314565c1256e` | `74e2511a9221f313959fc19c58e81bcd78a85950` |
| 内置扩展 | `Tencent-Cloud.coding-copilot` 3.10.0，SHA-256 `964850...b7cb9` | 3.10.0，SHA-256 `a3276e...eed08` |
| A | `/Users/domino/develop/IdeaProjects/temp` | 同左 |
| Codex Thread | `01a09ea2-685f-7a22-b1b8-65ae8a972150` | 同左 |
| 可见源投影 | 1 request / 3 messages / 475 bytes | 同左 |
| A workspace hash | `ddeeefc6f16dec28a88cd7b815127bca` | 同左 |
| Archive ID | `idehub_cb_intl_ef6165fc7cba9be3a59319f46c2418aeb9a19b036bf42438c1673301c8f9da93` | `idehub_cb_cn_68ede1a6b4ba5982babd69366f28b44bda1aac8623d1e0e3d26f0786396fea81` |
| 官方 Import | 目标提示成功；Hub migration `c7fcd9f4-56b3-4f77-9bd6-9012dd860eaf` 首次认领完成 | 目标提示成功；Hub migration `c8e5e7fa-8980-4d87-a773-84dde44a5006` 首次认领完成 |
| 续聊后最终回读 | migration `b9ead839-f6b4-4b86-8643-359a84d5e888`；同一目标 ID；3 条导入消息 + 4 个目标 request / 8 条目标消息，4 轮均完整 | migration `76483121-b619-420c-b582-0b8741f7bc5f`；同一目标 ID；3 条导入消息 + 2 个目标 request / 4 条目标消息，2 轮均完整 |
| 连续性 | 旧事实、下一步、关闭聊天页、History 重开均通过 | 旧事实、下一步、关闭聊天页、History 重开均通过 |

两次目标均由其官方 Import 写入；Hub 未直接修改 `CodeBuddyExtension/Data/**/history`。国际版目标路径属于账号分区 `c460...`，CN 属于 `d202...`，二者最终工作区目录名均为 A 的上述 MD5，但目标 ID 前缀和产品日志证据独立。真实正文、完整日志与本机 History 文件不提交到公开仓库。

首次启动研究暴露了一个实际问题：`--new-window --suppress-popups-on-startup A` 的进程参数存在但窗口日志显示 workspace 为 `(none)`。实现已改为本机验证能打开 A 的 `--reuse-window A`，并有源码契约测试禁止重新引入 suppress 参数。

## 两版真实连续性 Gate

两版均在回执指向的 `[IDE Hub · Codex] 查询北京10月软考报名时间` 原生会话中发送以下两轮，不在新问题中携带答案，也不允许浏览：

1. `Use only the migrated history in this conversation and do not browse: at what date and time did Beijing's 2026 second-half software exam registration close?`
2. `Continue from the migrated history and your last answer. In one sentence, tell me the single most important next step to take now; do not browse or repeat the background.`

源历史事实是报名截止时间 `2026-09-17 23:59`，且验收当天仍在报名期。国际版第一轮正确回答 `2026年9月17日 23:59（北京时间）`，第二轮承接为立即到官方平台完成报名和缴费；CN 第一轮给出相同截止时间并明确说明只依据既有历史，第二轮承接为立即登录官方平台完成报名与缴费、不要拖到截止前。两版均未重新要求背景。

每一版完成后都先关闭当前聊天页，再从 Show Chat History 点击确切迁移标题重开。重开后原始 3 条迁移消息和上述 2 轮新增问答仍在同一消息树；最终 Hub 原生回读分别确认国际版 4 个、CN 2 个目标新增 `complete` request，所有新增消息均有唯一 ID、合法关系和非空 User / Assistant 正文。国际版的 4 轮包含语义 Gate 前已有的 2 轮普通问答。

## 两版官方 Export 协议证据

完成续聊后，又分别通过两版 History 的官方 Export Conversation 导出同一目标会话，并由当前 `parseCodeBuddyArchive` / `decodeCodeBuddyArchiveMessages` 直接解析：

| 版本 | 本机导出文件 | SHA-256 | 原生内容 |
| --- | --- | --- | --- |
| 国际版 4.12.0 | `codebuddy-international-idehub-continuity.json` | `5f54f4746a83c7cf0db5de6b668160f5886b0e9ef2f116fff635ce51bcad78a0` | 5 requests / 11 messages；原生后缀含毫秒时间戳 `startedAt`、8 项 usage、message `extra`，assistant core 为 text block |
| CN 4.11.2 | `codebuddy-cn-idehub-continuity.json` | `10bebf68ecb76cbccb5681c9198fb1b07555bbc8897c8f3d9e2f74a2a970db37` | 3 requests / 7 messages；原生后缀另含 assistant `providerOptions` 及 reasoning/text blocks |

这两个原始文件含用户会话正文，只保留在本机、不提交公开仓库。测试中固化的是脱敏后的字段形状、usage 白名单、可见 text 解码规则和非法 `startedAt` 负向样本；迁移 encoder 自身仍不生成 model、usage、providerOptions 或 reasoning。

## 自动化验证

常规入口：

```sh
node --check prototype/app.js
node --check desktop/main.cjs
node --check desktop/preload.cjs
npm run check
npm test
npm run build
```

当前套件共 71 项：68 通过、3 项既有可选安装包 Gate 跳过、0 失败。CodeBuddy 覆盖：

- 双版本独立身份、精确版本/commit/扩展指纹和 launcher 参数。
- 中文、emoji、换行、连续 Assistant、user-only、不可移植事件、确定性 ID 和跨版本隔离。
- schema/version/ID/core role/重复 ID/20 MiB 负向校验，generated archive forbidden fields 断言，以及两版官方 Export 原生后缀的脱敏结构回归。
- `WAITING_TARGET_IMPORT → COMPLETED`、目标版日志证据、A/B workspace hash、逐消息文件回读、幂等复用及目标新增消息保留。
- 两轮完整目标 request 的结构识别，覆盖 CodeBuddy 原生 assistant metadata `isComplete=false`、request `state=complete` 的实际形状。
- 回滚默认保留含续聊会话、明确确认分支、官方删除前保持 pending、官方删除后只撤销本次 mapping。
- 正式 Electron 窄 IPC、双目标界面、等待 Import 和恢复操作契约。

迁移结果始终保持 `modelInvoked=false`、`mcpChanged=false` 和 `continuationVerified=false`。该字段只表示“迁移器没有自动调用模型作语义判定”；Hub 可以只读报告目标新增轮次是否完整持久化，但不会把结构存在自动判定为回答语义正确。AC-006 已由上面的实现方真实问答和重开证据独立通过。

## Gate 状态

| AC | 状态 | 说明 |
| --- | --- | --- |
| AC-001 | 通过 | 两版独立发现、兼容状态、正式 prototype 入口和不安装 CLI 均已实现；截图仍只保留本机 |
| AC-002 | 通过 | encoder/validator、两版官方 Import、forbidden-field 检查及两版官方 Export 回读通过；含目标原生续聊后缀的脱敏结构已固化为回归测试，原始正文 fixture 不进入公开仓库 |
| AC-003 | 通过 | 两版真实 A → A、bundle/版本独立、workspace MD5 回读；B 误导入拒绝测试通过 |
| AC-004 | 通过 | 真实 3 条源消息与两版原生逐条回读一致；合成连续角色、user-only 和损坏关系覆盖；两版关闭聊天页后均从 History 重开并保留完整消息树 |
| AC-005 | 通过 | 等待态、确切 `originalId/id`、目标专属确定性 ID、重复迁移和新增后缀保留通过 |
| AC-006 | 通过 | 国际版和 CN 分别完成“旧截止时间 + 当前最重要下一步”两轮真实问答；两版都追加到确切目标 ID，关闭聊天页后从 History 重开成功，磁盘后缀完整回读 |
| AC-007 | 通过 | 迁移核心禁网、无 Hub Key、不调用 chat 子命令，源和三端 MCP 指纹不变；模型能力只影响独立续聊 |
| AC-008 | 部分通过 | 错误与恢复代码、负向测试和 UI 辅助官方删除核验已实现；两版真实官方删除演示未执行，以免在连续性 Gate 前删掉当前证据会话 |

未 commit/push。
