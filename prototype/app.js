"use strict";

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

const PRODUCT_META = {
  codex: { name: "Codex", label: "C", color: "#8b949e" },
  qoder: { name: "Qoder 国际版", label: "Q", color: "#4f8cff" },
  qodercn: { name: "Qoder CN", label: "QCN", color: "#22b573" },
  cursor: { name: "Cursor", label: "Cu", color: "#f0883e" },
  claude: { name: "Claude Code", label: "Cl", color: "#d97757" },
  codebuddy: { name: "CodeBuddy", label: "B", color: "#7c6ff0" },
  dsh: { name: "DeepSeek Harness", label: "D", color: "#35b6e8" },
  zcode: { name: "ZCode", label: "Z", color: "#22c3b5" },
  pi: { name: "Pi", label: "π", color: "#c084fc" },
};

const PRODUCT_ORDER = ["codex", "qoder", "qodercn", "cursor", "claude", "codebuddy", "dsh", "zcode", "pi"];
const MIGRATION_TARGETS = {
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
  const resultTarget = migrationTarget(state.lastResult?.continuation?.product);
  const result = state.lastResult?.sourceThreadId === thread.id ? `
    <div class="detail-sec">
      <div class="ds-label">最近迁移结果</div>
      <div class="result-card compact-result">
        <div class="result-icon ok">✓</div>
        <div>
          <strong>${esc(resultTarget.name)} 原生历史已创建并回读校验</strong>
          <div class="muted-note mono">Session ${esc(state.lastResult.targetSessionId)}</div>
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
      ${canPrepareDsh
        ? '<button class="btn btn-ghost" id="detailPrepareDsh">启用 DSH 本地迁移桥…</button>'
        : `<button class="btn btn-ghost" id="detailMigrateDsh" ${canMigrateDsh ? "" : "disabled"}>迁移到 DeepSeek Harness…</button>`}
      <button class="btn btn-ghost" id="detailExport">导出为 ZIP… <span class="badge b-warn">未实现</span></button>
    </div>`;
  $("#detailMigrateInternational").addEventListener("click", () => openMigration(thread, "qoder-international"));
  $("#detailMigrateCn").addEventListener("click", () => openMigration(thread, "qoder-cn"));
  $("#detailMigrateCursor").addEventListener("click", () => openMigration(thread, "cursor"));
  $("#detailMigrateZcode").addEventListener("click", () => openMigration(thread, "zcode"));
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
    toast("未发现可用的 Qoder、Cursor 或 DeepSeek Harness，请先安装并启用目标", "warn");
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
      $(".rcard-head", card).textContent = isZcode ? "完整原生历史" : "标准";
      $(".rcard-desc", card).textContent = isZcode
        ? "全部可见消息 · 保留原顺序与独立角色"
        : "Handoff + 最近 N 轮 + 关键证据";
    }
  });
  const targetNotes = $$('[data-pane="2"] .muted-note', overlay);
  targetNotes[0].textContent = `目标路径不可修改：${target.name} 会话固定创建在源会话的同一工作区。`;
  targetNotes[1].textContent = isCursor
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
        <div class="ho-sec"><div class="ho-label">写入方式</div><div class="ho-body sm">${isZcode ? "ZCode session/create(importedHistory) + 精确桌面任务登记" : isCursor ? "Cursor developer.bulkImportChats · Chat JSON v1" : isDsh ? "DSH ctx.agents.create + SessionEvent v0 seed + workspace.attachSession" : "Qoder session/new + appendHistoryTurn"}</div></div>
        <div class="ho-sec"><div class="ho-label">模型调用</div><div class="ho-body sm ok">${isZcode ? "禁止 session/send；迁移子进程禁止网络" : isCursor ? "禁止 startComposerPrompt 与 sendToAgent" : isDsh ? "禁止 agent.followup / steer 与 session.prompt" : "禁止 session/prompt 与 chat/ask"}</div></div>
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
    : "执行前记录源快照和写入计划；失败结果与目标清理情况保存在迁移记录中。";
  $('[data-pane="6"] .ops', overlay).innerHTML = `
    <div class="op-row"><span class="op-badge b-backup">只读</span><div class="op-main"><code>${esc(thread.path)}</code><div class="op-sub">迁移前后 fingerprint 必须一致</div></div></div>
    <div class="op-row"><span class="op-badge b-create">创建</span><div class="op-main"><code>IDE Hub/migrations/&lt;新 migration id&gt;/</code><div class="op-sub">source snapshot · capsule · projection · loss report · journal</div></div></div>
    <div class="op-row"><span class="op-badge b-create">创建</span><div class="op-main"><code>${esc(target.name)}原生会话</code><div class="op-sub">工作区：${esc(thread.cwd)} · 逐轮写入、回读和历史列表可见性校验</div></div></div>
    <div class="op-row"><span class="op-badge b-conf">不修改</span><div class="op-main"><code>Codex / ${esc(target.name)} MCP 配置</code><div class="op-sub">迁移前后指纹必须一致</div></div></div>`;
}

function goMigrationStep(step) {
  if (!state.migrationThread || step < 1 || step > MIGRATION_STEPS.length) return;
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
  if (step === 3) renderSourceChecks();
  if (step === 7 && !state.migrationStarted) void executeMigration();
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
  const labels = [
    "只读读取 Codex 源会话并复核源文件",
    "生成 source snapshot、Capsule 与会话投影",
    `在相同工作区创建 ${target.name} 原生会话`,
    "逐轮回读正文并验证 Chat History 可见",
    "复核 Codex 源文件与 MCP 指纹",
  ];
  $("#migTimeline").innerHTML = labels.map((label, index) => {
    const className = mode === "done" ? "done" : mode === "error" && index === 0 ? "failed" : index === 0 ? "running" : "";
    return `<div class="st-item ${className}"><span class="st-dot"></span><span>${label}</span><span class="st-time">${mode === "done" ? "✓" : ""}</span></div>`;
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
    renderMigrationTimeline("done");
    renderMigrationResult(response.data);
    toast(`${target.name} 原生会话迁移完成并通过回读校验`, "ok");
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
  const container = $("#migResult");
  const loss = result.details.lossReport;
  const target = migrationTarget(result.continuation.product);
  const continuationHelp = result.continuation.product === "cursor"
    ? `已按目标 Session ID 请求 Cursor 打开该原生会话；也可从 Chat History 中按“Codex · …”标题找到它。`
    : result.continuation.product === "zcode"
      ? `ZCode 原生历史已重开回读，桌面任务已登记。点击下方按钮打开项目，在任务列表找到“Codex · …”。当前入口只打开项目，不声称自动定位指定会话；Session ID：${result.targetSessionId}。迁移阶段不发送模型消息。`
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
    </div>
    <div class="banner banner-info result-help">${esc(continuationHelp)}</div>
    <div class="result-actions">
      <button class="btn btn-primary" id="migOpenTarget">打开 ${esc(target.name)} 工作区</button>
      <button class="btn btn-ghost" data-real-close>关闭向导</button>
      <button class="btn btn-danger-ghost" disabled>回滚（未实现）</button>
    </div>`;
  $("#migOpenTarget").addEventListener("click", () => void openTarget(result.workspace, result.continuation.product, result.targetSessionId));
  $("[data-real-close]", container).addEventListener("click", closeMigration);
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
    goMigrationStep(state.migrationStep + 1);
  });
  $("[data-wiz-prev]", migrationOverlay).addEventListener("click", () => goMigrationStep(state.migrationStep - 1));
  $$("[data-wiz-close]", migrationOverlay).forEach((button) => button.addEventListener("click", closeMigration));
  $("#migConfirm").addEventListener("change", () => {
    if (state.migrationStep === 6) $("#ovMigration [data-wiz-next]").disabled = !$("#migConfirm").checked || (state.migrationTarget === "zcode" && !state.zcodePreview);
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
