---
contract_id: MCP-MIG-001
version: 3
status: ready
route: full-assurance
source_revision: ide-hub@654ac3004ae9961e7140c9e012c79f815453f8bf+plan-d1446a27+user-2026-09-14-selection-flow-v2+native-loader-gate-2026-09-15
---

# Codex MCP 按勾选项迁移到目标 IDE

## Source baseline

- 本轮用户要求及后续修正（2026-09-14）：会话迁移主线之后开始 MCP 配置迁移；以 Codex 为源，页面列出可迁移的 MCP，由用户勾选需要迁移的项、选择一个目标应用后点击“确定迁移”。只将勾选的 MCP 写入该目标应用，不是把全部 MCP 一次覆盖到其他全部 IDE。支持其余全部 IDE 指这些应用都可作为单次操作的目标选项。MCP 是产品级全局配置，不随每个会话重复处理。
- 产品方案基线：[IDE Hub 本地会话与 MCP 迁移实现方案](../ide-hub-implementation-plan.md)，SHA-256 `d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb`，重点为 §1、§2、§4.3、§5、§8、§9～§14、§17～§19。用户点名的第 82～112 行是旧会话/安装调研快照，不是本轮执行指令；MCP 行为以 §4.3 和 §9 为准。
- 初始进度基线：[IDE Hub 任务进度总控](../ide-hub-master-progress.md)，初始 SHA-256 `383cc618a8ee1b2fc3b78abc58e0b76a098265a8ebd2cdbd227d1bac0a9e0712`。该快照记录的是开发前状态；当前实现和验收结果以总控文档及 [MCP-MIG-001 验收记录](../verification/mcp-migration-001.md) 的最新内容为准。
- 当前工程基线为 Git commit `654ac3004ae9961e7140c9e012c79f815453f8bf`。现有目标标识为 `qoder-international`、`qoder-cn`、`cursor`、`deepseek-harness`、`zcode`、`pi`、`claude-code`、`codebuddy-international`、`codebuddy-cn`；现有 `mcp-fingerprint.ts` 只用于证明会话迁移没有改 MCP，不是配置迁移实现。
- 冻结规则：本合同只把 Codex MCP 迁往上述九个可选目标，单次任务只能选择一个目标应用和一个或多个 MCP；会话、会话 ZIP、模型账号与 MCP 配置继续保持独立。
- 2026-09-15 纠偏基线：目标文件写入成功和 IDE Hub 自己重读成功都不能证明目标 IDE 已识别。CodeBuddy CN 的旧实现误写 `~/.codebuddycn/.mcp.json`，Qoder 的旧实现误把独立 CLI 的 `settings.json` 当成桌面 IDE 配置；两者都会产生“页面成功、IDE 列表为空”的假阳性。本合同从 v3 起要求桌面 IDE 实际配置入口和目标原生 loader Gate。

## Objective

在正式本地 IDE Hub 桌面的全局 MCP 页面中读取 Codex 当前有效的 MCP 配置，统一为独立 MCP Registry，以可勾选列表展示每个 MCP。用户勾选一个或多个 MCP，选择一个目标 IDE，处理所选项的字段映射与冲突后点击“确定迁移”。IDE Hub 只向该目标写入本次勾选的 MCP，并完成备份、重读验证和精确回滚。迁移全程在本机完成，不调用模型，不需要模型 API Key，不读取或修改任何会话。

最短真实闭环先完成 Codex user scope → Cursor user scope：页面读取双方有效配置 → 勾选一个 Codex MCP 并保持其他 MCP 未勾选 → 单选 Cursor 为目标 → 展示所选 MCP 的新增/相同/冲突/不支持 diff → 解决必要冲突 → 点击“确定迁移” → 备份并仅写入所选 MCP → Cursor 原生识别 → 对本地 stdio server 执行 `initialize + tools/list` → 从本次备份回滚并确认恢复。随后八个当前支持目标必须按各自原生配置语义分别通过单目标闭环；Pi 必须通过“不支持且不写伪配置”的负向能力 Gate，不能以 Cursor 成功代替其他目标。

## In scope

| ID | Product behavior | 方案依据 |
| --- | --- | --- |
| SCOPE-001 | 正式 `prototype/` 的“全局 MCP 配置”页面接入真实扫描，以复选框列出 Codex MCP，以单选控件选择一个目标应用，并提供所选项 diff、冲突处理、“确定迁移”、执行结果、任务历史和回滚；入口和状态不依赖任何会话。现有“迁移整套配置”和多目标复选交互必须替换。 | 本轮用户要求及后续修正；总方案 §1、§9.1、§11.3、§12 |
| SCOPE-002 | 实现 Codex MCP source adapter：读取 user、project/local 层及其有效覆盖关系，解析为 MCP Registry，保留 server 名、scope、transport、command/args/cwd、env、URL/headers、enabled、tool policy、来源文件和不可映射扩展。 | 总方案 §2.1、§4.3、§8.1、§9.2～§9.3 |
| SCOPE-003 | 实现 Qoder 国际版、Qoder CN、Cursor、ZCode、CodeBuddy 国际版、CodeBuddy CN、Claude Code 七个配置型目标 adapter。Qoder 双版使用独立配置根和原生结果；CodeBuddy 双版保留独立产品 profile 与各自原生日志 Gate，但当前 4.12.0 的 user scope 共用 `~/.codebuddy/mcp.json`，页面必须提示迁移任一版会同时影响另一版。 | 本轮“其余全部 IDE”；2026-09-15 本机目标设置页与扩展日志实证；总方案 §4.3、§8.2～§8.3、§9.3～§9.5 |
| SCOPE-004 | DeepSeek Harness 使用原生 Cordis profile/project patch，将一个 Registry server 渲染为一个 `@deepseek-ai/dsh-mcp-client` plugin 配置，不把普通 `mcpServers` JSON 写成伪支持。 | 总方案 §4.3、§8.3、§9.4、Phase 2 |
| SCOPE-005 | Pi 仅在已发现并由用户明确信任的兼容 MCP adapter 存在时生成和写入其配置；没有兼容 adapter 时准确显示不可执行及安装说明，不自动安装第三方包，也不把普通 `mcp.json` 冒充 Pi 原生能力。 | 总方案 §4.2～§4.3、§8.3、§9.4、Phase 2 |
| SCOPE-006 | 用户必须显式勾选一个或多个 MCP；未勾选任何 MCP 或未单选目标应用时“确定迁移”不可执行。页面只对所选 MCP 显示新增、相同、冲突、不支持和人工动作，并提供跳过、重命名、合并、替换四种同名策略；未勾选 MCP 不得进入写入计划。 | 本轮用户后续修正；总方案 §9.1、§9.3～§9.4、§11.3；进度总控 D-004 |
| SCOPE-007 | 单次任务只针对一个目标应用，对所选 MCP 执行预检、备份、原子 apply、有效配置重读、语义 round-trip、目标原生识别、stdio 可用性验证和回滚。用户需要迁移到另一目标时另行发起任务；重复执行必须基于该目标当前状态重新生成 diff。 | 本轮用户后续修正；2026-09-15 目标 IDE 假阳性纠偏；总方案 §9.3、§9.5、§12～§13、§16 |
| SCOPE-008 | 实现独立 MCP Config Bundle 的导出、导入与 checksum；配置包可在另一台电脑进入全局 MCP 页面后重新选择目标，不包含 Session、Capsule、Handoff、附件或工作区代码。 | 总方案 §5、§7.5.2、§9.6、§13.3 |

目标 renderer 基线：

| 目标 | 原生落点与行为 |
| --- | --- |
| Qoder 国际版 / Qoder CN | user scope 分别写 `~/.qoder/mcp.json`、`~/.qoder-cn/mcp.json`；project scope 使用目标 IDE 识别的 `.qoder/mcp.json` / `.mcp.json`。独立 CLI 的 `settings.json` 不作为桌面 IDE 迁移落点或成功证据；桌面 IDE 未验证 local scope，必须标为不支持。 |
| Cursor | user scope 写入 `~/.cursor/mcp.json`，project scope 写入项目 `.cursor/mcp.json`，保留其他 server 和顶层配置。 |
| ZCode | 渲染 `mcp.servers`，遵循 `.zcode` 对 `.agents` 的整层优先级；不得写入一个实际已被更高层完全遮蔽的文件后宣称成功。 |
| CodeBuddy 国际版 / CodeBuddy CN | 当前 4.12.0 的 user scope 均写 `~/.codebuddy/mcp.json`；两版用各自扩展日志独立确认重新加载和工具发现。不得再写 `~/.codebuddycn/.mcp.json`，也不得声称共享 user 配置能隔离变更。 |
| Claude Code | 保留 user/project/local scope 语义；项目配置首次使用仍由 Claude Code 自己完成批准，IDE Hub 不迁移批准状态。 |
| DeepSeek Harness | 写入目标 profile 或 project patch 的 Cordis MCP client plugin rows，并通过 DSH 自身配置重读。 |
| Pi | 通过已安装且已信任的兼容 MCP adapter 配置格式写入；核心无 MCP 时保持不可执行状态。 |

## Out of scope

- 不把 Qoder、Cursor、ZCode、CodeBuddy、Claude Code、DSH 或 Pi 作为本合同的配置源；不做任意产品之间的双向或 N×N MCP 转换。
- 不提供“一键把全部 Codex MCP 覆盖到全部 IDE”或单任务多目标写入；变更其他目标应用必须另行选择并确认。
- 不读取、创建、迁移或删除会话，不把 MCP 写入会话迁移向导或会话 ZIP，不根据历史工具调用自动选择 server。
- 不迁移产品账号、模型 API Key、OAuth/token/cookie、设备凭据或登录态。目标 MCP server 自身配置中用户明确选择迁移的 literal/env/header/URL/args 仍按本合同预览和转换。
- 不自动安装 `mcp-remote`、代理、Context Bridge、Pi 第三方 adapter 或其他包来掩盖目标 transport/能力不兼容。
- 不把 HTTP/SSE/WS MCP 的联网探活作为默认迁移步骤；IDE Hub 不负责远程 server 的账号、网络和服务可用性。
- 不把 MCP Config Bundle 合并进会话便携 ZIP，也不在 IDE Hub 中新增云端同步、账号系统、Keychain 或加密 Vault。

## Constraints

- 应用继续使用本地 Electron 主进程、隔离 preload 和 `prototype/` 正式渲染层，不启动 Web/localhost 服务。（总方案 §5、§10～§11）
- MCP 请求、Schema、journal、bundle 和任务记录不得含 `sessionId`、`hubSessionId`、会话 `migrationId`、conversation、Capsule 或 Handoff；会话请求/结果也不得引用 `mcpMigrationId`。（总方案 §1、§9.1；进度总控 P0-02/P0-04）
- MCP 迁移请求只能包含一个 `targetProduct` 和至少一个页面当前勾选的 server ID；不接收多目标数组，不用“默认全部”替代用户勾选。（本轮用户后续修正）
- Codex source 始终只读；adapter 必须读取有效配置和 layer precedence，不能把找到的第一个文件当成最终配置，也不能改源配置。（总方案 §8.1、§9.3、§10）
- user、project 和 local scope 分开显示和映射。项目 scope 由本 MCP 任务单独选择项目路径，不从任何会话推导；目标不支持原 scope 时必须显示人工映射或不支持。（总方案 §2.1、§9.2～§9.4、§9.6）
- JSONC 必须使用 AST patch，TOML 必须使用能保留无关内容和注释的编辑方式；写入只改变用户确认的 server/字段，保留其他配置、文件权限、owner 和换行风格。（总方案 §9.5）
- 每个目标写前创建内容寻址备份并记录本次文件指纹；临时文件与目标同文件系统，完成 `fsync + atomic rename`。目标在预览后被外部改动时，当前 apply 失败并要求重新生成 diff，不覆盖新内容。（总方案 §9.5、§13.3、§16）
- 同名策略精确定义如下，以关闭进度总控 D-004 的实现歧义：`跳过`不改目标；`重命名`以用户确认的新名字新增且保留原目标；`替换`只替换该 server，保留其他 server 和顶层字段；`合并`只自动并入完全相同或键不重叠的字段。transport 或 endpoint identity 不同时不可合并；同一字段值不同时保持未解决并要求用户逐项选源值或目标值，不能静默定优先级。（总方案 §9.3～§9.5；进度总控 D-004）
- literal 值、环境变量引用、headers、URL query 和 args 的迁移方式由预览逐项展示；默认保持源配置语义。原始配置查看默认遮罩值，但 IDE Hub 不把用户选择的 MCP 配置改造成新的密钥系统。（总方案 §9.2～§9.4、§10、§11.3）
- 每个单目标任务独立备份、apply、verify 和回滚。receipt 必须记录唯一目标和实际勾选的 MCP；未勾选 MCP、其他 Codex MCP 和其他目标应用不受影响。（本轮用户后续修正；总方案 §9.1、§9.3、§12）
- 目标配置版本、schema 或 precedence 无法识别时允许只读预览，禁止 apply；不得降级为写一个目标不会读取的普通 JSON 文件。（总方案 §8.2、§9.4、§13.1）
- 迁移核心不调用模型、不需要模型 API Key。stdio 可用性验证在本地离线执行 `initialize + tools/list`；远程 transport 默认只做结构和目标重读验证。（总方案 §2.3、§9.3、§10、§13.4）
- `COMPLETED` 只允许在配置 round-trip、目标应用原生识别和本地 stdio handshake 全部通过时返回。目标应用未运行或原生 Gate 超时时只能返回 `COMPLETED_WITH_WARNINGS` 并明确显示“目标应用识别待确认”；原生 loader 明确未发现所选 MCP 时必须自动回滚并失败，不能显示绿色成功。
- 原生识别必须使用目标自身机制：Qoder desktop effective cache、Cursor `cursor agent mcp list`、DSH `--dump-config`、ZCode app-server `mcp/list`、Claude `mcp get`、CodeBuddy 对应版本扩展的写后 reload/tool-discovery 日志。IDE Hub 自读目标文件不属于原生识别证据。
- 回滚时若目标 IDE 仅重排/格式化文件或写入无关字段，必须只恢复本次迁移涉及的 server 并保留外部变化；若外部进程修改了本次迁移的同名 server，则拒绝回滚并报告冲突。

## Acceptance and required evidence

### AC-001 — MCP 与会话领域完全分离

- Given: 正式 IDE Hub 中已有会话数据和独立 MCP 页面。
- When: 扫描或执行 Codex MCP 迁移，并检查 MCP request/result/schema、journal、配置包和会话请求。
- Then:
  1. MCP 页面展示真实 Codex MCP 复选列表和单选目标应用；用户勾选所需 MCP 后通过“确定迁移”发起 Codex → 单个目标的独立配置任务。
  2. MCP 全链路不存在 Session/Capsule/Handoff ID；会话页面、会话迁移和会话 ZIP 未新增 MCP 写入或联合事务。
- Required evidence:
  1. 正式桌面真实扫描与任务演示。
  2. 两组 Schema/请求负向测试及会话迁移前后 MCP 指纹回归。
- 方案依据: SCOPE-001；总方案 §1、§7、§9.1、§11～§13。

### AC-002 — Codex 有效配置完整归一化

- Given: Codex user、project/local 层包含 stdio、Streamable HTTP、环境变量引用、literal 值、禁用 server、同名覆盖和无关 TOML 注释。
- When: source adapter 读取指定 scope 并生成 MCP Registry 和预览。
- Then:
  1. Registry 的 server 数量、最终有效值、来源层、覆盖关系及标准字段与 Codex 实际有效配置一致。
  2. 未被选择的 scope、无关 TOML 内容和 Codex 源文件内容/权限均不变；无法解析时不得生成可执行计划。
- Required evidence:
  1. 合成多层 TOML fixture、round-trip/precedence 测试及 Registry Schema 负向测试。
  2. 本机 Codex 配置的脱敏结构对照与迁移前后文件指纹。
- 方案依据: SCOPE-002；总方案 §4.3、§8.1、§9.2～§9.3、§13.3。

### AC-003 — Codex → Cursor 最短真实闭环

- Given: Codex 有至少三个 MCP，其中一个可用 stdio MCP 被勾选，其他两个保持未勾选；Cursor 包含无关 server 和一个可用于验证冲突策略的同名 server。
- When: 用户在正式 MCP 页面勾选该 MCP、单选 Cursor，确认所选 MCP 的 diff 和冲突策略，点击“确定迁移”后执行 apply、重读、离线探测与回滚。
- Then:
  1. 页面准确显示新增、相同、冲突、不支持；写入前存在可定位的 Cursor 备份。
  2. Cursor 有效配置只新增或变更本次勾选的 MCP；两个未勾选 Codex MCP、Cursor 无关 server 和无关字段保持原语义；本地 stdio server 的 `initialize + tools/list` 成功。
  3. 回滚后 Cursor 有效配置恢复为迁移前语义，Codex 源配置和两端会话均未改变。
- Required evidence:
  1. diff 记录、备份/receipt、Cursor 重读及目标原生 MCP 列表对照。
  2. 一次真实本地 stdio handshake 记录。
  3. 回滚前后语义 hash、源文件 hash 和会话数据指纹。
- 方案依据: SCOPE-002、SCOPE-003、SCOPE-006、SCOPE-007；总方案首个 MCP 闭环、§9、§13.3～§14；进度总控 P0-09～P0-11。

### AC-004 — JSON/JSONC 配置型目标逐版通过

- Given: Qoder 国际版、Qoder CN、ZCode、CodeBuddy 国际版、CodeBuddy CN、Claude Code 各自存在已支持安装和包含无关字段/注释的目标配置 fixture；另覆盖目标文件不存在的场景。
- When: 对每个目标分别发起一次单目标任务，勾选同一组测试 MCP，点击“确定迁移”后执行 plan、apply、有效配置重读和 rollback。
- Then:
  1. 每版只写其当前实际生效的原生配置层；Qoder 双版的路径、状态和 receipt 互不串线；CodeBuddy 双版的目标身份和原生验证结果独立，但 user 配置路径按产品事实共享并在 UI 明示。
  2. 目标原生 MCP 列表能发现确认后的 server；scope、transport 和可映射字段正确，无关 server、注释及顶层字段保留。
  3. ZCode precedence 和 Claude project approval 被准确呈现；写入被遮蔽层或迁移批准状态不能返回成功。
  4. 每个目标独立回滚后恢复迁移前语义。
- Required evidence:
  1. 六类 adapter 的配置 fixture、AST patch、precedence、隔离和 rollback 测试。
  2. 每个实际支持版本的目标原生列表/设置页及重读对照。
  3. 双 Qoder 交叉误认、CodeBuddy 旧错误路径及“自读成功但目标原生 loader 未发现”的负向测试。
- 方案依据: SCOPE-003、SCOPE-006～SCOPE-007；总方案 §4.3、§8.2～§8.3、§9、§13.3～§13.4。

### AC-005 — DSH Cordis 原生映射

- Given: 已支持的 DeepSeek Harness profile/project patch，包含现有非 MCP Cordis plugin 和至少一个 MCP plugin。
- When: 将所选 Codex server 渲染为 DSH MCP client plugin rows，执行 apply、DSH 配置重读和 rollback。
- Then:
  1. 每个 server 对应一个有效 `@deepseek-ai/dsh-mcp-client` 配置，原有 Cordis plugin 和未选 MCP plugin 保留。
  2. 普通 `mcpServers` JSON、未知 DSH 版本或未知 patch schema 不得被标记为成功。
  3. 回滚恢复原 profile/project patch。
- Required evidence:
  1. Cordis renderer golden fixture、未知 schema 负向测试和 patch round-trip。
  2. 当前支持 DSH 版本的配置加载/列表对照及 rollback 记录。
- 方案依据: SCOPE-004、SCOPE-007；总方案 §4.3、§8.3、§9.4、§13.4、Phase 2。

### AC-006 — Pi 条件能力不伪装

- Given: 一组没有 MCP adapter 的 Pi 环境，以及一组已由用户明确安装并信任兼容 adapter 的环境。
- When: 用户选择 Pi 为目标并预览或执行迁移。
- Then:
  1. 无 adapter 时准确显示 Pi 核心不支持 MCP 及所需人工安装动作，本次 Pi 任务的“确定迁移”不可执行；改选其他目标后可另行发起单目标任务。
  2. 有兼容 adapter 时按其真实 schema 生成 diff、apply、重读并回滚；IDE Hub 不自动安装、启用或信任第三方包。
- Required evidence:
  1. 无 adapter、未知 adapter 和已支持 adapter 三类 discovery/renderer 测试。
  2. 用户确认记录、Pi adapter 原生配置重读及 rollback 记录。
- 方案依据: SCOPE-005、SCOPE-007；总方案 §4.2～§4.3、§8.3、§9.4、§13.3、Phase 2。

### AC-007 — 四种同名策略语义确定

- Given: 同名同配置、同名非重叠字段、同名字段冲突、transport/endpoint 不同四类 server。
- When: 用户分别选择跳过、重命名、合并、替换并查看最终 plan。
- Then:
  1. 跳过、重命名和替换只产生各自定义的目标变化，不改其他 server。
  2. 合并只自动处理相同或非重叠字段；冲突字段没有逐项选择时不能 apply。
  3. transport/endpoint identity 不同时合并不可选，不能生成同时含两套 endpoint 的无效 server。
- Required evidence:
  1. 四策略逐字段 golden diff 和 apply/rollback 测试。
  2. 未解决字段、不同 transport/endpoint 的 UI 与 schema 负向测试。
- 方案依据: SCOPE-006；总方案 §9.3～§9.5；进度总控 D-004。

### AC-008 — 勾选边界、单目标执行、幂等与外部改动

- Given: Codex 页面列出三个 MCP，用户只勾选其中两个并单选一个目标；目标中一个所选 MCP 已相同、另一个为新增，目标配置在预览后被外部改动。
- When: 用户点击“确定迁移”，处理外部改动后重新生成 diff 并执行，随后使用相同勾选项和目标重跑。
- Then:
  1. 任务及 receipt 只包含一个目标和两个勾选 MCP；未勾选 MCP 及其他目标应用不进入计划且保持不变。
  2. 预览后被外修改的目标拒绝覆盖；重新生成 diff 后才可再次点击“确定迁移”。
  3. 已相同 MCP 不重复追加；重复执行基于目标当前有效配置重新生成 diff，已经一致的 MCP 为 no-op。
  4. 多目标请求或空 MCP 勾选请求在 UI 与 Schema 层均不可执行。
- Required evidence:
  1. 勾选/未勾选边界、单目标 Schema、外部修改和空选择负向测试。
  2. 首次与复跑的 diff/receipt/文件计数及 rollback 对照。
- 方案依据: SCOPE-001、SCOPE-003～SCOPE-007；总方案 §9.1、§9.3、§9.5、§12～§13。

### AC-009 — 失败恢复不损坏配置

- Given: 目标配置语法错误、未知版本/schema、symlink 越界、权限失败、磁盘写入失败、进程占用及 apply 中断。
- When: 执行预览、apply、应用重启恢复或 rollback。
- Then:
  1. 每类失败报告目标、阶段和实际原因；无法安全写入时只保留计划，不产生成功 receipt。
  2. 失败目标不存在半写配置；已发生目标写入时可从本次备份恢复，源和其他目标不变。
  3. 重启后从 MCP journal 恢复真实状态，不依赖会话任务。
- Required evidence:
  1. 配置解析、路径、权限、写入和中断故障测试。
  2. 失败前后目标文件、备份、journal、源配置及无关目标指纹对照。
- 方案依据: SCOPE-007；总方案 §9.5、§10、§12～§13、§16。

### AC-010 — 独立 MCP Config Bundle 跨电脑恢复

- Given: Codex Registry 中包含所选 server，另一隔离用户目录没有源产品会话数据。
- When: 导出标准 MCP Config Bundle，在隔离目录导入，勾选需要迁移的 MCP、单选一个目标应用并点击“确定迁移”。
- Then:
  1. bundle manifest、Registry、source configs 和 checksum 完整，损坏或重复导入可识别。
  2. 导入后仍进入全局 MCP 页面选择目标和 scope；项目 cwd 由 MCP 向导独立映射。
  3. 配置包中不存在 Session、Capsule、Handoff、附件或工作区代码；会话 ZIP 也不引用 MCP bundle。
- Required evidence:
  1. 两个隔离用户目录的 export/import/checksum/重复导入 round-trip。
  2. 两类 bundle 的交叉字段负向测试和归档清单。
- 方案依据: SCOPE-008；总方案 §5、§7.5、§9.6、§13.3。

### AC-011 — 离线、无模型与目标可用性边界

- Given: IDE Hub 进程禁网且没有模型 API Key；选中本地 stdio、HTTP/SSE/WS 和需要产品登录/批准的目标配置。
- When: 扫描、生成 diff、apply、重读、stdio handshake 和 rollback。
- Then:
  1. IDE Hub 不调用模型或模型 API，不读取产品登录态；本地 stdio 验证可离线完成。
  2. HTTP/SSE/WS 默认只做配置结构与目标重读，不发联网探活；目标产品后续连接结果不冒充迁移器行为。
  3. 产品登录、OAuth、项目批准或远程 server 不可用时准确显示为迁移后的人工动作，不改写成配置迁移失败或成功连通。
- Required evidence:
  1. 禁网 E2E、进程调用记录和无模型 SDK/API 调用断言。
  2. stdio handshake 与远程 transport 未探活记录，目标账号/批准数据前后指纹。
- 方案依据: SCOPE-001～SCOPE-007；总方案 §2.3、§9.3～§9.4、§10、§13.4。

## Traceability

| Scope | Acceptance |
| --- | --- |
| SCOPE-001 | AC-001、AC-003、AC-008、AC-011 |
| SCOPE-002 | AC-002、AC-003、AC-011 |
| SCOPE-003 | AC-003、AC-004、AC-008 |
| SCOPE-004 | AC-005、AC-008 |
| SCOPE-005 | AC-006、AC-008 |
| SCOPE-006 | AC-003、AC-004、AC-007、AC-008 |
| SCOPE-007 | AC-003～AC-009、AC-011 |
| SCOPE-008 | AC-010 |

## Open decisions

- None.

## Sources and evidence

| Source | Revision or date | Confirmed facts used |
| --- | --- | --- |
| 本轮用户要求及后续修正 | 2026-09-14～2026-09-15 | Codex 为源；九个产品是单目标可选集合，不是一次全部覆盖；页面勾选需要的 MCP、单选目标应用并点击“确定迁移”；未勾选 MCP 和其他应用不变；目标 IDE 必须实际发现配置，不能只靠 Hub 自读 |
| [IDE Hub 本地会话与 MCP 迁移实现方案](../ide-hub-implementation-plan.md) | SHA-256 `d1446a27b76a115af3092124c41ac765c4fbd653308e210264c2a11d1bca95eb` | MCP 独立领域、Registry、九步迁移、四种冲突策略、目标格式、写入保护、配置包、桌面页、状态机和 Gate |
| [IDE Hub 任务进度总控](../ide-hub-master-progress.md) | 更新于 2026-09-15 | P0-09～P0-11 当前状态、MCP 原生矩阵、D-004 结论及会话/MCP Schema 隔离要求 |
| 当前工程 `src/mcp/`、`src/mcp-fingerprint.ts`、`prototype/index.html`、`prototype/app.js` | 2026-09-15 工作树 | 九个目标产品标识、真实 MCP 页面、目标 adapter、native verifier、journal/rollback 和独立 bundle |
| 本机安装的 Qoder 双版 1.29.0、Cursor 3.19.7、DSH rc.6、ZCode 3.10.2、Claude 2.1.268、CodeBuddy 双版 4.12.0 | 2026-09-15 原生设置页、CLI/app-server、effective cache 与扩展日志 | Qoder 和 CodeBuddy 实际 user 配置路径；八个支持目标的原生发现结果；Pi 无内置 MCP |
| 总方案 §19 的 Codex、Qoder、Cursor、Claude Code、ZCode、CodeBuddy、DeepSeek Harness、Pi 官方资料索引 | 总方案调研基线 2026-09-01；实现时按实际安装版本复核 | 各产品 MCP 配置入口、scope/transport 差异、DSH Cordis 映射和 Pi 无内置 MCP 边界 |
