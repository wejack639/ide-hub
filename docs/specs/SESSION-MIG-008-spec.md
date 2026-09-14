---
contract_id: SESSION-MIG-008
version: 1
status: ready
route: direct
source_revision: ide-hub@58dfebd722460a0be66011739c70969b9820b7b7+user-2026-09-14-codebuddy-dual-target
---

# Codex → CodeBuddy 国际版 / CodeBuddy CN 同工作区原生会话迁移

## Source baseline

- 本轮用户要求（2026-09-14）：研究 CodeBuddy 国际版和 CodeBuddy CN 的会话原理，实现 Codex 会话分别迁入两个产品，并在目标端继续原上下文。
- 已确认的会话产品要求：源会话属于工作区 A，目标会话也必须属于 A；目标原生历史中必须存在可见的多轮 user/assistant 记录，不能把 Markdown 或总结塞进一条新消息冒充迁移；实现方必须完成真实续聊验证。
- 已确认的桌面与配置边界：正式入口继续使用 `prototype/` 落地的 Electron 本地桌面界面；会话迁移与全局 MCP 配置迁移是两个独立流程；IDE Hub 的迁移、导入和回读不调用模型、不需要模型 API Key。
- [总方案](../ide-hub-implementation-plan.md) §1、§2、§3、§5～§8、§10～§13、§18；文件 SHA-256：`d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb`。工程快照为 `58dfebd722460a0be66011739c70969b9820b7b7`，当前已有 Codex 源读取、统一可见消息投影、迁移产物、幂等记录、Electron IPC 和正式桌面渲染层；CodeBuddy 仍是未实现占位。
- 总方案第 93 行是 2026-09-01 的旧本机基线记录，不是本轮开发指令；总方案 §4.2 和 §8.3 中“CodeBuddy 目标只能走 Handoff”的旧结论，已被本轮对两套本机安装及其官方原生会话归档导入能力的验证取代。本合同只更新 CodeBuddy 目标策略，其余公共产品约束继续有效。
- 冻结规则：国际版与 CN 版是两个独立迁移目标和安装配置；二者可以复用归档编码核心，但不得混用 bundle、应用路径、启动命令、兼容指纹、迁移映射或验收结果。任何实现阶段的简化闭环均不得删去另一版本、A → A、原生历史、真实续聊、离线迁移、MCP 独立、幂等和失败恢复要求。

## Objective

在正式 IDE Hub 桌面中选择 A 目录下的真实 Codex 会话，分别以 `codebuddy-international` 或 `codebuddy-cn` 为目标，生成目标版本接受的 CodeBuddy 原生会话归档，并在 A 对应的 CodeBuddy 原生 History 中完成导入。导入后的会话保留可见 user/assistant 正文、角色和顺序，可以在目标原生聊天界面直接承接上下文，不要求用户重新说明。

最短闭环：扫描两版安装 → 选择真实 Codex 会话与其中一个目标版本 → 固定 A 并预览消息、损失和归档 → 生成原生 JSON 归档 → 无 prompt 打开该版本的 A → 用户在目标 History 执行官方 Import → IDE Hub 定位并回读确切目标会话 → 原生打开、两轮真实续聊、关闭重开。另一个版本必须独立跑完同一闭环，不能用一版的结果替代另一版。

## Background

本机同时安装了 CodeBuddy 国际版 `4.12.0` 与 CodeBuddy CN `4.11.2`。二者都内置 `Tencent-Cloud.coding-copilot` `3.10.0`，并都能从 History 导入单个 JSON 会话归档；国际版 `4.12.0` 另外支持 ZIP 批量导入。两版的 JSON 归档协议均为 `codebuddy.conversation` schema version `1`，单条归档上限为 20 MiB。

CodeBuddy IDE 历史不是 `~/.codebuddy/projects` 的 CLI JSONL，也不是应用根部当前为空的 `codebuddy-sessions.vscdb`。当前版本实际由内置扩展按账号分区和 `MD5(normalize(A))` 保存本地历史索引、请求索引及逐消息 JSON；官方 Import 会把归档写入执行导入动作的当前工作区。因此 A 不在归档正文中，迁移器必须先用正确的目标应用打开 A，并在导入后根据工作区键和归档来源 ID 校验归属。

当前桌面 CLI `buddy` / `buddycn` 是两版 IDE 的 VS Code 启动脚本，不是 CodeBuddy Code Agent CLI，也不需要单独执行 CLI 登录。它们可用于只打开 A；迁移流程不得调用带 prompt 的 `buddy chat` / `buddycn chat`。本轮未发现无需目标 UI 的公开 conversation-import 命令或 deeplink，所以首版使用 CodeBuddy 官方 History Import：IDE Hub 负责生成归档、打开正确产品与工作区、跟踪导入并严格回读，用户只在目标导入对话框确认文件。

## Changes

| ID | Product behavior | 方案依据 |
| --- | --- | --- |
| CHG-001 | 新增 `codebuddy-international` 与 `codebuddy-cn` 两个目标：分别发现实际 app、bundle、版本、内置扩展和启动脚本，显示“已安装 / 兼容 / 不兼容”的独立状态；已安装时不安装 CLI 或重复安装应用。 | 本轮“双版本”要求；总方案 §2.1、§8.2、§11；本轮本机安装研究 |
| CHG-002 | 正式 `prototype/` 产品列表、会话详情、迁移向导、预览、执行结果和打开入口分别呈现 CodeBuddy 国际版与 CodeBuddy CN；每次迁移只选择一个目标，不能把两版合并成同一状态或同时写入。 | 本轮“双版本”要求；已确认正式桌面要求；总方案 §5、§11 |
| CHG-003 | 将 Codex 可见历史编码为 CodeBuddy 原生 `codebuddy.conversation` v1 单会话 JSON：目标专属的确定性归档 ID、`craft` 会话、完整 request/message 关系和完成状态；保留可见 user/assistant 正文、角色、顺序和换行，不生成假 system、假 assistant、假 tool call、模型名或用量。 | 本轮原生迁移要求；已确认拒绝 Markdown 伪迁移；总方案 §1、§6、§7.2、§7.4；本轮归档 schema 研究 |
| CHG-004 | 迁移流程通过正确版本的启动脚本或 bundle 无 prompt 打开 A，生成并显示原生 JSON 归档路径，引导用户在目标 History 执行官方 Import；归档生成、等待导入、导入回读和完成是不同状态，不能在只生成文件或只打开 IDE 时返回 `COMPLETED`。 | 本轮迁移要求；总方案 §3 A、§7、§11、§13；本轮未发现外部 import 命令的事实 |
| CHG-005 | 导入后扫描 `MD5(normalize(A))` 对应的原生历史，以目标专属 `originalId/id` 找到确切会话，回读索引和逐消息正文并记录目标 ID。导入到 B、导入被取消、只出现空会话或正文不匹配时均不得完成。 | A → A 已确认要求；总方案 §7.1、§8.2、§12、§13.4；本轮本地 History 路径与 import 行为研究 |
| CHG-006 | 同一目标版本、同一源线程、同一源快照和同一协议版本重复迁移时，复用已导入的正确目标，不再次要求导入，也不覆盖目标新增聊天；国际版与 CN 使用不同幂等键和归档 ID。源快照变化时生成新的迁移版本，不改写旧目标。 | 总方案 §1、§8.2、§12、§13.2；本轮“双版本”要求 |
| CHG-007 | 在两个目标各自的原生 History 中找到、打开并恢复迁移会话；实现方分别验证旧上下文问答、正确承接下一步、同一目标 ID 新增消息及退出重开后的持续可用性。 | 已确认原生打开与真实续聊要求；总方案 §13.2、§13.4、§18 |
| CHG-008 | 扫描、预览、归档生成、导入跟踪和回读不调用模型、不读取或写入模型 API Key；源 Codex 会话和两端 MCP 配置保持不变。真正续聊只使用目标 IDE 已有账号与模型配置，并作为独立 Gate 记录。 | 已确认本地离线与 MCP 独立要求；总方案 §1、§2.3、§9、§10、§13.2 |
| CHG-009 | 对不兼容版本、归档超过 20 MiB、归档 schema/ID/消息结构错误、工作区错误、目标未初始化、导入取消和回读不一致给出明确阶段与原因；导入前可精确清理本次 Hub 归档。导入后仅在目标没有新增聊天时，通过目标官方 History 删除确切导入会话并由 Hub 验证消失；已有新增聊天时默认保留，只有用户明确确认连同新增聊天一起删除才进入官方删除流程。 | 总方案 §7、§8.2、§12、§13；本轮归档限制和官方 History 删除能力研究 |

## Out of scope

- 本合同不实现 CodeBuddy / CodeBuddy CN 作为源、反向迁移、实时同步、跨会话合并或两个目标的一键同时迁移。
- 不实现 IDE Hub 的跨电脑会话 ZIP、CodeBuddy 批量 ZIP 或 ZIP 格式互转；跨电脑导入导出保留为总方案中的独立功能。单会话目标迁移统一使用两版当前都支持的 JSON 归档。
- 不实现或修改 MCP 配置，不从会话中的工具记录推断 MCP，不安装 Context Bridge、CodeBuddy Code CLI、SDK、插件、模型或 API Key。
- 不迁移隐藏推理、产品 system prompt、账号登录态、OAuth/token、设备凭据、额度、未决权限审批状态、运行中 Agent/终端/任务、文件回退 checkpoint、附件二进制和不可等价的工具运行时；这些缺失进入既有 Loss Report，不静默伪造。
- 不直接写 `codebuddy-sessions.vscdb`、`genie-history` 占位目录或 `CodeBuddyExtension/Data/**/history` 私有文件，不修改 CodeBuddy 安装包。首版只生成官方 Import 接受的归档，由目标产品自己完成原生写入和删除。
- 不承诺 CodeBuddy 国际版与 CN 的账号、云端能力或模型完全等价；只承诺本合同中分别验证的本机会话迁移行为。

## Constraints

- 继续复用本地 Electron、现有 `prototype/`、Codex reader、工作区规范化、可见消息投影、迁移产物、journal、幂等记录和窄 IPC；不新建 Web 服务或另一套任务系统。（总方案 §5、§10～§12）
- 源会话始终只读。A 使用现有 canonical path 与目录身份校验；目标启动参数、导入时当前窗口、原生历史工作区 hash 和真实续聊工作目录必须指向同一 A。（总方案 §1、§7.1；已确认 A → A）
- 两版共享的只能是无产品状态的 archive encoder/validator。安装 profile 必须独立：国际版 `/Applications/CodeBuddy.app`、`com.tencent.codebuddy`、`buddy`；CN 版 `/Applications/CodeBuddy CN.app`、`com.tencent.codebuddycn`、`buddycn`。本机中央扩展数据根可能共享，不能据此把两个产品状态合并。（本轮本机研究；本轮“双版本”要求）
- 首批兼容指纹锁定国际版 `4.12.0` 和 CN `4.11.2` 及下方记录的内置扩展构建。后续版本只有在原生导出 fixture、导入、回读和真实续聊回归通过后才能加入支持矩阵；版本号相同但关键构建 hash 不同也须重新验证。（总方案 §8.2；本轮研究）
- 编码器必须以每个已支持版本原生导出的最小多轮 fixture 为 oracle，校验 envelope、conversation、request、message 与 core message 的字段形状；本合同记录的 validator 结构是实现依据，但不能用“JSON 能解析”代替原生 Import 和续聊。（总方案 §8.2、§13.1、§13.4；本轮研究）
- 每个归档恰好一个 conversation，UTF-8 编码且不超过 20 MiB。超过上限时拒绝执行并保留完整源快照和损失报告；不得静默截断、拆成多个目标会话或调用模型压缩。（本轮归档 validator；总方案 §6、§7.4）
- 用户在 CodeBuddy Import 对话框选择文件是当前官方入口要求，不是“待发送 Markdown”。任务至少区分 `DRY_RUN`、`ARCHIVE_READY`、`WAITING_TARGET_IMPORT`、`COMPLETED` 和 `FAILED/CANCELLED`；只有目标原生回读完全匹配才可进入 `COMPLETED`。（本轮研究；总方案 §3 A、§13.4、§18）
- 目标应用未登录、未初始化 History 或未配置模型时，IDE Hub 不代填凭据。归档生成与模型续聊状态分开：无可用模型不阻止离线归档生成；未完成真实续聊时不能宣称连续性 Gate 已通过。（总方案 §2.3、§13.2；已确认无需 Hub Key）
- 归档 ID、conversation/request/message ID 只能使用 `[A-Za-z0-9_-]` 且全局唯一；ID 必须包含目标产品维度，避免国际版和 CN 在可能共享的中央扩展数据根中发生误复用。（本轮 schema validator 与双版本研究）
- 导入完成后不由 IDE Hub 改写已归目标产品管理的历史。用户已在目标追加消息时，重复迁移、失败恢复或 Hub 清理都不得覆盖或自动删除这些新增消息。（总方案 §1、§12、§13.2）

## Acceptance

### AC-001 — 双版本发现与正式桌面入口

- Given: 本机分别存在国际版、CN 版、只安装其中一版、二者都未安装及版本/构建不兼容的场景。
- When: IDE Hub 扫描产品并打开真实 Codex 会话的迁移入口。
- Then:
  1. 产品列表分别显示 CodeBuddy 国际版和 CodeBuddy CN 的 app 名称、bundle、版本与兼容状态；一版状态不影响另一版。
  2. 会话详情和迁移向导可以单独选择两个目标；未安装或不兼容的目标不可执行且原因明确。
  3. 已安装时不安装 CodeBuddy Code CLI、不要求 CLI 登录；正式界面仍是现有 `prototype/` 布局。
- Required evidence:
  1. discovery 单测覆盖两版、单版、缺失、错 bundle、错版本和错 hash。
  2. 打包桌面截图/录屏显示两个独立产品项及各状态。
  3. 扫描前后应用、CLI 和用户配置清单对照。
- 方案依据: CHG-001、CHG-002；本轮“双版本”要求；已确认正式桌面要求；总方案 §8.2、§11。

### AC-002 — 原生归档协议与两版官方 Import

- Given: 含普通多轮、中文、emoji、换行、连续同角色、仅 user 结尾和长文本的合成投影，以及从两个支持版本各自原生导出的脱敏 fixture。
- When: encoder 生成单会话 JSON，并分别由国际版 `4.12.0` 和 CN `4.11.2` 的 History Import 导入。
- Then:
  1. 归档通过本地严格 validator：schema/version、时间、唯一 conversation、ID、request state、消息角色和 `message` 内 core message 均有效，文件不超过 20 MiB。
  2. 两版官方 Import 均接受归档并创建非空原生会话；国际版 ZIP 能力不成为 CN 或单会话迁移前置条件。
  3. 归档不包含假 system/tool/assistant、目标模型/用量、登录态或待执行工具标记。
- Required evidence:
  1. 两版原生导出 fixture 的脱敏结构快照、validator/encoder round-trip 测试和 JSON Schema 负向测试。
  2. 两个目标 Import 成功界面、导入前后 History 对照和新目标 ID。
  3. 归档字段清单与 forbidden-field 断言。
- 方案依据: CHG-003、CHG-004；本轮原生归档研究；总方案 §6、§8.2、§13.1。

### AC-003 — A → A 与版本身份不串线

- Given: 源会话 cwd 为 `/Users/domino/develop/IdeaProjects/temp`，另覆盖符号链接、路径含空格/中文、无效目录和同时打开 A/B 两个 CodeBuddy 窗口的场景。
- When: 分别迁移到国际版和 CN，执行目标 Import 并由 Hub 回读。
- Then:
  1. 启动的是所选 bundle，目标窗口实际根目录规范化后为 A；不得打开另一版本或最近使用的 B。
  2. 导入记录只在 `MD5(normalize(A))` 对应历史下被认领，回执中的目标 ID、原生 History 中的会话和后续工具工作目录均属于 A。
  3. 若用户切到 B 后导入，Hub 报告 `TARGET_WORKSPACE_MISMATCH` 并保持待处理/失败状态，不把 B 中会话算成完成。
- Required evidence:
  1. 两版启动调用、bundle、A canonical path 与工作区 hash 对照。
  2. 导入前后原生索引的脱敏结构回读、回执目标 ID 及目标原生只读 `pwd`。
  3. B 误导入、符号链接、空格/中文和无效目录测试。
- 方案依据: CHG-001、CHG-004、CHG-005；已确认 A → A；总方案 §7.1、§8.2、§13.4。

### AC-004 — 原生历史正文、角色和顺序完整

- Given: 一个真实 Codex 快照及 AC-002 合成边界；源端还包含不可迁移工具、附件和运行时事件。
- When: 目标官方 Import 完成，Hub 通过目标本地历史读取路径逐条回读，并在目标原生 UI 打开。
- Then:
  1. 可见 user/assistant 数量、角色、顺序、正文和换行与源投影逐条一致；连续同角色不被误换角色，只有 user 的结尾不补假回答。
  2. 每个 request/message ID 唯一、关系完整、request 为终态；空会话、缺消息文件、重复 ID、角色错乱或只导入标题均失败。
  3. 不可移植事件与既有 Loss Report/ Capsule 对应，目标 UI 不出现伪造的模型、用量、待审批或工具执行状态。
- Required evidence:
  1. 源投影、归档与两版目标回读的逐条 hash/角色/计数对照。
  2. 两版原生 History 打开后的完整多轮演示及退出重开对照。
  3. 损坏关系、缺文件、重复 ID、只 user 和不可移植事件负向测试。
- 方案依据: CHG-003、CHG-005；已确认原生多轮要求；总方案 §6、§7.2、§7.4、§13.1。

### AC-005 — 导入状态、确切目标与幂等

- Given: 同一源快照尚未导入、正在等待用户 Import、已导入并在目标新增聊天三种状态；另有同源不同快照及另一 CodeBuddy 版本。
- When: 用户取消 Import、完成 Import、重复迁移或切换目标版本。
- Then:
  1. 只生成归档或打开目标时状态分别是 `ARCHIVE_READY` / `WAITING_TARGET_IMPORT`，不是 `COMPLETED`；取消后不产生成功回执。
  2. 完成 Import 后按目标专属 `originalId/id` 认领确切非空会话，完整回读后才完成。
  3. 同目标同快照重复迁移复用同一目标且保留目标新增聊天；新快照生成新迁移版本；国际版记录不会被 CN 误复用，反之亦然。
- Required evidence:
  1. 状态机测试及取消/超时/回读失败记录。
  2. 归档 ID、原生 `originalId/id`、回执 ID 和消息对照。
  3. 重复迁移、新快照、目标新增消息和跨版本隔离测试。
- 方案依据: CHG-004、CHG-005、CHG-006；总方案 §8.2、§12、§13.2、§18。

### AC-006 — 两版分别完成真实续聊

- Given: 两个目标各有一份已回读通过的迁移会话，源历史包含总方案 §13.2 的 sentinel：目标、约束、否决方案、文件改动、验证状态、未解决问题和下一步；目标 IDE 已有可用账号和模型。
- When: 实现方在每一版目标原生会话中先询问一个不在新问题里提供答案的旧事实，再要求承接一个明确下一步，随后退出并重开。
- Then:
  1. 第一轮正确引用旧历史，不混淆已完成与未完成状态。
  2. 第二轮执行/说明正确下一步，不从头重复；两轮均追加到回执中的同一目标 ID。
  3. 重开后迁移历史和新问答仍存在，未出现历史结构、请求关系或上下文载入错误。
  4. 国际版和 CN 各自有完整证据；任何一版未测都只能标记该版“历史已导入、连续性未验证”。
- Required evidence:
  1. 两版各自的源 sentinel、第一轮问题/回答和事实对照。
  2. 两版各自的第二轮问题/回答、实际承接结果和目标 ID。
  3. 两版关闭重开后的原生历史及本地持久化回读对照。
- 方案依据: CHG-007；已确认实现方真实续聊要求；总方案 §13.2、§13.4、§18。

### AC-007 — 离线迁移、无 Hub Key 与 MCP 独立

- Given: IDE Hub 进程禁网且没有模型 Key，记录源会话及 Codex、CodeBuddy 国际版、CodeBuddy CN 的 MCP 配置指纹；另有目标尚未配置模型的场景。
- When: 执行扫描、预览、归档生成、打开目标、官方本地 Import 跟踪和回读。
- Then:
  1. IDE Hub 不发起模型或网络请求，不调用 `buddy chat` / `buddycn chat`，不自动发送测试消息；目标应用自身登录、遥测或续聊联网不冒充 Hub 行为。
  2. 源会话及三端 MCP 指纹不变，不复制账号、模型 Key 或登录态。
  3. 目标无模型时仍可生成归档；若目标产品允许本地 Import，则准确显示“历史已导入、真实续聊未验证”，不把模型配置问题误报为历史损坏。
- Required evidence:
  1. IDE Hub 禁网运行及子进程 argv/调用记录，证明只执行无 prompt 的打开动作。
  2. 源指纹、MCP 指纹和迁移写入清单前后对照。
  3. 无模型场景的归档/导入结果与分离状态测试。
- 方案依据: CHG-008；已确认离线、无需 Key 和 MCP 独立要求；总方案 §2.3、§9、§10、§13.2。

### AC-008 — 限制、失败与精确恢复

- Given: 不兼容构建、20 MiB 边界及超限归档、非法 schema/version/ID/role/state、导入取消、目标未初始化、导入到 B 和回读不一致；另有已成功导入的目标。
- When: 预览、生成、导入、回读或执行恢复。
- Then:
  1. 每类错误均返回稳定错误码、阶段、实际原因和可操作提示；不创建伪成功任务，不静默截断历史或回退成 Markdown。
  2. 导入前取消/失败只清理本次临时归档或保留为明确的审计产物，不改源与目标历史。
  3. 导入后恢复只定位本次 `originalId/id`。目标没有新增聊天时，可通过官方 History 由用户确认删除并由 Hub 验证消失；已有新增聊天时默认拒绝删除并保留会话，只有用户明确确认会一并删除这些新增聊天后才继续。其他会话、另一版本和 MCP 均不受影响。
- Required evidence:
  1. 版本、大小、schema、工作区、取消和回读负向测试矩阵。
  2. 失败前后源、目标索引和 Hub 产物清单对照。
  3. 两版各一次无新增聊天的官方删除/恢复演示，一次已有新增聊天的默认保留测试，以及无关会话、另一版本、MCP 对照。
- 方案依据: CHG-009；总方案 §7、§8.2、§12、§13；本轮归档限制与官方 History 能力研究。

## Traceability

| Change | Acceptance |
| --- | --- |
| CHG-001 | AC-001、AC-003 |
| CHG-002 | AC-001 |
| CHG-003 | AC-002、AC-004 |
| CHG-004 | AC-002、AC-003、AC-005 |
| CHG-005 | AC-003、AC-004、AC-005 |
| CHG-006 | AC-005 |
| CHG-007 | AC-006 |
| CHG-008 | AC-007 |
| CHG-009 | AC-008 |

## Open decisions

- None.

## Sources and evidence

### 会话原理与本机验证

以下是 2026-09-14 的只读研究事实。研究没有修改 CodeBuddy 历史、导入会话、发送模型请求或读取会话正文；字段结构通过应用包、脱敏 key/type/shape、文件 hash 和日志中的结构化路径验证。

| 研究对象 | 已核实事实 | 对本能力的影响 |
| --- | --- | --- |
| 国际版安装 | `/Applications/CodeBuddy.app`，bundle `com.tencent.codebuddy`，App `4.12.0`；内置 VS Code `1.106.1`，commit `b4c35ed08ffb428910211608831a314565c1256e`；product `applicationName=buddy`、`dataFolderName=.codebuddy`。 | 目标 ID 为 `codebuddy-international`；使用国际版 app/bundle/launcher，不能借 CN 状态代替。 |
| CN 安装 | `/Applications/CodeBuddy CN.app`，bundle `com.tencent.codebuddycn`，App `4.11.2`；内置 VS Code `1.106.1`，commit `74e2511a9221f313959fc19c58e81bcd78a85950`；product `applicationName=buddycn`、`dataFolderName=.codebuddycn`。 | 目标 ID 为 `codebuddy-cn`；单独探测和验收。 |
| 桌面 launcher | `~/.codebuddy/bin/buddy` 与 `buddycn` 都指向对应 App 内 `Resources/app/bin/code`。`--help` 是桌面 IDE launcher，`chat` 子命令会发 prompt；未发现 conversation import 参数。 | 不安装或登录所谓“CodeBuddy CLI”；只用无 prompt 的目录打开能力。Import 仍由目标 History UI 执行。 |
| 内置扩展 | 两版均为 `Tencent-Cloud.coding-copilot` `3.10.0`。国际版 `out/extension/index.js` SHA-256 `96485062235e7fd75e364e3c742c7fcd289a521e4c3952ad3873b9b0a89b7cb9`；CN 为 `a3276eb57db50f7ffc6249788f73fd8e1c14e64ca834e98f864b432b879eed08`。 | 首批兼容矩阵锁定这两个实际构建；相同扩展版本号不代表字节和能力完全相同。 |
| 官方 Import | 两版当前代码都提供单 JSON History Import、20 MiB 上限和成功/失败提示。国际版还支持 ZIP 内逐 JSON 导入与批量导出；CN `4.11.2` 当前只选择单 JSON。 | 共享单 JSON v1 编码器即可覆盖两个目标；不把国际版 ZIP 当作 CN 前置条件。 |
| Archive envelope | `schema = codebuddy.conversation`、`schemaVersion = 1`、`exportedAt`、`data.lastMessageAt`，且 `data.conversations` 必须恰好一条。 | encoder/validator 的稳定边界；生成的是原生归档，不是 Handoff Markdown。 |
| Conversation/request/message | conversation 需要合法 ID、type/name/createdAt/lastMessageAt/requests；request 需要合法 ID、type、`running|complete|aborted|canceled` state 和 messages；message 需要唯一合法 ID、`user|assistant|tool|system` role 及字符串 `message`，可含受限可选元数据。 | 首版只投影 user/assistant 可见正文，request 写完成态，严格拒绝重复或非法关系。 |
| Core message | History writer 会把消息对象 JSON 序列化；恢复路径再解析为 core message。user 内容可提取为文本，assistant 内容支持文本或 text content 数组，推理和 tool-call 有专门结构。 | 必须用原生导出 fixture 锁定最小 core message 表达；不把 Codex tool/runtime 对象直接塞入目标。 |
| 本地历史 | 实际 payload 根形如 `~/Library/Application Support/CodeBuddyExtension/Data/ACCOUNT_PARTITION/CodeBuddyIDE/UID/history/WORKSPACE_MD5/`，其中 `WORKSPACE_MD5 = md5(normalize(workspace))`；目录内含全局 `index.json`、会话 `index.json`、`messages/*.json`。两版 app 自己的 `User/globalStorage/.../genie-history` 另有工作区 UI 状态。 | A 是原生存储分区键。Hub 只读该路径做导入认领与回读，不直接写入。中央根可能被两版共享，目标专属 ID 必不可少。 |
| 顶层 session DB | 两版都有 `codebuddy-sessions.vscdb`，当前 schema 只有 `ItemTable` 且均为 0 rows；VS Code `state.vscdb` 中也只有通用 session/UI key。 | 这些 DB 不是本能力的目标 writer，不得因为文件名含 session 就写入。 |
| 导入语义 | Import 以归档 conversation ID 作为 preferred ID；冲突时生成新 ID，同时在会话 metadata 保留 `originalId`。导入动作不把归档设为当前会话。 | 用目标专属确定性 ID追踪、回读和幂等；导入后必须从 History 打开确切目标，不能依赖“当前会话”。 |
| 当前样本限度 | 本机现有两版历史索引仅包含空会话骨架，没有可用于确认非空正文形状和续聊的现成原生样本。 | 开发时必须先由每版正常 UI 生成并导出最小多轮 fixture；本轮静态研究不冒充真实续聊已通过。 |

### 协议映射

最小归档结构如下；字段值仅说明协议，不是要硬编码的测试正文：

```json
{
  "schema": "codebuddy.conversation",
  "schemaVersion": 1,
  "exportedAt": "ISO_8601_TIMESTAMP",
  "data": {
    "lastMessageAt": "ISO_8601_TIMESTAMP",
    "conversations": [
      {
        "id": "TARGET_SPECIFIC_DETERMINISTIC_ID",
        "type": "craft",
        "name": "[IDE Hub · Codex] SOURCE_TITLE",
        "createdAt": "ISO_8601_TIMESTAMP",
        "lastMessageAt": "ISO_8601_TIMESTAMP",
        "requests": [
          {
            "id": "UNIQUE_REQUEST_ID",
            "type": "craft",
            "state": "complete",
            "messages": [
              {
                "id": "UNIQUE_MESSAGE_ID",
                "role": "user",
                "message": "{\"role\":\"user\",\"content\":\"VISIBLE_TEXT\"}",
                "createdAt": "ISO_8601_TIMESTAMP"
              }
            ]
          }
        ]
      }
    ]
  }
}
```

实现必须以两版原生导出 fixture 修正和冻结 `request.type`、assistant `content` 及可选字段的最小集合；上例不能独自作为真实兼容性证明。归档中不嵌入 workspace，A 由目标 Import 所在窗口和回读 hash 保证。

### 工程复用位置

- 复用 [Codex reader](../../src/codex/reader.ts)、[可见正文抽取](../../src/seed-context.ts)、[统一会话投影](../../src/conversation-projection.ts)、[工作区身份](../../src/workspace.ts)、[迁移产物](../../src/artifacts.ts)、[迁移编排](../../src/migration.ts) 与既有目标的幂等/回读组织方式。
- CodeBuddy 必需差异是双 installation profile、官方 archive v1 encoder/validator、Import 等待状态、目标专属 `originalId`、按 A hash 的只读历史认领，以及原生 History 打开与续聊 Gate；不能复制 Qoder IPC、Cursor blob、Claude/Pi JSONL 或 DSH seed 协议。
- 接入现有 [目标类型](../../src/types.ts)、[请求校验](../../src/request.ts)、[请求 schema](../../schemas/session-migration-request-v1.schema.json)、[结果 schema](../../schemas/session-migration-result-v1.schema.json)、[CLI](../../src/cli.ts)、[Electron 主进程](../../desktop/main.cjs)、[preload](../../desktop/preload.cjs)、[正式渲染层](../../prototype/app.js) 和 [桌面契约测试](../../test/desktop-contract.test.ts)。
- 测试继续执行 `npm run check`、`npm run build`、`npm test`；新增协议、发现、归档、状态机、回读、幂等及 Electron contract 测试。真实 Import/续聊是两版独立 Gate，不能由 fixture 或普通单测替代。

### 来源索引

| Source | Revision or date | Confirmed facts used |
| --- | --- | --- |
| 本轮用户要求及此前已确认的原生历史、A → A、正式桌面、MCP 独立与真实续聊要求 | 2026-09-14 及本会话产品基线 | 双目标范围、产品结果与验收强度 |
| [总方案](../ide-hub-implementation-plan.md) | SHA-256 `d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb` | 公共架构、离线边界、会话模型、任务/回滚和验收；旧 CodeBuddy C 级结论由本轮证据更新 |
| [CodeBuddy 国际版 History](https://www.codebuddy.ai/docs/ide/User-guide/History) | 2026-09-14 访问 | 原生 History 可查找、继续、导出、编辑和删除会话 |
| [CodeBuddy CN 历史记录](https://www.codebuddy.cn/docs/ide/User-guide/History) | 2026-09-14 访问 | CN 原生 History 的继续、导出、编辑和删除能力 |
| [CodeBuddy CN 4.12.0 Release Notes](https://www.codebuddy.cn/docs/ide/release-notes/release-notes) | 2026-09-04 release；2026-09-14 访问 | 4.12.0 官方记录会话批量导出、单文件/ZIP 导入与置顶；不用于冒充 CN 4.11.2 本机实测 |
| [CodeBuddy Code `.codebuddy` directory](https://www.codebuddy.ai/docs/cli/codebuddy-dir) | 2026-09-14 访问 | `~/.codebuddy/projects` 与 `history.jsonl` 属于 CodeBuddy Code CLI runtime；不能据此推断 IDE History writer |
| 两版本机 Info.plist、product.json、内置 extension、launcher `--version/--help`、本地 schema/key/shape 与脱敏日志路径 | 国际版 `4.12.0`、CN `4.11.2`；2026-09-14 | bundle/版本/构建、JSON Import、archive v1、20 MiB、workspace hash、本地历史结构与 launcher 边界；未读取正文或凭据 |
| 当前仓库工程文件 | `58dfebd722460a0be66011739c70969b9820b7b7` | 已有复用位置和 CodeBuddy 尚未接入的实际状态 |
