"use strict";

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

const PRODUCT_META = {
  codex: { name: "Codex", label: "C", color: "#8b949e" },
  qoder: { name: "Qoder 国际版", label: "Q", color: "#4f8cff" },
  qodercn: { name: "Qoder CN", label: "QCN", color: "#22b573" },
  cursor: { name: "Cursor", label: "Cu", color: "#f0883e" },
  claude: { name: "Claude Code", label: "Cl", color: "#d97757" },
  codebuddy: { name: "CodeBuddy 国际版", label: "B", color: "#7c6ff0" },
  codebuddycn: { name: "CodeBuddy CN", label: "BCN", color: "#9b74f3" },
  dsh: { name: "DeepSeek Harness", label: "D", color: "#35b6e8" },
  zcode: { name: "ZCode", label: "Z", color: "#22c3b5" },
  pi: { name: "Pi", label: "π", color: "#c084fc" },
};

const PRODUCT_ORDER = ["codex", "qoder", "qodercn", "cursor", "claude", "codebuddy", "codebuddycn", "dsh", "zcode", "pi"];
const MIGRATION_TARGETS = {
  "claude-code": { productId: "claude", stateKey: "claude", name: "Claude Code" },
  pi: { productId: "pi", stateKey: "pi", name: "Pi" },
  zcode: { productId: "zcode", stateKey: "zcode", name: "ZCode" },
  "qoder-international": {
    productId: "qoder",
    stateKey: "qoder",
    name: "Qoder 国际版",
  },
  "qoder-cn": {
    productId: "qodercn",
    stateKey: "qoderCn",
    name: "Qoder CN",
  },
  cursor: {
    productId: "cursor",
    stateKey: "cursor",
    name: "Cursor",
  },
  "deepseek-harness": {
    productId: "dsh",
    stateKey: "dsh",
    name: "DeepSeek Harness",
  },
  "codebuddy-international": {
    productId: "codebuddy",
    stateKey: "codeBuddyInternational",
    name: "CodeBuddy 国际版",
  },
  "codebuddy-cn": {
    productId: "codebuddycn",
    stateKey: "codeBuddyCn",
    name: "CodeBuddy CN",
  },
};
const MIGRATION_STEPS = ["源会话", "目标", "空闲检查", "投影预览", "损失报告", "写入计划", "执行"];
const STUB_WIZARDS = {
  ovExport: { label: "ZIP 导出", steps: ["会话与工作区", "包含项", "预览", "生成"] },
  ovImport: { label: "ZIP 导入", steps: ["ZIP 检查", "路径映射", "目标 Agent", "写入执行"] },
  ovMcpMigration: { label: "MCP 配置迁移", steps: ["源与目标", "配置差异", "执行"] },
};

const state = {
  view: "sessions",
  product: "all",
  threads: [],
  qoder: null,
  qoderCn: null,
  cursor: null,
  dsh: null,
  zcode: null,
  zcodePreview: null,
  pi: null,
  piPreview: null,
  piPreviewGeneration: 0,
  claude: null,
  claudePreview: null,
  claudePreviewGeneration: 0,
  codeBuddyInternational: null,
  codeBuddyCn: null,
  codeBuddyPreview: null,
  codeBuddyPreviewGeneration: 0,
  current: null,
  selected: new Set(),
  search: "",
  scanning: false,
  migrating: false,
  migrationThread: null,
  migrationTarget: "qoder-international",
  migrationStep: 1,
  migrationVisited: new Set([1]),
  migrationStarted: false,
  lastResult: null,
  lastError: null,
};

function migrationTarget(product = state.migrationTarget) {
  return MIGRATION_TARGETS[product] ?? MIGRATION_TARGETS["qoder-international"];
}

function targetInstallation(product = state.migrationTarget) {
  return state[migrationTarget(product).stateKey];
}

function defaultMigrationTarget() {
  if (state.qoder?.installed) return "qoder-international";
  if (state.qoderCn?.installed) return "qoder-cn";
  if (state.cursor?.installed && state.cursor?.compatible) return "cursor";
  if (state.zcode?.installed && state.zcode?.compatible) return "zcode";
  if (state.pi?.installed && state.pi?.compatible) return "pi";
  if (state.claude?.installed && state.claude?.compatible) return "claude-code";
  if (state.codeBuddyInternational?.installed && state.codeBuddyInternational?.compatible) return "codebuddy-international";
  if (state.codeBuddyCn?.installed && state.codeBuddyCn?.compatible) return "codebuddy-cn";
  if (state.dsh?.installed && state.dsh?.compatible && state.dsh?.bridgeCompatible) {
    return "deepseek-harness";
  }
  return null;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function titleOf(thread) {
  return thread?.name?.trim() || thread?.preview?.trim() || "未命名 Codex 会话";
}

function formatTime(value) {
  if (value === null || value === undefined) return "未知时间";
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusOf(thread) {
  if (thread?.status?.type === "active") return { text: "运行中", className: "running" };
  if (thread?.migratable) return { text: "可迁移", className: "idle" };
  return { text: "不可迁移", className: "none" };
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  $("#toasts").append(item);
  window.setTimeout(() => {
    item.classList.add("out");
    window.setTimeout(() => item.remove(), 260);
  }, 2800);
}

function visibleThreads() {
  const query = state.search.trim().toLocaleLowerCase();
  return state.threads.filter((thread) => {
    if (state.product !== "all" && state.product !== "codex") return false;
    if (!query) return true;
    return `${titleOf(thread)}\n${thread.preview ?? ""}\n${thread.cwd ?? ""}\n${thread.path ?? ""}`
      .toLocaleLowerCase()
      .includes(query);
  });
}

function renderProducts() {
  const codexVersion = state.threads.find((thread) => thread.cliVersion)?.cliVersion;
  const products = PRODUCT_ORDER.map((id) => {
    if (id === "codex") {
      return {
        id,
        version: codexVersion ? `codex-cli ${codexVersion}` : "本地 App Server",
        note: state.scanning ? "正在扫描" : `${state.threads.length} 个真实会话`,
        status: state.threads.length > 0 ? "ok" : "warn",
      };
    }
    if (id === "qoder") {
      return {
        id,
        version: state.qoder?.installed ? state.qoder.version : "未安装",
        note: state.qoder?.installed ? "国际版 runtime 已发现" : "未发现 Qoder 国际版",
        status: state.qoder?.installed ? "ok" : "none",
      };
    }
    if (id === "qodercn") {
      return {
        id,
        version: state.qoderCn?.installed ? state.qoderCn.version : "未安装",
        note: state.qoderCn?.installed ? "CN runtime 已发现" : "未发现 Qoder CN",
        status: state.qoderCn?.installed ? "ok" : "none",
      };
    }
    if (id === "cursor") {
      const usable = state.cursor?.installed && state.cursor?.compatible;
      return {
        id,
        version: state.cursor?.installed ? state.cursor.version : "未安装",
        note: usable
          ? "Chat JSON v1 原生迁移已启用"
          : state.cursor?.installed
            ? state.cursor.compatibilityError
            : "未发现 Cursor",
        status: usable ? "ok" : "none",
      };
    }
    if (id === "pi") {
      return { id, version: state.pi?.version ?? "未安装",
        note: state.pi?.compatible ? "JSONL v3 原生历史 · 终端续聊" : state.pi?.compatibilityError ?? "未发现 Pi",
        status: state.pi?.compatible ? "ok" : "warn" };
    }
    if (id === "claude") {
      return { id, version: state.claude?.version ?? "未安装",
        note: state.claude?.compatible ? "原生 JSONL 历史 · 终端续聊" : state.claude?.compatibilityError ?? "未发现 Claude Code",
        status: state.claude?.compatible ? "ok" : "warn" };
    }
    if (id === "codebuddy" || id === "codebuddycn") {
      const installation = id === "codebuddy" ? state.codeBuddyInternational : state.codeBuddyCn;
      const edition = id === "codebuddy" ? "国际版" : "CN";
      return {
        id,
        version: installation?.installed ? installation.version : "未安装",
        note: installation?.compatible
          ? `官方 History JSON Import · ${edition} 独立回读`
          : installation?.installed
            ? installation.compatibilityError
            : `未发现 CodeBuddy ${edition}`,
        status: installation?.compatible ? "ok" : installation?.installed ? "warn" : "none",
      };
    }
    if (id === "zcode") {
      return { id, version: state.zcode?.version ?? "未安装",
        note: state.zcode?.compatible ? "原生逐条导入 · 同目录桌面任务" : state.zcode?.compatibilityError ?? "未发现 ZCode",
        status: state.zcode?.compatible ? "ok" : "warn" };
    }
    if (id === "dsh") {
      const usable = state.dsh?.installed
        && state.dsh?.compatible
        && state.dsh?.bridgeCompatible;
      return {
        id,
        version: state.dsh?.installed ? state.dsh.version : "未安装",
        note: usable
          ? `SessionEvent v0 原生迁移已启用 · Bridge ${state.dsh.bridgeVersion}`
          : state.dsh?.installed && state.dsh?.compatible
            ? "已发现 DSH；需启用本地迁移桥"
            : state.dsh?.installed
              ? state.dsh.compatibilityError
              : "未发现 DeepSeek Harness",
        status: usable ? "ok" : state.dsh?.installed ? "warn" : "none",
      };
    }
    return { id, version: "会话扫描未接入", note: "未实现", status: "none" };
  });

  const allItem = `
    <button class="product-item all ${state.product === "all" ? "active" : ""}" data-pid="all">
      <span class="pi-avatar">∑</span>
      <span class="pi-main">
        <span class="pi-name-row"><span class="pi-name">全部产品</span><span class="pi-count">${state.threads.length} 个会话</span></span>
        <span class="pi-ver">当前仅接入 Codex</span>
      </span>
    </button>`;
  const items = products.map((product) => {
    const meta = PRODUCT_META[product.id];
    const count = product.id === "codex" ? `${state.threads.length} 个会话` : "—";
    return `
      <button class="product-item ${state.product === product.id ? "active" : ""}" data-pid="${product.id}">
        <span class="pi-avatar" style="background:${meta.color}">${meta.label}</span>
        <span class="pi-main">
          <span class="pi-name-row"><span class="pi-name">${meta.name}</span><span class="pi-count">${count}</span></span>
          <span class="pi-ver">${esc(product.version)}</span>
          <span class="pi-note">${esc(product.note)}</span>
        </span>
        <span class="status-dot ${product.status === "ok" ? "idle" : product.status === "warn" ? "running" : "none"}"></span>
      </button>`;
  }).join("");

  $("#productList").innerHTML = allItem + items;
  $$("#productList .product-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.product = button.dataset.pid;
      renderProducts();
      renderSessions();
    });
  });
}

function renderSessions() {
  const container = $("#sessionList");
  if (state.scanning) {
    container.innerHTML = '<div class="list-placeholder"><span class="inline-spinner"></span>正在通过 Codex App Server 扫描本地会话…</div>';
    return;
  }
  if (state.product !== "all" && state.product !== "codex") {
    container.innerHTML = `<div class="list-placeholder"><span class="badge b-warn">未实现</span>${PRODUCT_META[state.product].name} 会话扫描尚未接入。</div>`;
    return;
  }

  const threads = visibleThreads();
  if (threads.length === 0) {
    container.innerHTML = '<div class="list-placeholder">没有匹配的 Codex 本地会话。</div>';
    return;
  }

  const groups = new Map();
  for (const thread of threads) {
    const workspace = thread.cwd || "未知工作区";
    if (!groups.has(workspace)) groups.set(workspace, []);
    groups.get(workspace).push(thread);
  }
  container.innerHTML = [...groups.entries()].map(([workspace, items]) => `
    <div class="ws-group">
      <div class="ws-head">
        <span class="ws-path" title="${esc(workspace)}">${esc(workspace)}</span>
        <span class="branch-badge">固定路径</span>
        <span class="ws-meta">${items.length} 个会话</span>
      </div>
      <div class="sess-list">
        ${items.map((thread) => {
          const status = statusOf(thread);
          return `
            <div class="sess-row ${thread.id === state.current ? "active" : ""} ${state.selected.has(thread.id) ? "checked" : ""} ${status.className === "running" ? "running-row" : ""}" data-sid="${esc(thread.id)}">
              <label class="sess-check"><input type="checkbox" data-sid="${esc(thread.id)}" ${state.selected.has(thread.id) ? "checked" : ""} ${thread.migratable ? "" : "disabled"}></label>
              <span class="prod-tag codex">Codex</span>
              <span class="sess-info">
                <span class="sess-title">${esc(titleOf(thread))}</span>
                <span class="sess-meta">${formatTime(thread.updatedAt)} · ${esc(thread.historyMode || "未知历史模式")} · ${status.text}</span>
              </span>
              <span class="status-dot ${status.className}"></span>
            </div>`;
        }).join("")}
      </div>
    </div>`).join("");

  $$("#sessionList .sess-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.matches("input[type=checkbox]")) return;
      state.current = row.dataset.sid;
      state.lastResult = null;
      state.lastError = null;
      renderSessions();
      renderDetail();
    });
    const checkbox = $("input[type=checkbox]", row);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(checkbox.dataset.sid);
      else state.selected.delete(checkbox.dataset.sid);
      row.classList.toggle("checked", checkbox.checked);
      updateSelectionBar();
    });
  });
}

function updateSelectionBar() {
  $("#selectionBar").hidden = state.selected.size === 0;
  $("#selCount").textContent = String(state.selected.size);
  $("#selMigrate").textContent = state.selected.size === 1 ? "开始迁移" : "仅支持单会话迁移";
  $("#selMigrate").disabled = state.selected.size !== 1;
}

function renderDetail() {
  const panel = $("#detailPanel");
  const thread = state.threads.find((item) => item.id === state.current);
  if (!thread) {
    panel.innerHTML = `
      <div class="detail-empty">
        <span class="tb-logo">IH</span>
        <h3>选择一个真实 Codex 会话</h3>
        <p>目标原生会话会固定创建在源会话的同一工作区。</p>
      </div>`;
    return;
  }
  const status = statusOf(thread);
  const canMigrateInternational = thread.migratable && state.qoder?.installed && !state.migrating;
  const canMigrateCn = thread.migratable && state.qoderCn?.installed && !state.migrating;
  const canMigrateCursor = thread.migratable && state.cursor?.installed && state.cursor?.compatible && !state.migrating;
  const canMigrateZcode = thread.migratable && state.zcode?.compatible && !state.migrating;
  const canMigratePi = thread.migratable && state.pi?.compatible && !state.migrating;
  const canMigrateClaude = thread.migratable && state.claude?.compatible && !state.migrating;
  const canMigrateCodeBuddyInternational = thread.migratable && state.codeBuddyInternational?.compatible && !state.migrating;
  const canMigrateCodeBuddyCn = thread.migratable && state.codeBuddyCn?.compatible && !state.migrating;
  const canMigrateDsh = thread.migratable
    && state.dsh?.installed
    && state.dsh?.compatible
    && state.dsh?.bridgeCompatible
    && !state.migrating;
  const canPrepareDsh = state.dsh?.installed
    && state.dsh?.compatible
    && !state.dsh?.bridgeCompatible
    && !state.migrating;
  const qoderInternationalStatus = state.qoder?.installed
    ? `Qoder 国际版 ${esc(state.qoder.version)} 已发现`
    : "未发现 Qoder 国际版，暂不能迁移";
  const qoderCnStatus = state.qoderCn?.installed
    ? `Qoder CN ${esc(state.qoderCn.version)} 已发现`
    : "未发现 Qoder CN，暂不能迁移";
  const cursorStatus = state.cursor?.installed
    ? state.cursor.compatible
          ? `Cursor ${esc(state.cursor.version)} 版本指纹兼容，可执行原生迁移`
      : `Cursor ${esc(state.cursor.version)} 不兼容：${esc(state.cursor.compatibilityError)}`
    : "未发现 Cursor，暂不能迁移";
  const dshStatus = state.dsh?.installed
    ? state.dsh.compatible
      ? state.dsh.bridgeCompatible
        ? `DeepSeek Harness ${esc(state.dsh.version)} 与本地迁移桥已就绪`
        : `DeepSeek Harness ${esc(state.dsh.version)} 已发现，需先启用本地迁移桥`
      : `DeepSeek Harness ${esc(state.dsh.version)} 不兼容：${esc(state.dsh.compatibilityError)}`
    : "未发现 DeepSeek Harness，暂不能迁移";
  const codeBuddyInternationalStatus = state.codeBuddyInternational?.installed
    ? state.codeBuddyInternational.compatible
      ? `CodeBuddy 国际版 ${esc(state.codeBuddyInternational.version)} 官方归档迁移已就绪`
      : `CodeBuddy 国际版不兼容：${esc(state.codeBuddyInternational.compatibilityError)}`
    : "未发现 CodeBuddy 国际版";
  const codeBuddyCnStatus = state.codeBuddyCn?.installed
    ? state.codeBuddyCn.compatible
      ? `CodeBuddy CN ${esc(state.codeBuddyCn.version)} 官方归档迁移已就绪`
      : `CodeBuddy CN 不兼容：${esc(state.codeBuddyCn.compatibilityError)}`
    : "未发现 CodeBuddy CN";
  const resultTarget = migrationTarget(state.lastResult?.continuation?.product);
  const lastResultTitle = state.lastResult?.status === "WAITING_TARGET_IMPORT"
    ? `${esc(resultTarget.name)} 归档已生成，等待官方 Import`
    : state.lastResult?.status === "CANCELLED"
      ? `${esc(resultTarget.name)} Import 等待已取消，归档保留`
      : `${esc(resultTarget.name)} 原生历史已创建并回读校验`;
  const lastResultIcon = state.lastResult?.status === "WAITING_TARGET_IMPORT"
    ? "…"
    : state.lastResult?.status === "CANCELLED" ? "×" : "✓";
  const lastResultIconClass = state.lastResult?.status === "COMPLETED" ? "ok" : "";
  const result = state.lastResult?.sourceThreadId === thread.id ? `
    <div class="detail-sec">
      <div class="ds-label">最近迁移结果</div>
      <div class="result-card compact-result">
        <div class="result-icon ${lastResultIconClass}">${lastResultIcon}</div>
        <div>
          <strong>${lastResultTitle}</strong>
          <div class="muted-note mono">${state.lastResult.targetSessionId ? `Session ${esc(state.lastResult.targetSessionId)}` : `Archive ${esc(state.lastResult.details.codeBuddy?.archiveId ?? "")}`}</div>
          <div class="muted-note">${state.lastResult.details.projectedTurnCount} 轮 · ${state.lastResult.details.projectedMessageCount} 条消息 · MCP 未修改</div>
        </div>
      </div>
    </div>` : "";
  const error = state.lastError ? `
    <div class="banner banner-error"><b>${esc(state.lastError.code)}</b><br>${esc(state.lastError.message)}</div>` : "";

  panel.innerHTML = `
    <div class="detail-head">
      <div class="detail-prod"><span class="prod-tag codex">Codex</span><span class="badge ${status.className === "idle" ? "b-ok" : "b-warn"}">${status.text}</span></div>
      <h3>${esc(titleOf(thread))}</h3>
      <div class="detail-meta">${formatTime(thread.updatedAt)} · ${esc(thread.historyMode || "未知历史模式")}</div>
    </div>
    <div class="detail-sec">
      <div class="ds-label">工作区（目标路径固定相同）</div>
      <div class="ds-path mono">${esc(thread.cwd || "未知")}</div>
    </div>
    <div class="detail-sec">
      <div class="ds-label">真实会话预览</div>
      <div class="msg-bubble user">${esc(thread.preview || "该会话没有可用预览。")}</div>
    </div>
    <div class="detail-sec">
      <div class="ds-label">源数据</div>
      <div class="file-row"><span class="fp" title="${esc(thread.path || "")}">${esc(thread.path || "无本地持久化路径")}</span></div>
      <div class="muted-note">Thread ID：<span class="mono">${esc(thread.id)}</span></div>
      <div class="muted-note">${qoderInternationalStatus}</div>
      <div class="muted-note">${qoderCnStatus}</div>
      <div class="muted-note">${cursorStatus}</div>
      <div class="muted-note">${dshStatus}</div>
      <div class="muted-note">${esc(state.zcode?.compatible ? `ZCode ${state.zcode.version} 原生导入已就绪` : state.zcode?.compatibilityError ?? "未发现 ZCode")}</div>
      <div class="muted-note">${esc(state.pi?.compatible ? `Pi ${state.pi.version} · 原生历史 / 终端续聊` : state.pi?.compatibilityError ?? "未发现 Pi")}</div>
      <div class="muted-note">${esc(state.claude?.compatible ? `Claude Code ${state.claude.version} · 原生历史 / 终端续聊` : state.claude?.compatibilityError ?? "未发现 Claude Code")}</div>
      <div class="muted-note">${codeBuddyInternationalStatus}</div>
      <div class="muted-note">${codeBuddyCnStatus}</div>
    </div>
    <div class="detail-sec">
      <div class="ds-label">迁移边界</div>
      <div class="verif-row"><span class="vi ok">✓</span><span>只读 Codex 源会话，迁移前后复核源文件</span></div>
      <div class="verif-row"><span class="vi ok">✓</span><span>写入目标 IDE 原生 User / Assistant 历史并回读校验</span></div>
      <div class="verif-row"><span class="vi ok">✓</span><span>不调用模型，不迁移或修改 MCP 配置；仅校验内容指纹</span></div>
    </div>
    ${result}${error}
    <div class="detail-actions">
      <button class="btn btn-primary" id="detailMigrateInternational" ${canMigrateInternational ? "" : "disabled"}>迁移到 Qoder 国际版…</button>
      <button class="btn btn-ghost" id="detailMigrateCn" ${canMigrateCn ? "" : "disabled"}>迁移到 Qoder CN…</button>
      <button class="btn btn-ghost" id="detailMigrateCursor" ${canMigrateCursor ? "" : "disabled"}>迁移到 Cursor…</button>
      <button class="btn btn-ghost" id="detailMigrateZcode" ${canMigrateZcode ? "" : "disabled"}>迁移到 ZCode…</button>
      <button class="btn btn-ghost" id="detailMigratePi" ${canMigratePi ? "" : "disabled"}>迁移到 Pi…</button>
      <button class="btn btn-ghost" id="detailMigrateClaude" ${canMigrateClaude ? "" : "disabled"}>迁移到 Claude Code…</button>
      <button class="btn btn-ghost" id="detailMigrateCodeBuddyInternational" ${canMigrateCodeBuddyInternational ? "" : "disabled"}>迁移到 CodeBuddy 国际版…</button>
      <button class="btn btn-ghost" id="detailMigrateCodeBuddyCn" ${canMigrateCodeBuddyCn ? "" : "disabled"}>迁移到 CodeBuddy CN…</button>
      ${canPrepareDsh
        ? '<button class="btn btn-ghost" id="detailPrepareDsh">启用 DSH 本地迁移桥…</button>'
        : `<button class="btn btn-ghost" id="detailMigrateDsh" ${canMigrateDsh ? "" : "disabled"}>迁移到 DeepSeek Harness…</button>`}
      <button class="btn btn-ghost" id="detailExport">导出为 ZIP… <span class="badge b-warn">未实现</span></button>
    </div>`;
  $("#detailMigrateInternational").addEventListener("click", () => openMigration(thread, "qoder-international"));
  $("#detailMigrateCn").addEventListener("click", () => openMigration(thread, "qoder-cn"));
  $("#detailMigrateCursor").addEventListener("click", () => openMigration(thread, "cursor"));
  $("#detailMigrateZcode").addEventListener("click", () => openMigration(thread, "zcode"));
  $("#detailMigratePi").addEventListener("click", () => openMigration(thread, "pi"));
  $("#detailMigrateClaude").addEventListener("click", () => openMigration(thread, "claude-code"));
  $("#detailMigrateCodeBuddyInternational").addEventListener("click", () => openMigration(thread, "codebuddy-international"));
  $("#detailMigrateCodeBuddyCn").addEventListener("click", () => openMigration(thread, "codebuddy-cn"));
  $("#detailPrepareDsh")?.addEventListener("click", () => void prepareDshBridge());
  $("#detailMigrateDsh")?.addEventListener("click", () => openMigration(thread, "deepseek-harness"));
  $("#detailExport").addEventListener("click", () => openStubWizard("ovExport"));
}

function switchView(view) {
  state.view = view;
  $$(".rail-btn").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
}

function buildStepBar(overlay, steps, active = 1, visited = new Set([1])) {
  const bar = $("[data-steps]", overlay);
  bar.innerHTML = steps.map((label, index) => {
    const step = index + 1;
    const classes = ["wstep"];
    if (step === active) classes.push("current");
    if (visited.has(step)) classes.push("visited");
    return `<button class="${classes.join(" ")}" data-step="${step}"><span class="ws-n">${step}</span>${label}</button>`;
  }).join("");
}

function chosenThread() {
  if (state.selected.size === 1) {
    const [id] = state.selected;
    return state.threads.find((thread) => thread.id === id) ?? null;
  }
  return state.threads.find((thread) => thread.id === state.current)
    ?? state.threads.find((thread) => thread.migratable)
    ?? null;
}

function openMigration(thread = chosenThread(), requestedTarget = null) {
  if (!thread) {
    toast("没有可迁移的 Codex 会话", "warn");
    return;
  }
  if (!thread.migratable) {
    toast("该会话正在运行或没有可持久化源文件，暂不能迁移", "warn");
    return;
  }
  const targetProduct = requestedTarget ?? defaultMigrationTarget();
  if (targetProduct === null) {
    toast("未发现可用迁移目标，请查看产品安装和兼容状态", "warn");
    return;
  }
  const target = migrationTarget(targetProduct);
  const installation = targetInstallation(targetProduct);
  if (!installation?.installed || installation.compatible === false) {
    toast(`未发现 ${target.name}，请先安装目标 IDE`, "warn");
    return;
  }
  state.migrationThread = thread;
  state.migrationTarget = targetProduct;
  state.zcodePreview = null;
  state.piPreview = null;
  state.piPreviewGeneration += 1;
  state.claudePreview = null;
  state.claudePreviewGeneration += 1;
  state.codeBuddyPreview = null;
  state.codeBuddyPreviewGeneration += 1;
  state.migrationStep = 1;
  state.migrationVisited = new Set([1]);
  state.migrationStarted = false;
  state.lastError = null;
  $("#migConfirm").checked = false;
  $("#migResult").hidden = true;
  $("#migTimeline").replaceChildren();
  renderMigrationContext(thread);
  $("#ovMigration").classList.add("open");
  goMigrationStep(1);
}

function renderMigrationContext(thread) {
  const overlay = $("#ovMigration");
  const target = migrationTarget();
  const installation = targetInstallation();
  const isCursor = state.migrationTarget === "cursor";
  const isDsh = state.migrationTarget === "deepseek-harness";
  const isZcode = state.migrationTarget === "zcode";
  const isPi = state.migrationTarget === "pi";
  const isClaude = state.migrationTarget === "claude-code";
  const isCodeBuddy = state.migrationTarget === "codebuddy-international" || state.migrationTarget === "codebuddy-cn";
  $(".wiz-sub", overlay).textContent = `Codex → ${target.name} · 原生 User / Assistant 历史`;
  const status = statusOf(thread);
  const first = $('[data-pane="1"]', overlay);
  first.innerHTML = `
    <h3 class="pane-title">确认真实源会话</h3>
    <p class="pane-sub">迁移是<b>复制并分叉</b>。Codex 源会话保持不变，${esc(target.name)} 在同一工作区创建一个新会话。</p>
    <div class="card">
      <div class="sess-summary-head"><span class="prod-tag codex">Codex</span><strong>${esc(titleOf(thread))}</strong><span class="badge b-ok">${status.text}</span></div>
      <div class="kv-grid cols3">
        <div class="kv-item"><div class="kv-k">工作区</div><div class="kv-v mono">${esc(thread.cwd)}</div></div>
        <div class="kv-item"><div class="kv-k">更新时间</div><div class="kv-v">${formatTime(thread.updatedAt)}</div></div>
        <div class="kv-item"><div class="kv-k">历史模式</div><div class="kv-v">${esc(thread.historyMode || "未知")}</div></div>
        <div class="kv-item"><div class="kv-k">Thread ID</div><div class="kv-v mono">${esc(thread.id)}</div></div>
        <div class="kv-item"><div class="kv-k">Codex 版本</div><div class="kv-v">${esc(thread.cliVersion || "未知")}</div></div>
        <div class="kv-item"><div class="kv-k">源状态</div><div class="kv-v ok">可创建一致性快照</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">源文件</div>
      <div class="mono path-block">${esc(thread.path)}</div>
      <div class="muted-note">执行时读取完整会话，记录源文件大小、mtime 与 sha256；写入完成后再次复核，源文件变化会直接报错。</div>
    </div>`;

  $$("#tgtGrid .tcard", overlay).forEach((card) => {
    const cardTarget = MIGRATION_TARGETS[card.dataset.target];
    const cardInstallation = cardTarget ? state[cardTarget.stateKey] : null;
    const implemented = cardTarget !== undefined;
    const available = implemented
      && cardInstallation?.installed
      && cardInstallation?.compatible !== false
      && (card.dataset.target !== "deepseek-harness" || cardInstallation?.bridgeCompatible);
    card.disabled = !available;
    card.classList.toggle("selected", card.dataset.target === state.migrationTarget);
    const flag = $(".tcard-flag", card) ?? document.createElement("span");
    flag.className = "tcard-flag";
    flag.textContent = implemented
      ? available
        ? `已发现 ${cardInstallation.version}`
        : cardInstallation?.installed
          ? card.dataset.target === "deepseek-harness"
            && cardInstallation?.compatible
            && !cardInstallation?.bridgeCompatible
            ? "迁移桥未启用"
            : "版本不兼容"
          : "未安装"
      : "未实现";
    if (!flag.parentElement) card.append(flag);
    card.onclick = available
      ? () => {
        state.migrationTarget = card.dataset.target;
        state.codeBuddyPreview = null;
        state.codeBuddyPreviewGeneration += 1;
        $("#migConfirm").checked = false;
        renderMigrationContext(thread);
        goMigrationStep(state.migrationStep);
      }
      : null;
  });
  const workspaceSelect = $('[data-pane="2"] .ws-select select', overlay);
  workspaceSelect.innerHTML = `<option selected>${esc(thread.cwd)} — 与源工作区相同</option>`;
  workspaceSelect.disabled = true;
  $$('[data-pane="2"] .rcard', overlay).forEach((card) => {
    const input = $("input", card);
    const implemented = input.value === "std";
    input.checked = implemented;
    input.disabled = !implemented;
    card.classList.toggle("selected", implemented);
    card.classList.toggle("disabled", !implemented);
    if (implemented) {
      $(".rcard-head", card).textContent = isZcode || isPi || isClaude || isCodeBuddy ? "完整原生历史" : "标准";
      $(".rcard-desc", card).textContent = isZcode || isPi || isClaude || isCodeBuddy
        ? "全部可见消息 · 保留原顺序与独立角色"
        : "Handoff + 最近 N 轮 + 关键证据";
    }
  });
  const targetNotes = $$('[data-pane="2"] .muted-note', overlay);
  targetNotes[0].textContent = `目标路径不可修改：${target.name} 会话固定创建在源会话的同一工作区。`;
  targetNotes[1].textContent = isClaude
    ? `Claude Code ${installation.version} · 新建独立原生 JSONL；迁移无需 Key。在终端按确切 ID 恢复，不是 Claude Desktop 或 IDE 扩展。`
    : isCodeBuddy
    ? `${target.name} ${installation.version} · ${installation.bundleId}；生成官方 codebuddy.conversation v1 JSON，当前 IDE Hub 不调用模型。需要在该版本 History 的 Import 对话框选择一次归档。`
    : isPi
    ? `Pi ${installation.version} · SessionManager / JSONL v3；迁移不调用模型。结果入口在终端打开确切会话，不需要手工复制历史。`
    : isCursor
    ? `当前目标使用 ${installation.bundleId} · Cursor ${installation.version} · Chat JSON v1；本地桥只调用 IDE 内置导入，不安装 Agent CLI。`
    : isZcode
      ? `ZCode ${installation.version} · 原生 importedHistory；协议要求 claudeCode 兼容标签，实际来源始终是 Codex。迁移无需 Key。`
    : isDsh
      ? `当前目标使用 ${installation.runtimeId} ${installation.version} · Bridge ${installation.bridgeVersion}；在 DSH 进程内创建 SessionEvent v0 原生会话。`
      : `当前目标使用 ${installation.bundleId} 的独立本地 runtime；迁移不调用模型，写入完整可见 User / Assistant 历史。`;

  const fourth = $('[data-pane="4"]', overlay);
  fourth.innerHTML = `
    <h3 class="pane-title">真实会话摘要与投影规则</h3>
    <p class="pane-sub">此处只展示扫描阶段已经读取到的元数据。精确轮次和消息数会在执行完整读取后显示，不使用演示数字。</p>
    <div class="handoff">
      <div class="ho-sec"><div class="ho-label">会话标题</div><div class="ho-body">${esc(titleOf(thread))}</div></div>
      <div class="ho-sec"><div class="ho-label">扫描预览</div><div class="ho-body">${esc(thread.preview || "无预览")}</div></div>
      <div class="ho-grid">
        <div class="ho-sec"><div class="ho-label">源工作区</div><div class="ho-body sm mono">${esc(thread.cwd)}</div></div>
        <div class="ho-sec"><div class="ho-label">目标工作区</div><div class="ho-body sm mono">${esc(thread.cwd)}</div></div>
        <div class="ho-sec"><div class="ho-label">写入方式</div><div class="ho-body sm">${isCodeBuddy ? "CodeBuddy 官方 History Import · 单会话 JSON v1" : isZcode ? "ZCode session/create(importedHistory) + 精确桌面任务登记" : isCursor ? "Cursor developer.bulkImportChats · Chat JSON v1" : isDsh ? "DSH ctx.agents.create + SessionEvent v0 seed + workspace.attachSession" : "Qoder session/new + appendHistoryTurn"}</div></div>
        <div class="ho-sec"><div class="ho-label">模型调用</div><div class="ho-body sm ok">${isCodeBuddy ? "只用 desktop launcher 打开 A；禁止 buddy chat / buddycn chat" : isZcode ? "禁止 session/send；迁移子进程禁止网络" : isCursor ? "禁止 startComposerPrompt 与 sendToAgent" : isDsh ? "禁止 agent.followup / steer 与 session.prompt" : "禁止 session/prompt 与 chat/ask"}</div></div>
      </div>
    </div>
    <div class="banner banner-info">完整读取后，只把可见 User / Assistant 正文投影到 ${esc(target.name)} 原生历史；其他事件保留在本地 Capsule 审计文件中。</div>`;

  $('[data-pane="5"] tbody', overlay).innerHTML = `
    <tr><td>可见 User / Assistant 正文</td><td><span class="loss-chip l-full">原生投影</span></td><td>${isZcode ? "逐条保留原顺序，不合并连续 Assistant；新进程重开后全量回读" : `按用户消息边界组成 ${esc(target.name)} 轮次；执行后逐轮回读正文`}</td></tr>
    <tr><td>工作区路径</td><td><span class="loss-chip l-full">固定相同</span></td><td class="mono">${esc(thread.cwd)}</td></tr>
    <tr><td>工具调用及其他事件</td><td><span class="loss-chip l-arch">仅归档</span></td><td>写入本地 Capsule，不伪装成 ${esc(target.name)} 待执行工具调用</td></tr>
    <tr><td>本地 seed 摘要</td><td><span class="loss-chip l-summ">有预算上限</span></td><td>goal-recent-plan-v1；执行结果提供实际省略统计</td></tr>
    <tr><td>系统指令 / 隐藏内容</td><td><span class="loss-chip l-skip">不迁移</span></td><td>不复制供应商隐藏指令</td></tr>
    <tr><td>模型与账号</td><td><span class="loss-chip l-auth">使用目标 IDE</span></td><td>IDE Hub 不调用模型，不使用或复制 API Key</td></tr>
    <tr><td>MCP 配置</td><td><span class="loss-chip l-skip">不处理</span></td><td>会话迁移与全局 MCP 配置完全分离</td></tr>`;

  $('[data-pane="6"] .pane-sub', overlay).textContent = isZcode
    ? "首次写入前备份两库（含 WAL）。正文与索引分步提交；失败不报成功，复跑仅恢复本次目标，不整库回滚。"
    : isCodeBuddy
      ? "IDE Hub 只生成官方单会话 JSON 并打开正确版本的 A；用户完成 History Import 后，按目标版本日志、originalId、A 的 MD5 分区和逐消息文件回读。"
    : "执行前记录源快照和写入计划；失败结果与目标清理情况保存在迁移记录中。";
  $('[data-pane="6"] .ops', overlay).innerHTML = `
    <div class="op-row"><span class="op-badge b-backup">只读</span><div class="op-main"><code>${esc(thread.path)}</code><div class="op-sub">迁移前后 fingerprint 必须一致</div></div></div>
    <div class="op-row"><span class="op-badge b-create">创建</span><div class="op-main"><code>IDE Hub/migrations/&lt;新 migration id&gt;/</code><div class="op-sub">source snapshot · capsule · projection · loss report · journal</div></div></div>
    <div class="op-row"><span class="op-badge b-create">创建</span><div class="op-main"><code>${isCodeBuddy ? `${esc(target.name)} 官方 JSON 归档` : `${esc(target.name)}原生会话`}</code><div class="op-sub">工作区：${esc(thread.cwd)} · ${isCodeBuddy ? "目标官方 Import 写入，Hub 不直接修改私有 History" : "逐轮写入、回读和历史列表可见性校验"}</div></div></div>
    <div class="op-row"><span class="op-badge b-conf">不修改</span><div class="op-main"><code>Codex / ${esc(target.name)} MCP 配置</code><div class="op-sub">迁移前后指纹必须一致</div></div></div>`;
}

function goMigrationStep(step) {
  if (!state.migrationThread || step < 1 || step > MIGRATION_STEPS.length) return;
  if (step === 7 && state.migrationTarget === "pi" && (!state.piPreview || !$("#migConfirm").checked)) return;
  if (step === 7 && state.migrationTarget === "claude-code" && (!state.claudePreview || !$("#migConfirm").checked)) return;
  if (step === 7 && (state.migrationTarget === "codebuddy-international" || state.migrationTarget === "codebuddy-cn") && (!state.codeBuddyPreview || !$("#migConfirm").checked)) return;
  state.migrationStep = step;
  state.migrationVisited.add(step);
  const overlay = $("#ovMigration");
  buildStepBar(overlay, MIGRATION_STEPS, step, state.migrationVisited);
  $$(".wstep", overlay).forEach((button) => {
    button.disabled = !state.migrationVisited.has(Number(button.dataset.step)) || state.migrating;
    button.addEventListener("click", () => goMigrationStep(Number(button.dataset.step)));
  });
  $$(".wiz-pane", overlay).forEach((pane) => pane.classList.toggle("active", Number(pane.dataset.pane) === step));
  const previous = $("[data-wiz-prev]", overlay);
  const next = $("[data-wiz-next]", overlay);
  previous.style.display = step === 7 ? "none" : "";
  next.style.display = step === 7 ? "none" : "";
  previous.disabled = step === 1;
  next.textContent = step === 6 ? "执行真实迁移" : "下一步";
  next.disabled = step === 6 && !$("#migConfirm").checked;
  if (state.migrationTarget === "zcode" && step >= 4 && step <= 6) {
    next.disabled = true;
    void loadZcodePreview();
  }
  if (state.migrationTarget === "pi" && step >= 4 && step <= 6) {
    next.disabled = true;
    void loadPiPreview();
  }
  if (state.migrationTarget === "claude-code" && step >= 4 && step <= 6) {
    next.disabled = true;
    void loadClaudePreview();
  }
  if ((state.migrationTarget === "codebuddy-international" || state.migrationTarget === "codebuddy-cn") && step >= 4 && step <= 6) {
    next.disabled = true;
    void loadCodeBuddyPreview();
  }
  if (step === 3) renderSourceChecks();
  if (step === 7 && !state.migrationStarted) void executeMigration();
}

async function loadCodeBuddyPreview() {
  const thread = state.migrationThread;
  const targetProduct = state.migrationTarget;
  const generation = state.codeBuddyPreviewGeneration;
  const pane = $('#ovMigration [data-pane="4"]');
  if (!state.codeBuddyPreview) {
    pane.innerHTML = `<h3 class="pane-title">正在离线生成 ${esc(migrationTarget().name)} 官方归档预览…</h3><p>不会写入目标 History，也不会调用模型。</p>`;
    try {
      const response = await window.ideHub.previewCodeBuddy(thread.id, targetProduct);
      if (generation !== state.codeBuddyPreviewGeneration || state.migrationTarget !== targetProduct) return;
      if (!response.ok) throw response.error;
      state.codeBuddyPreview = response.data;
    } catch (error) {
      if (generation === state.codeBuddyPreviewGeneration && state.migrationTarget === targetProduct) {
        pane.innerHTML = `<div class="banner banner-error">预览失败：${esc(normalizeError(error).message)}。返回上一步重试。</div>`;
      }
      return;
    }
  }
  if (state.migrationTarget !== targetProduct) return;
  const { projection, result, plan } = state.codeBuddyPreview;
  const messages = projection.turns.flatMap((turn) => turn.messages);
  pane.innerHTML = `<h3 class="pane-title">${esc(migrationTarget().name)} 官方 archive v1 · ${messages.length} 条</h3>
    <p class="mono">${esc(result.workspace)} → MD5 ${esc(plan.workspaceHash)}</p>
    <div class="banner banner-info">每条 User / Assistant 独立保留；连续同角色不合并，user-only 结尾不补假回答。</div>
    ${messages.map((message, index) => `<details class="card"><summary>${index + 1}. ${esc(message.role)} · ${esc(message.content.slice(0, 90))}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(message.content)}</pre></details>`).join("")}`;
  const loss = projection.lossReport;
  $('#ovMigration [data-pane="5"] tbody').innerHTML = `
    <tr><td>User / Assistant 正文</td><td><span class="loss-chip l-full">完整归档</span></td><td>${loss.includedMessageCount} 条，${loss.includedMessageBytes} bytes；角色、顺序和换行逐条回读</td></tr>
    ${Object.entries(loss.omittedEventTypes).map(([type, count]) => `<tr><td>${esc(type)}</td><td><span class="loss-chip l-arch">仅 Hub 审计</span></td><td>${count} 项，不伪造成目标 tool/system 消息</td></tr>`).join("")}
    <tr><td>模型 / 用量 / 账号</td><td><span class="loss-chip l-skip">不写入</span></td><td>迁移 archive 不含 model、usage、Key 或登录态</td></tr>
    <tr><td>MCP</td><td><span class="loss-chip l-skip">不迁移</span></td><td>只比对配置指纹；仍属于独立全局配置流程</td></tr>`;
  $('#ovMigration [data-pane="6"] .pane-sub').textContent = "生成不超过 20 MiB 的官方 JSON，打开所选 CodeBuddy 版本的同一工作区；官方 Import 完成且原生逐消息回读前不会显示迁移成功。";
  $('#ovMigration [data-pane="6"] .ops').innerHTML = `
    <div class="op-row"><span class="op-badge b-create">生成</span><div class="op-main"><code>${esc(plan.archivePath)}</code><div class="op-sub">${plan.archiveBytes} bytes / ${plan.archiveMaxBytes} bytes · Archive ID ${esc(plan.archiveId)}</div></div></div>
    <div class="op-row"><span class="op-badge b-open">打开</span><div class="op-main"><code>${esc(migrationTarget().name)} · ${esc(result.workspace)}</code><div class="op-sub">只传目录参数，不运行 buddy chat / buddycn chat；随后在 History 中选择 Import</div></div></div>
    <div class="op-row"><span class="op-badge b-conf">不修改</span><div class="op-main">Codex 源、目标私有 History（由官方 Import 写入）、MCP、模型和认证</div></div>`;
  $('#ovMigration [data-wiz-next]').disabled = state.migrationStep === 6 && !$("#migConfirm").checked;
}

async function loadPiPreview() {
  const thread = state.migrationThread;
  const generation = state.piPreviewGeneration;
  const pane = $('#ovMigration [data-pane="4"]');
  if (!state.piPreview) {
    pane.innerHTML = '<h3 class="pane-title">正在离线读取 Pi 完整历史投影…</h3><p>预览不会创建 Pi 目录或会话。</p>';
    try {
      const response = await window.ideHub.previewPi(thread.id);
      if (generation !== state.piPreviewGeneration || state.migrationTarget !== "pi") return;
      if (!response.ok) throw response.error;
      state.piPreview = response.data;
    } catch (error) {
      if (generation === state.piPreviewGeneration && state.migrationTarget === "pi") pane.innerHTML = `<div class="banner banner-error">预览失败：${esc(normalizeError(error).message)}。返回上一步重试。</div>`;
      return;
    }
  }
  const { projection, result, plan } = state.piPreview;
  pane.innerHTML = `<h3 class="pane-title">Pi 完整原生历史 · ${projection.messages.length} 条</h3>
    <p class="mono">${esc(result.workspace)} → 同一目录</p><div class="banner banner-info">${esc(projection.compatibilityNote)}</div>
    ${projection.messages.map((m, i) => `<details class="card"><summary>${i + 1}. ${esc(m.role)} · ${esc(m.content.slice(0, 90))}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.content)}</pre></details>`).join("")}`;
  const loss = projection.lossReport;
  $('#ovMigration [data-pane="5"] tbody').innerHTML = `
    <tr><td>User / Assistant 正文</td><td>完整迁移</td><td>${loss.includedMessageCount} 条，${loss.includedMessageBytes} bytes；不截断、不合并</td></tr>
    <tr><td>无可迁移文本的消息</td><td>仅归档</td><td>${loss.omittedMessageCount} 条；附件/事件损失见下方</td></tr>
    ${Object.entries(loss.omittedEventTypes).map(([type, count]) => `<tr><td>${esc(type)}</td><td>不迁移执行状态/附件</td><td>${count} 项，源记录保留在本地 Capsule</td></tr>`).join("")}
    <tr><td>system / 隐藏推理</td><td>不复制</td><td>由 Pi 自己构建当前运行上下文</td></tr>
    <tr><td>MCP / 模型 / 账号</td><td>不迁移、不修改</td><td>历史导入无需 Key；续聊使用 Pi 配置</td></tr>`;
  $('#ovMigration [data-pane="6"] .pane-sub').textContent = "禁网 SDK 构造原生记录，独占发布完整 JSONL；原生列表和上下文回读后才报告导入成功。重复迁移保留已有续聊。";
  $('#ovMigration [data-pane="6"] .ops').innerHTML = `<div class="op-row"><span class="op-badge b-create">创建</span><div class="op-main"><code>${esc(plan.sessionPath)}</code><div class="op-sub">Pi ${esc(plan.version)} · header cwd = ${esc(result.workspace)}；失败记录可恢复，不覆盖其他会话</div></div></div>
    <div class="op-row"><span class="op-badge b-conf">不修改</span><div class="op-main">Codex 源会话、MCP、模型和账号配置</div></div>
    <div class="banner banner-info">导入后在终端中打开 Pi 会话。实际发送消息使用 Pi 已配置模型；迁移完成不表示已验证真实续聊。</div>`;
  $('#ovMigration [data-wiz-next]').disabled = state.migrationStep === 6 && !$("#migConfirm").checked;
}

async function loadClaudePreview() {
  const thread = state.migrationThread;
  const generation = state.claudePreviewGeneration;
  const pane = $('#ovMigration [data-pane="4"]');
  if (!state.claudePreview) {
    pane.innerHTML = '<h3 class="pane-title">正在离线读取 Claude Code 完整历史投影…</h3><p>预览不会创建目标目录或会话。</p>';
    try {
      const response = await window.ideHub.previewClaude(thread.id);
      if (generation !== state.claudePreviewGeneration || state.migrationTarget !== "claude-code") return;
      if (!response.ok) throw response.error;
      state.claudePreview = response.data;
    } catch (error) {
      if (generation === state.claudePreviewGeneration && state.migrationTarget === "claude-code") pane.innerHTML = `<div class="banner banner-error">预览失败：${esc(normalizeError(error).message)}。返回上一步重试。</div>`;
      return;
    }
  }
  const { projection, result, plan } = state.claudePreview;
  pane.innerHTML = `<h3 class="pane-title">Claude Code 完整原生历史 · ${projection.messages.length} 条</h3>
    <p class="mono">${esc(result.workspace)} → 同一目录</p><div class="banner banner-info">${esc(projection.compatibilityNote)}</div>
    ${projection.messages.map((m, i) => `<details class="card"><summary>${i + 1}. ${esc(m.role)} · ${esc(m.content.slice(0, 90))}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.content)}</pre></details>`).join("")}`;
  $('#ovMigration [data-pane="5"] tbody').innerHTML = `<tr><td>User / Assistant 正文</td><td>完整原生历史</td><td>${projection.messages.length} 条；不合并、不截断，不添加假回答</td></tr>
    ${Object.entries(projection.lossReport.omittedEventTypes).map(([kind, count]) => `<tr><td>${esc(kind)}</td><td>不重放工具/附件</td><td>${count} 项，源记录保留在本地 Capsule</td></tr>`).join("")}
    <tr><td>system / 隐藏推理</td><td>不复制</td><td>由 Claude Code 构建当前运行上下文</td></tr>
    <tr><td>MCP / 模型 / 账号</td><td>不迁移、不修改</td><td>导入无需 Key；续聊使用 Claude Code 现有配置</td></tr>`;
  $('#ovMigration [data-pane="6"] .pane-sub').textContent = "完整 JSONL 独占发布；逐行/父子链与官方磁盘回读通过后才报告导入成功。重复迁移保留新增聊天，失败可按记录重试恢复。";
  $('#ovMigration [data-pane="6"] .ops').innerHTML = `<div class="op-row"><span class="op-badge b-create">新建/复用</span><div class="op-main"><code>${esc(plan.sessionPath)}</code><div class="op-sub">Claude Code ${esc(plan.version)} · cwd = ${esc(result.workspace)}；只涉及本次独立 Session ID</div></div></div>
    <div class="op-row"><span class="op-badge b-conf">不修改</span><div class="op-main">Codex 源会话、既有 Claude 会话、MCP、模型和认证配置</div></div>
    <div class="banner banner-info">在终端中打开 Claude Code 会话。迁移过程不发送模型消息，真实续聊未由本次迁移验证；无模型也可导入。</div>`;
  $('#ovMigration [data-wiz-next]').disabled = state.migrationStep === 6 && !$("#migConfirm").checked;
}

async function loadZcodePreview() {
  const thread = state.migrationThread;
  const pane = $('#ovMigration [data-pane="4"]');
  if (!state.zcodePreview) {
    if (state.zcodePreviewLoading) return;
    state.zcodePreviewLoading = true;
    pane.innerHTML = '<h3 class="pane-title">正在离线读取完整历史与损失报告…</h3><p>此操作不创建目标会话。</p>';
    try {
      const response = await window.ideHub.previewZcode(thread.id);
      if (!response.ok) throw response.error;
      if (state.migrationThread?.id !== thread.id || state.migrationTarget !== "zcode") return;
      state.zcodePreview = response.data;
    } catch (error) {
      if (state.migrationTarget === "zcode") pane.innerHTML = `<div class="banner banner-error">预览失败：${esc(normalizeError(error).message)}。返回上一步可重试。</div>`;
      return;
    } finally { state.zcodePreviewLoading = false; }
  }
  if (state.migrationTarget !== "zcode") return;
  const { projection, result } = state.zcodePreview;
  pane.innerHTML = `<h3 class="pane-title">完整原生历史预览 · ${projection.projectedMessageCount} 条</h3>
    <p class="mono">${esc(result.workspace)} → 同一目录</p><div class="banner banner-info">${esc(projection.compatibilityNote)}</div>
    ${projection.history.messages.map((m, i) => `<details class="card"><summary>${i + 1}. ${esc(m.role)} · ${esc(m.content.slice(0, 90))}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(m.content)}</pre></details>`).join("")}`;
  const loss = projection.lossReport;
  $('#ovMigration [data-pane="5"] tbody').innerHTML = `
    <tr><td>User / Assistant 正文</td><td>完整迁移</td><td>${loss.includedMessageCount} 条，${loss.includedMessageBytes} bytes；不截断、不合并</td></tr>
    ${Object.entries(loss.omittedEventTypes).map(([type, count]) => `<tr><td>${esc(type)}</td><td>不迁移执行状态/附件</td><td>${count} 项，事件记录仅保留在本地 Capsule</td></tr>`).join("")}
    <tr><td>隐藏推理 / system prompt</td><td>不复制</td><td>由 ZCode 自己恢复原生运行上下文</td></tr>
    <tr><td>MCP / 账号凭据</td><td>不迁移、不修改</td><td>续聊使用 ZCode 自己的配置；离线迁移不使用 Key</td></tr>`;
  const next = $('#ovMigration [data-wiz-next]');
  next.disabled = state.migrationStep === 6 && !$("#migConfirm").checked;
}

function renderSourceChecks() {
  const thread = state.migrationThread;
  const checks = [
    ["会话运行状态", thread.status?.type === "active" ? "✕ 正在运行" : `✓ ${thread.status?.type || "非 active"}`],
    ["本地持久化源文件", thread.path ? "✓ 路径已发现" : "✕ 无源路径"],
    ["目标工作区约束", thread.cwd ? "✓ 与源 cwd 完全相同" : "✕ 无工作区"],
    ["源端与 MCP 保护", "✓ 执行阶段做前后指纹复核"],
  ];
  const container = $("#migIdleChecks");
  container.innerHTML = checks.map(([label, result]) => `
    <div class="check-item done"><span class="ci-dot"></span><span class="ci-label">${label}</span><span class="ci-state">${result}</span></div>`).join("");
  const banner = $("#migIdleBanner");
  banner.className = "banner banner-ok";
  banner.textContent = `扫描前置条件满足；真正的文件 hash、完整读取和 ${migrationTarget().name} 协议检查在执行时完成。`;
}

function renderMigrationTimeline(mode = "running") {
  const target = migrationTarget();
  const isCodeBuddy = state.migrationTarget === "codebuddy-international" || state.migrationTarget === "codebuddy-cn";
  const labels = isCodeBuddy ? [
    "只读读取 Codex 源会话并复核源文件",
    "生成并严格校验 codebuddy.conversation v1 单会话 JSON",
    `无 prompt 打开 ${target.name} 的同一工作区 A，并显示归档文件`,
    "等待用户在目标 History 中执行官方 Import",
    "按目标版本日志、originalId、A 分区和逐消息文件完成原生回读",
  ] : [
    "只读读取 Codex 源会话并复核源文件",
    "生成 source snapshot、Capsule 与会话投影",
    `在相同工作区创建 ${target.name} 原生会话`,
    state.migrationTarget === "claude-code" ? "严格校验全部记录，并通过官方磁盘列表/消息回读" : "逐轮回读正文并验证 Chat History 可见",
    "复核 Codex 源文件与 MCP 指纹",
  ];
  $("#migTimeline").innerHTML = labels.map((label, index) => {
    const waitingDone = mode === "waiting" && index < 3;
    const className = mode === "done" || waitingDone ? "done" : mode === "waiting" && index === 3 ? "running" : mode === "error" && index === 0 ? "failed" : index === 0 ? "running" : "";
    return `<div class="st-item ${className}"><span class="st-dot"></span><span>${label}</span><span class="st-time">${mode === "done" || waitingDone ? "✓" : mode === "waiting" && index === 3 ? "等待" : ""}</span></div>`;
  }).join("");
}

async function executeMigration() {
  const thread = state.migrationThread;
  if (!thread || state.migrating) return;
  const targetProduct = state.migrationTarget;
  const target = migrationTarget(targetProduct);
  state.migrationStarted = true;
  state.migrating = true;
  state.lastError = null;
  renderMigrationTimeline("running");
  renderDetail();
  try {
    const response = await window.ideHub.migrate(thread.id, targetProduct);
    if (!response.ok) throw response.error;
    state.lastResult = response.data;
    if (response.data.status === "WAITING_TARGET_IMPORT") {
      renderMigrationTimeline("waiting");
      renderMigrationResult(response.data);
      toast(`${target.name} 归档已生成；请在目标 History 中完成官方 Import`, "ok");
    } else {
      renderMigrationTimeline("done");
      renderMigrationResult(response.data);
      toast(`${target.name} 原生会话迁移完成并通过回读校验`, "ok");
    }
  } catch (rawError) {
    const error = normalizeError(rawError);
    state.lastError = error;
    renderMigrationTimeline("error");
    renderMigrationError(error);
    toast(error.message, "warn");
  } finally {
    state.migrating = false;
    renderDetail();
  }
}

function renderMigrationResult(result) {
  if (result.status === "WAITING_TARGET_IMPORT") {
    renderCodeBuddyWaitingResult(result);
    return;
  }
  const container = $("#migResult");
  const loss = result.details.lossReport;
  const target = migrationTarget(result.continuation.product);
  const isCodeBuddy = result.continuation.product === "codebuddy-international" || result.continuation.product === "codebuddy-cn";
  const codeBuddy = result.details.codeBuddy;
  const continuationHelp = result.continuation.product === "claude-code"
    ? "Claude Code 原生历史已导入，完整载荷与官方磁盘列表/消息回读通过。按钮会从同一工作区在终端按确切 Session ID 恢复；也可用 /resume 查找 Codex 标题。这不是 Claude Desktop 或 IDE 扩展入口。历史模型标识仅表示 Codex 来源；续聊使用 Claude Code 自己的模型和认证。本次迁移不发送测试消息，真实续聊尚未验证。"
    : result.continuation.product === "pi"
    ? "Pi 原生历史已落盘、重开和列表回读。在终端中打开 Pi 会话后，可用 /resume 查找 Codex 标题。历史 provider ide-hub/codex-history 是导入标识，Pi 会使用自己的模型；无需为此标识配置 provider。真实续聊未由本次迁移验证；如无模型，请在 Pi /login 或 /model 配置。"
    : result.continuation.product === "cursor"
    ? `已按目标 Session ID 请求 Cursor 打开该原生会话；也可从 Chat History 中按“Codex · …”标题找到它。`
    : result.continuation.product === "zcode"
      ? `ZCode 原生历史已重开回读，桌面任务已登记。点击下方按钮打开项目，在任务列表找到“Codex · …”。当前入口只打开项目，不声称自动定位指定会话；Session ID：${result.targetSessionId}。迁移阶段不发送模型消息。`
    : isCodeBuddy
      ? `${target.name} 已通过官方 Import 落入工作区 A，并按确切 originalId、请求/消息关系和逐条正文完成原生回读。${codeBuddy?.continuationCompletedRoundCount > 0 ? `另检测到 ${codeBuddy.continuationCompletedRoundCount} 轮目标端新增问答已完整持久化；回答语义仍由独立真实续聊验收记录确认。` : "迁移阶段没有发送模型消息，真实续聊仍未验证。"}请在 Chat History 中按迁移标题或 Session ID ${result.targetSessionId} 找到会话。`
    : result.continuation.product === "deepseek-harness"
      ? `已打开 DSH Web。会话已挂载到同一工作区，请在会话列表按迁移标题或 Session ID ${result.targetSessionId} 找到并继续。`
      : `已请求 ${target.name} 打开同一工作区。请在聊天区右上角打开 Chat History，选择最新的“Codex · …”会话继续。`;
  container.hidden = false;
  container.innerHTML = `
    <div class="result-card">
      <div class="result-icon ok">✓</div>
      <div>
        <h4>迁移完成并通过 ${esc(target.name)} 原生历史回读校验</h4>
        <p class="muted">Migration <code>${esc(result.migrationId)}</code> · Session <code>${esc(result.targetSessionId)}</code></p>
      </div>
    </div>
    <div class="kv-grid cols3 result-kv">
      <div class="kv-item"><div class="kv-k">目标工作区</div><div class="kv-v mono">${esc(result.workspace)}</div></div>
      <div class="kv-item"><div class="kv-k">原生轮次 / 消息</div><div class="kv-v">${result.details.projectedTurnCount} / ${result.details.projectedMessageCount}</div></div>
      <div class="kv-item"><div class="kv-k">摘要省略消息</div><div class="kv-v">${loss.omittedMessageCount}</div></div>
      <div class="kv-item"><div class="kv-k">模型调用</div><div class="kv-v ok">否</div></div>
      <div class="kv-item"><div class="kv-k">MCP 修改</div><div class="kv-v ok">否</div></div>
      <div class="kv-item"><div class="kv-k">源快照 sha256</div><div class="kv-v mono">${esc(result.details.sourceSnapshotSha256.slice(0, 16))}…</div></div>
      ${isCodeBuddy ? `<div class="kv-item"><div class="kv-k">目标新增持久化</div><div class="kv-v ${codeBuddy?.continuationCompletedRoundCount > 0 ? "ok" : "warn"}">${codeBuddy?.continuationCompletedRoundCount > 0 ? `${codeBuddy.continuationCompletedRoundCount} 轮 · 语义另验` : "尚无续聊"}</div></div>` : ""}
    </div>
    <div class="banner banner-info result-help">${esc(continuationHelp)}</div>
    <div class="result-actions">
      <button class="btn btn-primary" id="migOpenTarget">${result.continuation.product === "claude-code" ? "在终端中打开 Claude Code 会话" : result.continuation.product === "pi" ? "在终端中打开 Pi 会话" : `打开 ${esc(target.name)} 工作区`}</button>
      <button class="btn btn-ghost" data-real-close>关闭向导</button>
      ${result.continuation.product === "claude-code" ? '<button class="btn btn-danger-ghost" id="migRollbackClaude">回滚本次导入…</button>' : isCodeBuddy ? '<button class="btn btn-danger-ghost" id="migRollbackCodeBuddy">恢复 / 删除本次导入…</button>' : '<button class="btn btn-danger-ghost" disabled>回滚（未实现）</button>'}
    </div>`;
  $("#migOpenTarget").addEventListener("click", () => void openTarget(result.workspace, result.continuation.product, result.targetSessionId));
  $("[data-real-close]", container).addEventListener("click", closeMigration);
  $("#migRollbackClaude")?.addEventListener("click", async () => {
    if (!window.confirm("仅删除本次 Claude Code 导入的会话。已有新增聊天或改动会拒绝回滚，源会话及归档不删除。确定？")) return;
    try {
      const response = await window.ideHub.rollbackClaude(result.workspace, result.targetSessionId);
      if (!response.ok) throw response.error;
      state.lastResult = null;
      closeMigration();
      renderDetail();
      toast("已删除本次未续聊目标；源会话、其他会话及 Hub 归档保留，可重新迁移", "ok");
    } catch (error) { toast(normalizeError(error).message, "warn"); }
  });
  $("#migRollbackCodeBuddy")?.addEventListener("click", () => void prepareCodeBuddyRollback(result));
}

async function prepareCodeBuddyRollback(result) {
  const target = migrationTarget(result.continuation.product);
  if (!window.confirm(`恢复只针对本次 ${target.name} 导入。IDE Hub 不会直接写或删除私有 History；下一步会打开工作区，由你在官方 History 中删除确切 Session。继续？`)) return;
  let response = await window.ideHub.prepareCodeBuddyRollback(
    result.workspace,
    result.continuation.product,
    result.details.codeBuddy.archiveId,
    result.targetSessionId,
    false,
  );
  if (!response.ok && response.error.code === "CODEBUDDY_ROLLBACK_HAS_CONTINUATION") {
    const counts = response.error.details ?? {};
    const confirmed = window.confirm(`该会话已有目标端新增聊天（${counts.continuationRequestCount ?? "?"} 个 request / ${counts.continuationMessageCount ?? "?"} 条消息）。默认不会删除。是否明确同意把这些新增聊天和本次导入一并从官方 History 删除？`);
    if (!confirmed) {
      toast("已保留含续聊的 CodeBuddy 会话", "warn");
      return;
    }
    response = await window.ideHub.prepareCodeBuddyRollback(
      result.workspace,
      result.continuation.product,
      result.details.codeBuddy.archiveId,
      result.targetSessionId,
      true,
    );
  }
  if (!response.ok) {
    toast(response.error.message, "warn");
    return;
  }
  renderCodeBuddyRollbackWaiting(result, response.data);
}

function renderCodeBuddyRollbackWaiting(result, inspection) {
  const container = $("#migResult");
  const target = migrationTarget(result.continuation.product);
  container.innerHTML = `
    <div class="result-card">
      <div class="result-icon">…</div>
      <div><h4>等待在 ${esc(target.name)} 官方 History 中删除</h4><p class="muted">只删除 Session <code>${esc(result.targetSessionId)}</code>；IDE Hub 不直接修改目标私有文件。</p></div>
    </div>
    <div class="banner ${inspection.continuationWillBeDeleted ? "banner-warn" : "banner-info"}">${inspection.continuationWillBeDeleted ? `你已明确同意一并删除 ${inspection.continuationRequestCount} 个续聊 request / ${inspection.continuationMessageCount} 条续聊消息。` : "该会话没有目标端新增聊天。"}在 Chat History 中核对标题和 Session ID 后使用官方删除；完成后回到这里检查。</div>
    <div class="result-actions">
      <button class="btn btn-primary" id="migConfirmCodeBuddyRollback">检查官方删除结果</button>
      <button class="btn btn-ghost" id="migCancelCodeBuddyRollback">取消并保留会话</button>
    </div>`;
  $("#migConfirmCodeBuddyRollback").addEventListener("click", async () => {
    const response = await window.ideHub.confirmCodeBuddyRollback(
      result.workspace,
      result.continuation.product,
      result.details.codeBuddy.archiveId,
      result.targetSessionId,
    );
    if (!response.ok) {
      toast(response.error.message, "warn");
      return;
    }
    state.lastResult = null;
    closeMigration();
    renderDetail();
    toast("官方目标会话已确认消失；仅本次 Hub 幂等映射已撤销，源会话和归档保留", "ok");
  });
  $("#migCancelCodeBuddyRollback").addEventListener("click", () => renderMigrationResult(result));
}

function renderCodeBuddyWaitingResult(result) {
  const container = $("#migResult");
  const target = migrationTarget(result.continuation.product);
  const archive = result.details.codeBuddy;
  container.hidden = false;
  container.innerHTML = `
    <div class="result-card">
      <div class="result-icon">…</div>
      <div>
        <h4>归档已就绪，等待 ${esc(target.name)} 官方 Import</h4>
        <p class="muted">此时尚未完成迁移，也没有向模型发送消息。</p>
      </div>
    </div>
    <div class="kv-grid cols3 result-kv">
      <div class="kv-item"><div class="kv-k">目标工作区 A</div><div class="kv-v mono">${esc(result.workspace)}</div></div>
      <div class="kv-item"><div class="kv-k">Archive ID</div><div class="kv-v mono">${esc(archive.archiveId)}</div></div>
      <div class="kv-item"><div class="kv-k">归档大小</div><div class="kv-v">${archive.archiveBytes} bytes</div></div>
    </div>
    <div class="banner banner-info result-help"><b>现在到 ${esc(target.name)}：</b>打开 Chat 区的 History → Import，选择 Finder 已定位的 JSON 文件。看到目标提示 Import 成功后，回到这里点击“检查导入并完成”。IDE Hub 将核对所选版本、A 的工作区 MD5、originalId、request/message 关系及每条正文。</div>
    <div class="mono path-block">${esc(archive.archivePath)}</div>
    <div class="result-actions">
      <button class="btn btn-primary" id="migVerifyCodeBuddy">检查导入并完成</button>
      <button class="btn btn-ghost" id="migRevealCodeBuddy">在 Finder 中显示归档</button>
      <button class="btn btn-ghost" id="migReopenCodeBuddy">重新打开 ${esc(target.name)} 的 A</button>
      <button class="btn btn-danger-ghost" id="migCancelCodeBuddy">取消本次等待</button>
      <button class="btn btn-ghost" data-real-close>稍后处理</button>
    </div>`;
  $("#migVerifyCodeBuddy").addEventListener("click", () => void verifyCodeBuddyImport(result));
  $("#migRevealCodeBuddy").addEventListener("click", async () => {
    const response = await window.ideHub.revealCodeBuddyArchive(result.migrationId);
    toast(response.ok ? "已在 Finder 中定位归档" : response.error.message, response.ok ? "ok" : "warn");
  });
  $("#migReopenCodeBuddy").addEventListener("click", () => void openTarget(result.workspace, result.continuation.product, null));
  $("#migCancelCodeBuddy").addEventListener("click", async () => {
    if (!window.confirm("取消后只结束本次等待状态；官方归档和审计产物保留，源会话及目标 History 不会被修改。确定？")) return;
    const response = await window.ideHub.cancelCodeBuddyMigration(result.migrationId);
    if (!response.ok) {
      toast(response.error.message, "warn");
      return;
    }
    state.lastResult = response.data;
    closeMigration();
    renderDetail();
    toast("本次 CodeBuddy Import 等待已取消；归档与审计记录已保留", "ok");
  });
  $("[data-real-close]", container).addEventListener("click", closeMigration);
}

async function verifyCodeBuddyImport(previousResult) {
  if (state.migrating || !state.migrationThread) return;
  state.migrating = true;
  renderMigrationTimeline("waiting");
  renderDetail();
  try {
    const response = await window.ideHub.migrate(state.migrationThread.id, previousResult.continuation.product);
    if (!response.ok) throw response.error;
    state.lastResult = response.data;
    if (response.data.status === "WAITING_TARGET_IMPORT") {
      renderCodeBuddyWaitingResult(response.data);
      toast("尚未在所选 CodeBuddy 版本和工作区 A 中发现这份官方导入，请确认目标已提示成功", "warn");
      return;
    }
    renderMigrationTimeline("done");
    renderMigrationResult(response.data);
    toast(`${migrationTarget(response.data.continuation.product).name} 原生历史已完整回读，迁移完成`, "ok");
  } catch (rawError) {
    const error = normalizeError(rawError);
    state.lastError = error;
    renderMigrationTimeline("error");
    renderMigrationError(error);
    toast(error.message, "warn");
  } finally {
    state.migrating = false;
    renderDetail();
  }
}

function renderMigrationError(error) {
  const container = $("#migResult");
  container.hidden = false;
  container.innerHTML = `
    <div class="result-card result-error">
      <div class="result-icon err">!</div>
      <div><h4>迁移失败</h4><p class="muted"><code>${esc(error.code)}</code> · ${esc(error.message)}</p></div>
    </div>
    <div class="result-actions"><button class="btn btn-ghost" data-real-close>关闭向导</button></div>`;
  $("[data-real-close]", container).addEventListener("click", closeMigration);
}

function closeMigration() {
  if (state.migrating) {
    toast("真实迁移仍在执行，请等待完成", "warn");
    return;
  }
  $("#ovMigration").classList.remove("open");
}

function prepareStubWizard(id) {
  const overlay = $(`#${id}`);
  const definition = STUB_WIZARDS[id];
  overlay.classList.add("prototype-placeholder");
  if (!$(".stub-banner", overlay)) {
    const banner = document.createElement("div");
    banner.className = "banner banner-warn stub-banner";
    banner.innerHTML = `<b>${definition.label}尚未实现</b> · 下方保留 prototype 的完整页面结构与操作位置，但当前不会读取或写入任何数据。`;
    $(".wiz-steps", overlay).after(banner);
  }
  buildStepBar(overlay, definition.steps);
  $$(".wstep", overlay).forEach((button) => { button.disabled = true; });
  $$(".wiz-pane", overlay).forEach((pane, index) => pane.classList.toggle("active", index === 0));
  $("[data-wiz-prev]", overlay).disabled = true;
  const next = $("[data-wiz-next]", overlay);
  next.disabled = true;
  next.textContent = "未实现";
}

function openStubWizard(id) {
  prepareStubWizard(id);
  $(`#${id}`).classList.add("open");
}

function closeStubWizard(overlay) {
  overlay.classList.remove("open");
  toast(`${STUB_WIZARDS[overlay.id].label}尚未实现，未产生任何写入`, "warn");
}

function renderUnimplementedViews() {
  $("#mcpCount").textContent = "未实现";
  $("#mcpServerList").innerHTML = '<div class="banner banner-warn"><b>MCP 扫描尚未实现</b><br>此模块是全局产品配置，独立于任何会话迁移。</div>';
  $("#mcpDetail").innerHTML = `
    <div class="mcpd-head"><h2>全局 MCP 配置</h2><span class="badge b-warn">未实现</span></div>
    <div class="mcpd-sub">保留 prototype 的独立全局配置页面；后续接入各产品 adapter。</div>
    <div class="banner banner-info mcp-global-banner">MCP 迁移的任务粒度是“源产品 → 目标产品”，只需按配置迁移一次，不随每个会话重复携带。</div>
    <div class="card"><div class="card-title">计划保留的操作入口</div><ul class="plain-list"><li>扫描各产品全局 MCP 配置</li><li>查看字段映射和冲突 diff</li><li>独立备份、应用、校验与回滚</li><li>导入 / 导出独立配置包</li></ul></div>`;
  $("#mcpSearchInput").disabled = true;
  $$("#view-mcp .btn").forEach((button) => {
    button.classList.remove("btn-primary");
    button.classList.add("btn-ghost");
    if (!button.textContent.includes("未实现")) button.textContent = `${button.textContent.trim()} · 未实现`;
  });

  $("#jobsTable").innerHTML = `
    <div class="job-row">
      <div class="job-main static-job">
        <span class="badge b-warn">未实现</span>
        <div class="job-body"><b>任务持久化与任务列表尚未接入</b><div class="jb-sub">当前真实迁移结果只在本次应用会话和本地 migration artifacts 中可见。</div></div>
      </div>
    </div>`;

  const settingsCards = $$("#view-settings .card");
  const dataValues = $$("#view-settings .card:nth-of-type(2) .kv-v");
  if (dataValues[1]) dataValues[1].textContent = "容量统计未实现";
  $$("#view-settings .row-btns .btn").forEach((button) => {
    button.textContent = `${button.textContent.trim()} · 未实现`;
  });
  $$("#view-settings input:not([checked])").forEach((input) => { input.disabled = true; });
  const about = settingsCards.at(-1)?.querySelector(".card-p");
  if (about) about.textContent = "IDE Hub 0.1.0 · Electron 本地桌面壳 + TypeScript 迁移核心。当前已实现 Codex → Qoder 国际版 / Qoder CN / Cursor 原生会话迁移。";
}

function normalizeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}

async function prepareDshBridge() {
  if (state.migrating || state.scanning) return;
  try {
    if (!window.ideHub) throw new Error("Electron IPC 未加载；请从 IDE Hub 桌面应用打开");
    const response = await window.ideHub.prepareDsh();
    if (!response.ok) throw response.error;
    state.dsh = response.data;
    renderProducts();
    renderDetail();
    toast(
      response.data.profileRestartRequired
        ? "DSH 本地迁移桥已启用；若 DSH Web 正在运行，请关闭后重新迁移"
        : "DSH 本地迁移桥已就绪",
      "ok",
    );
  } catch (rawError) {
    const error = normalizeError(rawError);
    toast(`启用 DSH 迁移桥失败：${error.message}`, "warn");
  }
}

async function scan() {
  if (state.scanning || state.migrating) return;
  state.scanning = true;
  const button = $("#btnRescan");
  button.disabled = true;
  button.classList.add("scanning");
  button.textContent = "扫描中";
  renderProducts();
  renderSessions();
  try {
    if (!window.ideHub) throw new Error("Electron IPC 未加载；请从 IDE Hub 桌面应用打开");
    const response = await window.ideHub.scan();
    if (!response.ok) throw response.error;
    state.threads = response.data.threads;
    state.qoder = response.data.qoder;
    state.qoderCn = response.data.qoderCn;
    state.cursor = response.data.cursor;
    state.dsh = response.data.dsh;
    state.zcode = response.data.zcode;
    state.pi = response.data.pi;
    state.claude = response.data.claude;
    state.codeBuddyInternational = response.data.codeBuddyInternational;
    state.codeBuddyCn = response.data.codeBuddyCn;
    const stillExists = state.threads.some((thread) => thread.id === state.current);
    if (!stillExists) state.current = state.threads[0]?.id ?? null;
    state.selected = new Set([...state.selected].filter((id) => state.threads.some((thread) => thread.id === id)));
    toast(`扫描完成：${state.threads.length} 个真实 Codex 会话`, "ok");
  } catch (rawError) {
    const error = normalizeError(rawError);
    state.threads = [];
    state.qoder = null;
    state.qoderCn = null;
    state.cursor = null;
    state.dsh = null;
    state.zcode = null;
    state.pi = null;
    state.claude = null;
    state.codeBuddyInternational = null;
    state.codeBuddyCn = null;
    state.current = null;
    toast(`扫描失败：${error.message}`, "warn");
  } finally {
    state.scanning = false;
    button.disabled = false;
    button.classList.remove("scanning");
    button.textContent = "重新扫描";
    renderProducts();
    renderSessions();
    renderDetail();
    updateSelectionBar();
  }
}

async function openTarget(workspace, targetProduct, targetSessionId = null) {
  const target = migrationTarget(targetProduct);
  const response = await window.ideHub.openTarget(workspace, targetProduct, targetSessionId);
  if (response.ok) toast(`已请求 ${target.name} 打开工作区和迁移会话`, "ok");
  else toast(response.error.message, "warn");
}

function replacePrototypeLabels() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    node.nodeValue = node.nodeValue.replaceAll("（演示）", "（界面占位）");
  }
}

function bindEvents() {
  $$(".rail-btn").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $("#searchInput").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderSessions();
  });
  $("#btnRescan").addEventListener("click", () => void scan());
  $("#btnNewMigration").addEventListener("click", () => openMigration());
  $("#btnExportZip").addEventListener("click", () => openStubWizard("ovExport"));
  $("#btnImportZip").addEventListener("click", () => openStubWizard("ovImport"));
  $("#selMigrate").addEventListener("click", () => openMigration());
  $("#selExport").addEventListener("click", () => openStubWizard("ovExport"));
  $("#selClear").addEventListener("click", () => {
    state.selected.clear();
    renderSessions();
    updateSelectionBar();
  });
  $("#btnMcpMigration").addEventListener("click", () => openStubWizard("ovMcpMigration"));

  const migrationOverlay = $("#ovMigration");
  $("[data-wiz-next]", migrationOverlay).addEventListener("click", () => {
    if (state.migrationStep === 6 && !$("#migConfirm").checked) {
      toast("请先确认实际写入内容", "warn");
      return;
    }
    if (state.migrationTarget === "zcode" && state.migrationStep >= 4 && !state.zcodePreview) return;
    if (state.migrationTarget === "pi" && state.migrationStep >= 4 && !state.piPreview) return;
    if (state.migrationTarget === "claude-code" && state.migrationStep >= 4 && !state.claudePreview) return;
    if ((state.migrationTarget === "codebuddy-international" || state.migrationTarget === "codebuddy-cn") && state.migrationStep >= 4 && !state.codeBuddyPreview) return;
    goMigrationStep(state.migrationStep + 1);
  });
  $("[data-wiz-prev]", migrationOverlay).addEventListener("click", () => goMigrationStep(state.migrationStep - 1));
  $$("[data-wiz-close]", migrationOverlay).forEach((button) => button.addEventListener("click", closeMigration));
  $("#migConfirm").addEventListener("change", () => {
    if (state.migrationStep === 6) $("#ovMigration [data-wiz-next]").disabled = !$("#migConfirm").checked || (state.migrationTarget === "zcode" && !state.zcodePreview) || (state.migrationTarget === "pi" && !state.piPreview) || (state.migrationTarget === "claude-code" && !state.claudePreview) || ((state.migrationTarget === "codebuddy-international" || state.migrationTarget === "codebuddy-cn") && !state.codeBuddyPreview);
  });

  for (const id of Object.keys(STUB_WIZARDS)) {
    const overlay = $(`#${id}`);
    $$("[data-wiz-close]", overlay).forEach((button) => button.addEventListener("click", () => closeStubWizard(overlay)));
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) closeStubWizard(overlay); });
  }
  migrationOverlay.addEventListener("mousedown", (event) => { if (event.target === migrationOverlay) closeMigration(); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const overlay = $$(".overlay.open").at(-1);
    if (!overlay) return;
    if (overlay.id === "ovMigration") closeMigration();
    else closeStubWizard(overlay);
  });
  document.addEventListener("click", (event) => {
    const placeholder = event.target.closest("[data-toast], #view-settings .row-btns .btn, #view-mcp .btn");
    if (placeholder && !placeholder.matches("#btnMcpMigration")) toast("该操作入口已保留，功能尚未实现", "warn");
  });
}

function init() {
  replacePrototypeLabels();
  renderUnimplementedViews();
  bindEvents();
  renderProducts();
  renderSessions();
  renderDetail();
  updateSelectionBar();
  void scan();
}

init();
