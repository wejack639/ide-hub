# SESSION-MIG-005 开发与验收记录

日期：2026-09-09；真实续聊补验：2026-09-10。合同：[Codex → ZCode](../specs/session-migration-005-codex-to-zcode.md)。实现方：Codex。

结论：原生离线导入、同工作区、全量回读、桌面发现/预览、失败恢复与幂等已实现。2026-09-10 模型阻塞已解除：实现方已重启 ZCode、打开原会话并发送一轮不含答案的上下文问题；真实回复准确命中旧历史，续聊后重复迁移仍保留全部 13 条记录。**整体验收暂未全部通过**：AC-005 要求的第二轮“继续下一步”尚待发送，当前桌面控制对 ZCode/访达均报 `cgWindowNotFound`，不是模型不可用。无需给 IDE Hub 配置 Key。

## 实现范围与依据

- 最近似实现：复用 Codex reader、可见消息抽取、workspace、artifacts、现有迁移编排与 Electron IPC。与 Qoder 的必需差异：ZCode 接收逐条消息，不合并连续 Assistant；与 DSH 的差异：无需安装 bridge，使用已安装 ZCode 自带 app-server。
- 新增生产模块仅 `src/zcode/{discovery,client,protocol,storage,migration}.ts`；接入 types/request/schema、迁移路由与原型渲染层。没有新增依赖、全局配置、Web 服务或独立 CLI 安装。
- 原生 `session/create(importedHistory)` 写正文，新进程 `session/resume`、不限条数的 `session/messages` 验证磁盘历史。仅桌面 `tasks` 元数据精确插入，正文没有生产 SQL writer。
- `source=claudeCode` 只是当前原生 strict schema 要求的兼容字段；标题、lineage、源 ID 与 hash 始终标记 Codex，预览明确说明不是官方 Codex 支持。
- 稳定目标 ID 由源文件 hash、thread ID、canonical workspace 与适配协议版本计算；自有 ledger + SQLite 进程锁保证复跑不重写已经发布或续聊的历史。原生库与索引不是一个事务，备份使用 SQLite backup API 包含 WAL；失败后恢复同一目标，不整库还原。
- 迁移所启动的 Codex 与 ZCode 子进程分别由 `sandbox-exec deny network*` 阻断网络。ZCode 使用独立临时配置，仅投影现有模型名称/协议种类，不复制 Key/URL/headers/MCP。已发现原生初始化会预复制 bundled plugins，因此同时隔离其目录可见性并禁止其他子进程执行；没有修改 ZCode 安装包。
- 桌面打开使用已验证的 `--open-workspace A` 和原生单实例参数转发。能力是“打开项目，按标题定位会话”，不是一键精确打开 Session。
- 不实现 ZIP、MCP、ZCode 源扫描、跨版本兜底、真实模型代配置或全库回滚。

## 安装基线

| 项目 | 已验证值 |
| --- | --- |
| 目标 | macOS ZCode 3.10.2 / 内置 CLI 0.16.5 / `dev.zcode.app` |
| backend SHA-256 | `3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc` |
| app.asar SHA-256 | `95ba9f23c40a45821494a3d0168f3fb8a3ef5fab9b36ee1ae22cdb9a8f98f804` |
| session/message/part schema SHA-256 | `959f9fa8d56eb57a0398bcaef6d3b2b67fb2d4b1c7291fae3fc864bc605890f3` |
| tasks schema SHA-256 | `f4ba383f4f962e2d7485ab2861420a60123f65014da93db03cde46ab1f310e5b` |

未知版本/指纹在原生创建前拒绝。Electron 的 asar 虚拟文件系统必须通过 `original-fs` 读取物理安装包，已用真正 Electron main 进程回归，未使用全局 `process.noAsar` 开关。

## 自动验证

```sh
npm run check
npm test
IDE_HUB_ZCODE_INTEGRATION=1 node --import tsx --test test/zcode-runtime.test.ts
npm run build
node_modules/.bin/electron test/zcode-electron-probe.cjs
npm run desktop:package
```

- 常规测试：48 通过，1 个显式开启的原生集成测试默认跳过；无失败。类型检查、JS 语法检查、`git diff --check` 与最终桌面打包均通过。
- 原生集成单独执行通过：隔离真实数据库、安装包原生 RPC、131 条消息（连续 130 条 Assistant、相同时间戳）、全量首尾回读、关闭进程再恢复；正文已成功而索引尚未写入时故障注入，复跑恢复同一 ID。
- 在隔离测试库追加 1 条明确标记为 fixture 的后缀，原生复跑回读 132 条且没有 `session/create`，用户标题保持不变。该后缀由测试 SQL 构造，**不是实际模型续聊**，生产 writer 不使用该路径。
- 最终原生集成证据目录：`/private/var/folders/mk/5nd3d76j7dn7x9v0mgqmv_880000gn/T/idehub-zcode-runtime-B3dMDp`，60.3 秒完成；此前 `idehub-zcode-runtime-BVre1m` 同样通过。
- 单测额外验证：版本/目录拒绝、预览无原生写入、源 hash 幂等、角色/顺序/长度错误、工具与附件损失、索引冲突、原生 traceId 必填，以及复跑不覆盖用户标题/状态。

## 真实源和目标

| 字段 | 值 |
| --- | --- |
| Codex Thread | `01a05feb-7d16-7000-b06e-f4e1a4d43ea2` |
| 标题 | `Codex · https://github.com/mosonlab/anneal 帮我分析一下这个项目，spec要怎么写好的？` |
| 源/目标目录 | `/Users/domino/develop/IdeaProjects/temp` |
| ZCode Session | `sess_idehub_3d23d31cadaa63b5f29182b1a896d2181942c779243e901c9ade0f044d819f8a` |
| 可见历史 | 5 条，1 个源 turn，7270 bytes；未丢弃可见正文 |
| 明示损失 | reasoning 16、commandExecution 23；不复制执行状态 |
| 源文件 SHA-256 | `6330c398ae02eacb7e21e39f588723f19ed147c71bec8b05e9ec669874e97811` |
| 首次完成 migration | `e8574ab5-a252-4e48-97e6-8f9c9e98142f` |
| 完整后置指纹复核 migration | `2eb7e778-77c4-494a-85bf-9e6ea3185ebe` |
| Electron main 真实预览及复跑 | `8ed170ef-7d9d-4588-81cf-679e45b34537`，5 条原生消息回读通过 |
| 正式桌面 7 步向导实际迁移 | `cf701981-b819-4790-8c3d-08d6c3916cb9`，同一目标 ID、1 turn / 5 messages、模型调用否、MCP 修改否 |

每次记录在 `~/Library/Application Support/IDE Hub/migrations/<migration id>/`：`source-snapshot.json`、`zcode-history.json`、`zcode-native-readback.json`、`zcode-task-readback.json`、`zcode-rpc-calls.json`、`journal.jsonl` 与结果。首次写入另有两库 backup。原生 readback 的 Workspace、SQL `directory/path`、索引 `workspace_key/workspace_path` 均为同一 temp 目录。

`2eb7e778...` 的 journal 已记录 `POST_CONDITIONS_VERIFIED`，源文件 size/mtime/hash 不变，MCP 前后指纹一致；目标 MCP hash 为 `fbd526a2dff88c7a414281ff5ec0120121aab3c53e51177a97dae9a21bb15be1`。指纹校验会读取配置内容做 hash，但不迁移、修改或输出其内容，不能宣称完全“不读取配置”。

## 桌面与连续性 Gate

| Acceptance | 本轮状态 |
| --- | --- |
| AC-001 | 通过：正式桌面发现、固定目录、实际全量预览与损失；未知版本无写入测试 |
| AC-002 | 通过：真实 temp 全链路同目录；B 拒绝与通用 symlink/失效路径测试 |
| AC-003 | 通过：原生新进程全量恢复 131 条，连续 Assistant 与同时间戳保持顺序 |
| AC-004 | 通过（2026-09-10）：退出并重启 ZCode，新的 launch marks 下从 temp 列表重新打开同一任务，原始正文和用户新增问答均显示；原生回读同 ID/路径 |
| AC-005 | 部分通过（2026-09-10）：实现方已实际发送第一轮上下文问题、真实回复命中全部指定旧事实且落盘；第二轮明确下一步与回复的补充 UI 取证因桌面控制 `cgWindowNotFound` 尚未完成 |
| AC-006 | 通过：迁移子进程网络阻断、源/MCP 前后指纹和原生调用记录；不把用户随后打开的 ZCode 桌面自身联网计为离线迁移阶段 |
| AC-007 | 通过（2026-09-10）：已在真实续聊后复跑 `bcbe0c92...`，同目标 ID、13 条记录逐条相同，不调用 session/create；此前中断恢复测试通过 |

- 正式打包 `.app` 扫描 214 条真实 Codex 会话，发现 ZCode 3.10.2；temp 源会话可选择 ZCode，工作区不可改。通过预览 IPC 显示实际 5 条独立消息、兼容说明以及 23/16 项损失，不创建目标会话。
- 最终包重新启动后，在 Codex 扫描子进程也阻断网络的条件下读取 215 条真实会话，ZCode 3.10.2 兼容状态正常；该新增会话数来自当时本机扫描，不是演示数据。
- 已在正式向导逐步确认损失与写入计划并执行迁移，结果显示上述 `cf701981...`；点击“打开 ZCode 工作区”调用真实 IPC。结果文案明确打开项目而非自动定位 Session。
- ZCode 实际任务列表已显示上述 Codex 标题；点击进入后显示原始 Anneal 问题及 Product Contract 分析（含 Direct / Full Assurance、六段式合同结构），不是空任务或输入框里的 Markdown。
- 发现并修复原生桌面索引必需 `traceId`：直接来自 `session/resume`，不是自造值。开发期同 lineage 的旧索引只补这个字段，不改正文、标题或更新时间。
- 2026-09-09 的“无可用模型”阻塞已在次日解除，详见下节。仍不将一轮成功等同于合同要求的两轮连续性全部验收。

## 2026-09-10 真实续聊补验

用户明确告知模型已配置并授权实现方验证。ZCode 仍为指纹匹配的 3.10.2，使用用户选择的 `智谱GLM-5.3-flash/GLM-5.3-Flash`。没有复制或改写模型凭据；续聊由 ZCode UI 发起，离线迁移器依然禁止发送模型请求。

1. 补验前，目标已有 11 条原生记录：5 条迁移前缀，加用户切模型、旧套餐失败记录和成功问答等 6 条后缀。全部作为基线保留，不清理用户历史。
2. 通过原生 UI 退出 ZCode，再启动；`mainStart` 从 `1788951108136` 变为 `1789011778819`。从 temp 项目列表点击同一 Codex 标题，截图/可访问性树显示原始 Anneal 分析以及用户新增“spec要写好的要素都有哪些”的问答，输入区显示已配置模型。
3. 实现方实际点击发送以下问题（英文仅为规避桌面控制中文输入缺字；未提供答案，不允许读文件/联网/调用工具）：

   > Answer in Chinese using only our existing conversation. Do not browse, read files, or use tools. Which project and commit did the original analysis cover? How did we choose between the two execution routes? What should happen when major product decisions remain ambiguous? Which spec field or page was storage and display only, not an execution driver? Be concise and do not guess missing facts.

4. 真实回答正确指出 `mosonlab/anneal`、`6aafb9c`，Direct 对应一次上下文可完成且改动完整枚举，Full Assurance 对应多模块独立切片；重大歧义应暂停由人决策；Goals 的 `spec` 仅存储展示，任务卡 `description` 与模板实例化才驱动执行。以上均能在最初迁移正文中对照，不是问题中给出的答案。
5. 新 user ID：`msg_mtuzjszp_d5f7187f-6fae-4935-8000-aa174e2f0204`；新 assistant ID：`msg_mtuzjt0x_f833e074-d4fd-475d-82a5-a07509d19ddc`；原生 parentID 对应本轮 user，`finish=stop`、`error=null`，时间为 2026-09-10 11:46:33～11:46:47（北京时间）。回答正文 SHA-256：`3142a44e67971eefa8d847948fe03dffcb8894f11940ded67ed80b0a19ee9bfa`。
6. 使用新离线原生进程恢复、全量回读，目标变为 13 条，原 11 条逐条相同。再通过真正 Electron main 运行同源快照迁移，migration `bcbe0c92-d7f4-4a1d-b73c-fd7b8ad2afff` 复用原目标；13 条的 ID、role、正文、finish/error 全部与续聊后回读一致，包含用户原有成功/失败记录。调用记录只有 resume/messages 及原生 preferences 请求，**无 session/create**，源与 MCP 后置校验通过。
7. 第二轮尚未发送：第一轮之后 UI 控制对 ZCode 和访达均出现 `cgWindowNotFound`；按名称/bundle 重连、重置控制会话、Dock 恢复均未解决。已请用户仅恢复可见解锁桌面，不要求用户代发消息。第二轮仍应由实现方在同一 UI 会话要求整理旧订单确认例子的最小规格，核对字段/409/无副作用验收后再复跑。

本地证据：`~/Library/Application Support/IDE Hub/zcode-continuity-20260910-m1rm4B/{before,first-reply}.json` 和上述 migration 下的 `zcode-native-readback.json`、`zcode-rpc-calls.json`、`journal.jsonl`。取证入口 `test/zcode-continuity-probe.ts` 仅作原生恢复/读取，不发送消息或创建历史。本轮 `npm run check`、`npm run build`、48 项常规测试与 `git diff --check` 通过（原生长历史测试仍需显式启用，前次证据保留）。

## 开发中修复的实际问题

1. 原生 app-server 为 strict NDJSON 协议，不能额外传 JSON-RPC 版本字段。
2. 原生插件目录复制发生在 enabled 判断之前；仅设置关闭插件不能证明离线轻量启动。
3. 外层包整条迁移命令与内层 sandbox 会嵌套失败；改为源/目标独立子进程阻断，不撤销离线限制。
4. 后端协议 shutdown 后可能残留定时器；限时退出仅针对自有迁移子进程，不结束用户 IDE。
5. `tasks.meta_json.traceId` 缺失导致桌面 schema 报错；已用原生值补齐并回归。
6. Electron `.asar` 虚拟读取导致安装发现失败；已在真实 Electron main 中验证物理 hash 和整条迁移核心。

本记录不将 ZCode 整体 Gate 标为 DONE，也不修改原始 spec 的产品要求。
