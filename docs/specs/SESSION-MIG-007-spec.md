---
contract_id: SESSION-MIG-007
version: 2
status: ready
route: direct
source_revision: ide-hub@5fec7f141392f2bfa85267eb5953f7ad62f38b2b+user-2026-09-11-dec-001-approved
---

# Codex → Claude Code 同工作区会话迁移

## Source baseline

- 本轮用户要求（2026-09-11）：研究 Claude Code 会话原理，将 Codex 会话迁入 Claude Code；源工作区为 A，目标也必须属于 A；本机缺少 Claude Code 时允许安装。
- 已确认的用户补充：会话必须能在目标原生产品中打开、继续上下文，不能把 Markdown 塞进一条新消息冒充迁移；实现方负责实际续聊验证。正式界面沿用 `prototype/`，会话迁移与全局 MCP 配置迁移完全分开。
- [总方案](../ide-hub-implementation-plan.md) §1、§2.3、§6、§7、§8.2、§8.3 Claude Code、§10～§13、§18；文件 SHA-256：`d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb`。
- 工程快照：`5fec7f141392f2bfa85267eb5953f7ad62f38b2b`。当前已有六个目标的迁移核心、Electron IPC 和正式 `prototype/` 渲染层；Claude Code 尚是产品占位。
- DEC-001 已批准（2026-09-11）：用户明确回复“解除这一旧约束”，确认允许锁定已验证版本、只新建独立 Claude Code 原生会话的离线 JSONL 历史投影；不允许覆写用户既有会话。
- 冻结规则：以上批准取代总方案 §8.3 Claude Code 的“永不生成或覆写 Claude 私有 JSONL”在本迁移目标上的绝对禁写要求，也取代 §4.2、§18 中与该批准冲突的禁写表述；只放开已验证结构的新建会话写入，不放开未知结构或其他产品写入。原总方案保留为来源快照，本合同及用户批准为本能力的最新基线。原生历史、A → A、源只读、MCP 独立及真实续聊要求不变，不回退为 Markdown 交接。

## Objective

在正式 IDE Hub 桌面选择 A 目录下的真实 Codex 会话，预览后迁移成 Claude Code 的独立原生会话。历史中的可见 user/assistant 消息保留角色、正文和顺序；在 A 打开后可以直接承接上下文，不要求用户重新说明。

最短闭环：选择真实源会话 → 固定 A → 预览历史与损失 → 确认迁移 → 原生列表/历史回读 → 打开确切目标 → 两轮真实续聊 → 关闭重开。重复迁移和失败恢复仍须交付，不因该闭环较短而删去。

## Background

当前 Claude Code 尚未接入迁移目标。研究尚未找到满足完整离线历史导入的官方写入接口；官方 SDK 的读取、分叉和 SessionStore 接口不能直接代替 Codex 历史导入。用户已批准新建原生 JSONL 会话，因此原方法约束不再阻塞开发；研究基线为 Claude Code `2.1.170` 和配套 SDK `0.3.170`，具体落盘、原生恢复及真实续聊仍按下列验收执行。

## Changes

| ID | Product behavior | 方案依据 |
| --- | --- | --- |
| CHG-001 | 发现本机 Claude Code，展示实际版本、安装和兼容状态；接入现有 Codex 详情、目标选择、预览、执行、结果和打开入口。已安装时不重复安装。 | 本轮安装授权与迁移要求；总方案 §4.1、§8.2、§11；用户 prototype 补充 |
| CHG-002 | 源工作区规范化后的 A 固定为目标会话归属和恢复进程工作目录；不是 Git 根目录、Hub 目录或另一个 worktree。 | 本轮明确 A → A；现有 `src/workspace.ts` 的同目录行为 |
| CHG-003 | 按已批准的版本锁定 JSONL 投影新建独立 Claude Code 原生历史，完整保留可见文本消息；显示可辨认的 Codex 来源标题、来源对应关系和损失报告，不用单条种子提示替代多轮历史。 | 本轮迁移要求；用户原生历史补充及 DEC-001 批准；总方案 §1、§6、§7.4 |
| CHG-004 | 目标会话可以通过 Claude Code 原生入口找到、打开并恢复；实现方验证旧上下文问答、承接下一步、退出重开后的持续可用性。明确实际打开的产品界面，不能把 CLI 成功描述成 Claude Desktop 或 IDE 扩展成功。 | 用户原生打开及实现方真实续聊要求；总方案 §11、§13.2、§13.4、§18 |
| CHG-005 | 日常扫描、预览、迁移、回读不调用模型、不要求 Hub API Key，源会话及 MCP 配置保持不变；Claude Code 后续对话使用其自己的模型和认证。 | 用户本地应用、无需 Key、MCP 独立要求；总方案 §2.3、§7.1、§9、§10、§13.2 |
| CHG-006 | 同一源快照重复迁移复用正确目标并保留目标新增聊天；失败明确报告，可依现有迁移记录恢复或精确清理，不影响其他会话。 | 总方案 §1、§8.2、§12、§13.2；已有目标迁移行为 |

## Out of scope

- 此能力不实现 Claude Code 作为源、反向迁移、实时同步、跨会话合并、跨电脑 ZIP 或 MCP 配置迁移；总方案中的相关产品需求保持独立，不删除入口或冒充已实现。
- 不迁移 Claude Desktop 普通聊天、Cowork 或云端会话；不新建 Web 服务、替代聊天客户端、第三方代理或 Context Bridge 配置。
- 不复制隐藏推理、源产品 system prompt、账号凭据、批准状态、运行中工具和进程、原生文件回退 checkpoints；不重放历史命令或工具调用。不修改 Claude Code 安装包和用户项目规则文件。

## Constraints

- 继续使用本地 Electron + 现有 `prototype/` 和窄 IPC；其余目标和未实现页面保持现状。会话流程不调用 MCP 配置迁移编排器。（总方案 §5、§9、§11）
- 迁移为 copy/fork，源端只读，沿用当前冷会话与一致性快照检查。A 使用现有 canonical path 和目录身份校验；扫描、预览、发布、回读与打开必须解析到同一目标数据根。（总方案 §1、§7.1；本轮 A → A）
- 原生正文与归档分开：全部可见文本进入历史，工具及非文本不可移植项明确计入损失/归档，不静默丢弃，也不伪造 assistant 回答或待执行工具。历史完整保存不等于保证模型单次窗口容纳无限历史；迁移阶段不调用模型压缩。（用户原生历史补充；总方案 §6、§7.2、§7.4）
- 总方案 §8.2 的版本及结构验证仍适用。已核实的安装版本为 Claude Code `2.1.170`；配套研究 SDK 为 `@anthropic-ai/claude-agent-sdk@0.3.170`。版本号、SDK 能读取、CLI 能恢复、真实续聊是不同证据，不能互相替代。
- 按 DEC-001 已批准的方法，仅为本次迁移新建独立 session ID 和原生 JSONL，锁定已验证的版本与字段结构；不覆写用户既有会话，不因重复迁移重建已续聊的目标。模型未配置不是离线迁移的产品前置条件。（用户 DEC-001 批准；总方案 §2.3、§8.2、§12）
- 复用现有源快照、投影、迁移记录、幂等和错误表达，不另起后台任务系统。重复导入检查已迁入的历史及其归属，不能因为目标续聊后文件 hash 改变就覆盖整份历史。（总方案 §12；现有迁移行为）
- 验证结果分清“历史已导入/回读通过”和“真实续聊通过”；未执行后者不得显示全部验收完成。续聊本身与离线导入分阶段验证，不由每次迁移自动发送测试消息。（总方案 §2.3、§13.2、§13.4、§18）

## Acceptance

### AC-001 — 正式桌面入口与发现

- Given: Hub 扫描出真实 Codex 会话，Claude Code 已安装；另有未安装和未验证版本场景。
- When: 在正式桌面选择 Claude Code 并预览迁移。
- Then:
  1. 显示实际版本、固定工作区、消息预览、损失、实际写入对象和打开方式；仍是原有 prototype 界面。
  2. 预览不创建目标会话；未安装/不兼容时原因明确，不能显示可执行迁移。
- Required evidence:
  1. 打包桌面的操作截图或演示及版本探测结果。
  2. 预览前后目标会话文件清单，以及未安装/版本不兼容分支测试。
- 方案依据: CHG-001、CHG-003；用户 prototype 补充；总方案 §8.2、§11。

### AC-002 — A → A 与确切目标

- Given: 源 cwd 为 `/Users/domino/develop/IdeaProjects/temp`；另覆盖同目录符号链接、路径含空格/中文和无效目录，目标有默认或自定义数据根。
- When: 迁移、打开并恢复目标会话。
- Then:
  1. 目标目录归属、消息 cwd 和恢复后的实际工具工作目录规范化后都是 A。
  2. 打开的是迁移回执中的目标 ID；自定义数据根不会导致转到默认根下的空会话。
  3. 无效目录或 B 目录不会被静默替换为其他目录后创建会话。
- Required evidence:
  1. 源 cwd、目标 cwd 回读及目标原生执行只读 `pwd` 的结果；路径测试。
  2. 回执 ID、原生打开后的同 ID 记录及自定义根测试。
  3. 目录错误结果和目标未产生错误归属会话的断言。
- 方案依据: CHG-002、CHG-004；本轮 A → A；现有 workspace 校验；总方案 §13.4。

### AC-003 — 原生历史不缺轮、不串角色

- Given: 合成源包含普通多轮、连续同角色、相同时间戳、只有 user、长文本及非文本/工具事件；另有一个真实 Codex 源快照。
- When: 按已批准的 JSONL 投影新建目标后严格检查完整载荷，并通过目标原生读取路径读取会话。
- Then:
  1. 目标有独立 ID、可辨认的来源标题和完整可恢复的消息关系。
  2. 可见正文的数量、角色、顺序、换行及内容与源投影一致；长历史不套用 seed 窗口截断，只有 user 的历史不补假回答。
  3. 损失/归档项与源事件对应，来源标记不伪装成模型消息或模型使用量。
  4. 坏行、缺父节点或重复消息 ID 不得以“SDK 返回了部分消息”为由通过完整性验收。
- Required evidence:
  1. 独立目标 ID、原生会话信息及消息关系检查结果。
  2. 逐条正文/角色对照与计数，以及只有 user、长文本的落盘重开结果。
  3. 源事件和 Loss Report 对照。
  4. 损坏输入的拒绝结果；不能只用内存 SDK 探针代替落盘及原生恢复验证。
- 方案依据: CHG-003；用户反对单条 Markdown 的补充及 DEC-001 批准；总方案 §6、§7.4、§8.2、§13.1；研究中的断链静默少读事实。

### AC-004 — 原生列表、打开与重开

- Given: 会话已迁入 A，目标原生运行环境可用。
- When: 点击 Hub 的打开入口，在 Claude Code 的原生历史入口找到该会话，再退出并恢复。
- Then:
  1. 列表可辨认该会话；打开后可见迁移的多轮历史且可继续输入，不是空会话或待发送的 Markdown。
  2. 退出重开仍是同一个目标 ID，历史不丢失。
  3. UI 和证据准确标注打开的是 CLI、IDE 扩展或其他已验证入口；若提供 IDE 扩展入口，必须在该扩展实际验收，不能用 CLI 演示替代。
- Required evidence:
  1. 实际目标界面的列表/历史演示及原生回读。
  2. 退出前后目标 ID 与消息对照。
  3. Hub 按钮、目标界面及对应版本的证据；明确未验证的其他界面。
- 方案依据: CHG-001、CHG-004；用户原生打开要求；总方案 §11、§13.2、§13.4。

### AC-005 — 实现方完成真实续聊

- Given: 已恢复的迁移会话包含总方案 §13.2 的 sentinel：目标、约束、否决方案、文件改动、已通过/未运行验证、未解决问题和下一步；Claude Code 已有可用模型。
- When: 实现方在目标原生界面询问不含答案的旧上下文问题，再要求执行一个明确下一步；随后退出重开。
- Then:
  1. 第一轮正确引用旧事实，不把已完成和未完成状态混淆。
  2. 第二轮承接正确下一步，不重复已完成工作；不是仅返回会话载入成功。
  3. 新增问答属于同一目标 ID，重开后仍存在；未出现历史结构导致的请求错误。
- Required evidence:
  1. 源事实对照与真实第一轮问题/回答。
  2. 第二轮问题/回答及与下一步相符的实际结果。
  3. 原生界面记录与重开后的持久化消息对照。
- 方案依据: CHG-004；用户要求实现方验证真实续聊；总方案 §13.2、§13.4、§18。

### AC-006 — 离线迁移与配置独立

- Given: 安装完成，迁移进程禁网，Hub 没有模型 Key；记录源与两端 MCP 配置基线。
- When: 完成扫描、预览、导入及回读；另覆盖目标尚未配置模型的场景。
- Then:
  1. 导入不需要模型请求或认证，也不借安装/打开目标之机自动发送提示。
  2. 源会话、两端 MCP 配置不被迁移改变，不复制源模型 Key/登录态到 Claude Code。
  3. 目标无模型时，历史导入结果与真实续聊未验证状态分开显示，不把没有模型错误归因为历史损坏。
- Required evidence:
  1. 禁网运行与实际进程调用记录；不能仅用 `modelInvoked: false` 自证。
  2. 源与 MCP 前后指纹、迁移写入清单及相关负向测试。
  3. 无模型场景的导入/回读结果和准确状态提示。
- 方案依据: CHG-005；总方案 §2.3、§7.1、§9、§10、§13.2。

### AC-007 — 重复迁移、失败与精确恢复

- Given: 同一源快照已迁移，目标已新增聊天；另模拟发布或迁移记录中断、目标历史损坏。
- When: 重复迁移，或按迁移记录恢复/清理失败任务。
- Then:
  1. 正确目标被复用，不新增重复会话，不覆盖目标续聊。
  2. 损坏目标不被判为成功复用；失败阶段和原因明确，半截结果不显示完成。
  3. 恢复/清理只涉及本次目标及其迁移产物，不影响源、其他会话和 MCP；目标已续聊时不自动删除这些新增数据。
- Required evidence:
  1. 同一目标 ID、迁移前后历史及新增消息对照。
  2. 发布/记录中断和损坏目标测试结果。
  3. 精确恢复/清理结果、无关数据对照和已续聊目标保留断言。
- 方案依据: CHG-006；总方案 §1、§8.2、§12、§13.2；用户 DEC-001 批准中的不覆写限制。

## Traceability

| Change | Acceptance |
| --- | --- |
| CHG-001 | AC-001、AC-004 |
| CHG-002 | AC-002 |
| CHG-003 | AC-001、AC-003 |
| CHG-004 | AC-002、AC-004、AC-005 |
| CHG-005 | AC-006 |
| CHG-006 | AC-007 |

## Open decisions

- None.

## Sources and evidence

### 会话原理与接口核实

以下为 2026-09-11 的研究事实；writer 方法现已由 DEC-001 批准，但不代表原生落盘、恢复或真实续聊已经通过。

| 研究对象 | 已核实事实 | 对本能力的影响 |
| --- | --- | --- |
| 本机安装 | `~/.local/bin/claude` 指向 `~/.local/share/claude/versions/2.1.170`，`claude --version` 返回 `2.1.170 (Claude Code)`。没有在已检查的 VS Code/Cursor 扩展目录发现官方 Claude Code 扩展。 | 不需要安装或升级 CLI；不能拿 Claude Desktop 版本当作 Claude Code 协议版本，不能声称 IDE 扩展已经验收。 |
| 本地路径 | 默认 `~/.claude/projects/编码后的工作目录/会话UUID.jsonl`；`CLAUDE_CONFIG_DIR` 可改变数据根。SDK 0.3.170 路径 helper 先规范化目录，非 ASCII 字母数字转换为 `-`；编码长度超过 200 时还有截断与路径 hash 后缀。 | A 的默认目录键是 `-Users-domino-develop-IdeaProjects-temp`。不能仅替换 `/`，不能把同键视为目录身份相同；长路径算法须与固定版本核对。 |
| 本机 2.1.170 记录结构 | 主会话消息记录含 `type`、`uuid`、`parentUuid`、`sessionId`、`cwd`、`timestamp`、`isSidechain`、`message` 等；user 的 `message` 有 `role/content`，assistant 还可有 `id/type/model/stop_reason/stop_sequence/usage`。同一文件还有附件、队列和标题等事件。研究只输出字段名，不复制真实正文。 | 消息正文并非整行 JSONL；不能直接复制 Codex rollout。模型、用量和来源字段不能把 Codex 记录冒充成 Claude 实际生成的回复。最小字段充分性仍需目标运行时验证。 |
| 历史链 | SDK 0.3.170 使用 `parentUuid` 关系恢复历史；磁盘 reader 还有 compact boundary 等处理。`isSidechain`、标题/摘要会影响列表。磁盘读取和 SessionStore 读取走不同函数。 | 完整原始记录与恢复后上下文不同；不要复制造假的压缩事件或私有 system 根。必须校验关系完整性，不只比较“能 JSON.parse”。 |
| 标题/索引 | 配套 SDK 的 `renameSession` 追加 `custom-title` 事件；`listSessions` 扫描项目 `.jsonl` 并提取首尾元数据，不依赖 `sessions-index.json`。 | 不应凭旧教程额外生成索引数据库。SDK 列表结果不等于 CLI picker 或 IDE 历史已经可见。 |
| 官方恢复 | CLI 帮助支持 `--resume`、`--continue`、`--fork-session`；原生指定 ID 恢复应从 A 启动。官方文档说明 `-p`/SDK 创建的会话与交互 picker 有显示区别。 | 打开应使用回执中确切 ID，不能用“最近会话”误开其他记录。打开不附带 prompt，正常续聊不应再自动 fork。 |
| IDE 扩展 | 官方 IDE 文档说明扩展与 CLI 可共享历史；会话文档又区分不同入口的历史。此机未完成扩展侧验证。 | 以具体安装版本的原生列表、打开和续聊为准，不把 CLI 的成功扩大成所有界面兼容，更不混入 Claude Desktop 普通聊天。 |
| 官方 SDK | 0.3.170 提供 `listSessions/getSessionInfo/getSessionMessages/renameSession/forkSession/importSessionToStore`。`forkSession` 的输入是既有 Claude 会话；`importSessionToStore` 是本地 Claude transcript → store，不是 Codex → 本地原生会话的导入器。 | SDK 的公开名称不能作为“已有官方跨产品导入 API”的依据。 |
| SessionStore | `SessionStoreEntry` 的具体联合结构由 CLI 内部定义，SDK 要求透传；store 是 transcript 存储适配。通过 store resume 使用临时配置目录，结束后清理该副本。 | 手工合成 entry 再交给 store，并不能规避私有 schema 问题，也不直接产生用户正常数据目录中的持久原生入口。无需为本地迁移添加云存储。 |
| 新版 `/import` | 当前官方命令文档中的 `/import` 搬运其他产品的配置，包括规则、MCP、命令、子代理和技能；CLI 文档标注始于 2.1.213。 | 不是本机 2.1.170 的完整会话导入接口；也不符合会话与 MCP 独立的操作范围，不为此升级并执行它。 |

### 已完成的研究验证及其限度

在 macOS 内核禁网条件下，仅调用配套官方 SDK 的内存 SessionStore、list/info/message helpers：

- 24 条合成 user/assistant 消息，包含连续 assistant、相同时间戳、空格、换行和 emoji；回读 24 条，角色和 message 对象逐条一致，列出 1 个会话，cwd 为 A、标题可读。
- 只有 user 的 1 条历史也能被内存 list/read 返回。
- 将第 11 条消息的父节点改成不存在的 UUID，内存 reader 没有报错，只返回后 14 条。这证明“SDK 调用成功”不足以证明完整迁移；不是对磁盘 reader 或 CLI 的同等故障结论。
- 研究阶段没有发布 Claude 用户会话文件、启动真实续聊或改变认证/MCP 配置；CLI picker、IDE 扩展、磁盘写入后的恢复与 API 接受性均未验证。当前 `status: ready` 表示合同决策齐备、可以进入开发，不表示这些实施阶段的验收已通过。

### 工程复用位置

当前适配器中 Pi 与本能力最接近：复用 [Codex reader](../../src/codex/reader.ts)、[可见正文抽取](../../src/seed-context.ts)、[目录身份](../../src/workspace.ts)、[迁移产物](../../src/artifacts.ts)、[迁移编排](../../src/migration.ts)、[Pi 目标](../../src/pi/migration.ts) 的组织方式。必需差异是 Claude 的路径键、UUID 父子链、原生恢复与列表筛选，不能复制 Pi 的 `SessionManager`/v3 header，也不能沿用 Qoder 的合并 assistant 轮次或 Cursor blob 协议。

接入点已经存在于 [请求类型](../../src/types.ts)、[请求校验](../../src/request.ts)、[请求 schema](../../schemas/session-migration-request-v1.schema.json)、[结果 schema](../../schemas/session-migration-result-v1.schema.json)、[CLI](../../src/cli.ts)、[Electron 主进程](../../desktop/main.cjs)、[preload](../../desktop/preload.cjs)、[渲染层](../../prototype/app.js) 和 [桌面打包](../../desktop/package.mjs)。writer 使用 DEC-001 批准的版本锁定原生 JSONL 投影，SDK 用于配套回读验证；不把这些接入路径另立为用户功能。

测试继续使用 [package.json](../../package.json) 中的 `npm run check`、`npm run build`、`npm test`，参照现有 [Pi 测试](../../test/pi.test.ts)、[Pi runtime 测试](../../test/pi-runtime.test.ts) 和 [桌面契约测试](../../test/desktop-contract.test.ts)。真实续聊独立验证，不由普通测试或合成 fixture 的通过替代。

### 来源索引

| Source | Revision or date | Confirmed facts used |
| --- | --- | --- |
| 本轮用户要求及原生历史/prototype/MCP 独立补充 | 2026-09-11 及本会话已确认需求 | 迁移方向、A → A、必要时安装、真实历史、正式桌面与连续性验收 |
| 用户批准 DEC-001：“解除这一旧约束” | 2026-09-11；本合同 version 2 | 允许锁定已验证版本、新建独立 Claude Code 原生 JSONL；不覆写既有会话；取代本目标的旧绝对禁写约束 |
| [总方案](../ide-hub-implementation-plan.md) | 完整 SHA-256 见 Source baseline | 产品公共约束、旧 Claude 禁写规则和验收标准 |
| [进度总控](../ide-hub-master-progress.md)、上述工程文件 | `5fec7f141392f2bfa85267eb5953f7ad62f38b2b` | 已有六个目标、Claude 未接入，以及实际复用位置 |
| [官方会话文档](https://code.claude.com/docs/en/sessions) | 2026-09-11 访问 | JSONL 数据根、按目录恢复、CLI picker 与 SDK 会话的区别 |
| [官方 IDE 文档](https://code.claude.com/docs/en/ide-integrations) | 2026-09-11 访问 | CLI/扩展历史关联及图形入口；不作为本机扩展实测证据 |
| [官方 SDK 会话文档](https://code.claude.com/docs/en/agent-sdk/sessions)、[SessionStore 文档](https://code.claude.com/docs/en/agent-sdk/session-storage) | 2026-09-11 访问 | 本地持久化、cwd、存储适配与临时目录恢复语义 |
| [官方命令文档](https://code.claude.com/docs/en/commands)、[CLI reference](https://code.claude.com/docs/en/cli-reference) | 2026-09-11 访问 | 新版配置 import 的范围与版本，不误认为会话 import |
| 本机 CLI 的 `--version/--help` 及少量现有 JSONL 字段结构 | `2.1.170`；二进制 SHA-256 `e903646d8b7a31882a80ecd27569a27d8ac57b3708745f349709632c84117fdf` | 已安装、恢复参数、实际事件字段；不发布用户历史正文 |
| [官方 SDK 包](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.170) 的 `package.json`、`sdk.d.ts`、`sdk.mjs` | `0.3.170`，包声明 `claudeCodeVersion=2.1.170`；`sdk.mjs` SHA-256 `df0b264f1cc6e147cf6de071a994f859b2be736fc83ff13ce54533a5328d48a9`；`sdk.d.ts` SHA-256 `f2bde31953c76ae0af033e8be4dd1bd9ee3172f2f066c674b0c127b298ee1941` | 路径/链/列表/标题/存储接口；只下载到临时研究目录，未加入项目依赖 |
| 同包导出及本轮内存探针 | SDK `0.3.170`；2026-09-11；`sandbox-exec` 禁止网络 | 正常 24/24、user-only 1/1，断链返回 14/24；不是落盘或真实续聊 Gate |
| 最新官方 SDK 导出对照 | npm `0.3.268`，对应 `2.1.268`；2026-09-11 | 同样不能将 `importSessionToStore` 当跨产品原生写入器；不扩大本机支持版本 |
