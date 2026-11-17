// Prompt Guard — the page half of the plugin.
// Reads and writes this plugin's options; the middleware half reads the same
// object on every request that goes to a selected provider.

const BUILTIN_RULES = globalThis.PROMPT_GUARD_RULES ?? [];
const MATCH = globalThis.PROMPT_GUARD_MATCH;

const EMPTY = { off: false, providers: [], rules: [] };
const SAVE_DEBOUNCE = 700;
const MIN_SET_INTERVAL = 1100;

const api = typeof magpie !== "undefined" ? magpie : null;

const state = { off: false, providers: [], rules: [] };
let providers = [];
let filter = "";
let saveTimer = null;
let lastSet = 0;
let saving = false;
let queued = false;
let testTimer = null;

const on = (id) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node;
};

const statusEl = on("status");

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function inputEl(id) {
  const node = on(id);
  if (!(node instanceof HTMLInputElement)) throw new Error(`not an input: ${id}`);
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLTextAreaElement}
 */
function textareaEl(id) {
  const node = on(id);
  if (!(node instanceof HTMLTextAreaElement)) throw new Error(`not a textarea: ${id}`);
  return node;
}

function normalize(raw) {
  const out = { off: false, providers: [], rules: [] };
  if (!raw || typeof raw !== "object") return out;

  out.off = raw.off === true;

  if (Array.isArray(raw.providers)) {
    out.providers = raw.providers.filter((id) => typeof id === "string" && id !== "");
  }

  if (Array.isArray(raw.rules)) {
    for (const item of raw.rules) {
      if (!item || typeof item !== "object") continue;
      out.rules.push({
        on: item.on !== false,
        find: typeof item.find === "string" ? item.find : "",
        replace: typeof item.replace === "string" ? item.replace : "",
        mode: item.mode === "regex" ? "regex" : "text",
      });
    }
  }

  return out;
}

function hasRuleList(value) {
  return Boolean(value) && typeof value === "object" && "rules" in value;
}

function replaceState(next) {
  state.off = next.off;
  state.providers = next.providers.slice();
  state.rules = next.rules;
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}

function scheduleSave() {
  setStatus("保存中…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), SAVE_DEBOUNCE);
}

async function flush() {
  if (!api) return;
  if (saving) {
    queued = true;
    return;
  }
  const wait = lastSet + MIN_SET_INTERVAL - Date.now();
  if (wait > 0) {
    saveTimer = setTimeout(() => void flush(), wait);
    return;
  }
  saving = true;
  lastSet = Date.now();
  try {
    const saved = await api.options.set({
      off: state.off,
      providers: state.providers,
      rules: state.rules,
    });
    if (saved) replaceState(normalize(saved));
    setStatus("已保存");
  } catch (error) {
    setStatus("保存失败", true);
  }
  saving = false;
  if (queued) {
    queued = false;
    scheduleSave();
  }
}

// ------------------------------------------------------------------ provider

function renderProviderSummary() {
  const summary = on("provider-summary");
  const all = state.providers.includes("*");
  const chosen = state.providers.filter((id) => id !== "*");
  let text = "未选择";
  if (all) text = "全部 provider";
  else if (chosen.length === 1) {
    const hit = providers.find((item) => item.id === chosen[0]);
    text = (hit && hit.name) || chosen[0];
  } else if (chosen.length > 1) text = `${chosen.length} 个 provider`;
  summary.textContent = text;
  summary.classList.toggle("none", !all && chosen.length === 0);
}

function renderPopover() {
  const box = on("pop-list");
  const query = inputEl("pop-search").value.trim().toLowerCase();
  box.textContent = "";

  const all = document.createElement("button");
  all.type = "button";
  all.className = "pop-item all";
  all.setAttribute("role", "checkbox");
  all.setAttribute("aria-checked", String(state.providers.includes("*")));
  all.innerHTML = '<span class="box"></span><span class="name">全部 provider</span>';
  all.addEventListener("click", () => {
    const at = state.providers.indexOf("*");
    if (at === -1) state.providers.push("*");
    else state.providers.splice(at, 1);
    afterProviderChange();
  });
  box.append(all);

  const shown = providers.filter((item) => {
    if (!query) return true;
    return item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query);
  });

  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = providers.length ? "没有匹配的 provider" : "magpie 没有列出 provider";
    box.append(empty);
  }

  for (const provider of shown) {
    const checked = state.providers.includes(provider.id);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pop-item";
    row.setAttribute("role", "checkbox");
    row.setAttribute("aria-checked", String(checked));
    row.innerHTML = '<span class="box"></span><span class="name"></span><span class="id"></span>';
    row.querySelector(".name").textContent = provider.name || provider.id;
    row.querySelector(".id").textContent = provider.name && provider.name !== provider.id ? provider.id : "";
    row.addEventListener("click", () => {
      const at = state.providers.indexOf(provider.id);
      if (at === -1) state.providers.push(provider.id);
      else state.providers.splice(at, 1);
      afterProviderChange();
    });
    box.append(row);
  }
}

function afterProviderChange() {
  renderPopover();
  renderProviderSummary();
  updatePopCount();
  scheduleSave();
}

function updatePopCount() {
  const all = state.providers.includes("*");
  const n = state.providers.filter((id) => id !== "*").length;
  on("pop-count").textContent = all ? "全部" : n ? `已选 ${n}` : "未选择";
}

function openPopover(open) {
  const pop = on("popover");
  const btn = on("provider-btn");
  pop.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open) {
    inputEl("pop-search").value = "";
    renderPopover();
    updatePopCount();
    on("pop-search").focus();
  }
}

// --------------------------------------------------------------------- rules

function ruleRow(rule, index) {
  const row = document.createElement("div");
  row.className = "rule";
  row.dataset.off = String(!rule.on);

  const power = document.createElement("button");
  power.type = "button";
  power.className = "switch";
  power.setAttribute("role", "switch");
  power.setAttribute("aria-checked", String(rule.on));
  power.setAttribute("aria-label", "启用这条规则");
  power.innerHTML = '<span class="track"><span class="knob"></span></span>';
  power.addEventListener("click", () => {
    rule.on = !rule.on;
    power.setAttribute("aria-checked", String(rule.on));
    row.dataset.off = String(!rule.on);
    scheduleSave();
    scheduleTest();
  });

  const find = document.createElement("input");
  find.type = "text";
  find.className = "field find";
  find.value = rule.find;
  find.placeholder = "查找（例：You are Claude Code）";
  find.setAttribute("aria-label", `规则 ${index + 1} 查找内容`);
  find.addEventListener("input", () => {
    rule.find = find.value;
    validate();
    scheduleSave();
    scheduleTest();
  });

  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");

  const replace = document.createElement("input");
  replace.type = "text";
  replace.className = "field replace";
  replace.value = rule.replace;
  replace.placeholder = "替换为（例：You are a coding assistant）";
  replace.setAttribute("aria-label", `规则 ${index + 1} 替换内容`);
  replace.addEventListener("input", () => {
    rule.replace = replace.value;
    scheduleSave();
    scheduleTest();
  });

  const mode = document.createElement("button");
  mode.type = "button";
  mode.className = "chip mode";
  mode.dataset.on = String(rule.mode === "regex");
  mode.textContent = rule.mode === "regex" ? "正则" : "文本";
  mode.setAttribute("aria-label", `规则 ${index + 1} 匹配方式`);
  mode.addEventListener("click", () => {
    rule.mode = rule.mode === "regex" ? "text" : "regex";
    mode.dataset.on = String(rule.mode === "regex");
    mode.textContent = rule.mode === "regex" ? "正则" : "文本";
    validate();
    scheduleSave();
    scheduleTest();
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.setAttribute("aria-label", `删除规则 ${index + 1}`);
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    state.rules.splice(index, 1);
    renderRules();
    scheduleSave();
    scheduleTest();
  });

  const validate = () => {
    if (rule.mode !== "regex" || !rule.find.trim()) {
      find.removeAttribute("aria-invalid");
      return;
    }
    try {
      new RegExp(rule.find);
      find.removeAttribute("aria-invalid");
    } catch (error) {
      find.setAttribute("aria-invalid", "true");
    }
  };
  validate();

  row.append(power, find, arrow, replace, mode, remove);
  return row;
}

function visibleRules() {
  if (!filter) return state.rules;
  return state.rules.filter(
    (rule) => rule.find.toLowerCase().includes(filter) || rule.replace.toLowerCase().includes(filter)
  );
}

function renderRules() {
  const box = on("rules");
  box.textContent = "";

  const countEl = on("count");
  const off = state.rules.filter((rule) => !rule.on).length;
  countEl.textContent = state.rules.length
    ? `${state.rules.length} 条规则${off ? ` · ${off} 条停用` : ""}`
    : "";

  if (!state.rules.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "还没有规则。新增一条，把上游会拒绝的句子换成同义说法。";
    box.append(empty);
    return;
  }

  const shown = visibleRules();
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没有规则匹配这个筛选。";
    box.append(empty);
    return;
  }

  for (const rule of shown) box.append(ruleRow(rule, state.rules.indexOf(rule)));
}

function addRule() {
  state.rules.unshift({ on: true, find: "", replace: "", mode: "text" });
  if (filter) {
    filter = "";
    inputEl("filter").value = "";
  }
  renderRules();
  scheduleSave();
  scheduleTest();
  const first = on("rules").querySelector(".rule .find");
  if (first instanceof HTMLInputElement) {
    first.focus();
    first.scrollIntoView({ block: "nearest" });
  }
}

// -------------------------------------------------------------------- phrases

// magpie serves plugin pages under `connect-src 'self'`: the page has no
// network at all, so the community list arrives as a file the user picks —
// downloaded from the repository, or written by hand. Nothing here touches
// fetch, and a malformed file leaves the current rules untouched.
function applyPhrases(data) {
  const phrases = Array.isArray(data && data.phrases) ? data.phrases : null;
  if (!phrases) throw new Error("不是 phrases.json 的结构");
  const rules = phrases
    .map((phrase) => ({
      on: true,
      find: typeof phrase.find === "string" ? phrase.find : "",
      replace: typeof phrase.replace === "string" ? phrase.replace : "",
      mode: phrase.mode === "regex" ? "regex" : "text",
    }))
    .filter((rule) => rule.find && rule.replace);
  if (!rules.length) throw new Error("词库里没有可用规则");
  state.rules = rules;
  if (filter) {
    filter = "";
    inputEl("filter").value = "";
  }
  renderRules();
  scheduleSave();
  scheduleTest();
  return { count: rules.length, updated: typeof data.updated === "string" ? data.updated : "" };
}

function setImportStatus(text, tone) {
  const status = on("import-status");
  status.dataset.tone = tone || "";
  status.textContent = text;
}

function openImport(open) {
  const panel = on("import-panel");
  on("import").setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
  if (open) textareaEl("import-text").focus();
}

function applyImport() {
  const text = textareaEl("import-text").value.trim();
  if (!text) {
    setImportStatus("先粘贴 phrases.json 的内容", "error");
    return;
  }
  try {
    const done = applyPhrases(JSON.parse(text));
    setImportStatus(`已导入 ${done.count} 条${done.updated ? " · " + done.updated : ""}`);
  } catch (error) {
    setImportStatus("导入失败：" + (error && error.message ? error.message : String(error)), "error");
  }
}

async function copyImportLink() {
  const field = inputEl("import-url");
  const url = field.value;
  field.focus();
  field.select();
  try {
    await navigator.clipboard.writeText(url);
    setImportStatus("已复制地址");
    return;
  } catch (error) {
    // a webview may refuse the clipboard API; the selected text is the fallback
  }
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    copied = false;
  }
  setImportStatus(copied ? "已复制地址" : "已选中地址，按 Ctrl+C 复制");
}

// -------------------------------------------------------------------- tester

function scheduleTest() {
  clearTimeout(testTimer);
  testTimer = setTimeout(renderTest, 120);
}

function renderTest() {
  const input = textareaEl("test-in").value;
  const out = on("test-out");
  out.textContent = "";

  if (!MATCH) {
    const note = document.createElement("div");
    note.className = "test-summary";
    note.textContent = "匹配模块没有加载。";
    out.append(note);
    return;
  }

  if (!input.trim()) {
    const note = document.createElement("div");
    note.className = "test-summary";
    note.textContent = "粘贴一段系统提示，这里会显示每一条命中的规则和改写结果。";
    out.append(note);
    return;
  }

  const compiled = MATCH.compile(state.rules);
  const result = MATCH.testText(input, compiled);
  const total = result.hits.reduce((sum, hit) => sum + hit.count, 0);

  const summary = document.createElement("div");
  summary.className = "test-summary";
  if (total === 0) {
    summary.textContent = "没有命中任何规则，这段文本会原样发出。";
  } else {
    const strong = document.createElement("strong");
    strong.textContent = String(total);
    summary.append("命中 ", strong, ` 处，${result.hits.length} 条规则参与；改写后：`);
  }
  out.append(summary);

  for (const hit of result.hits) {
    const row = document.createElement("div");
    row.className = "hit";
    row.innerHTML = '<span class="from"></span><span class="to"></span><span class="n"></span>';
    row.querySelector(".from").textContent = hit.find;
    row.querySelector(".to").textContent = hit.replace || "（删除）";
    row.querySelector(".n").textContent = `×${hit.count}`;
    out.append(row);
  }

  if (total > 0) {
    const pre = document.createElement("pre");
    pre.className = "result";
    pre.textContent = result.out;
    out.append(pre);
  }

  if (state.off) {
    const note = document.createElement("div");
    note.className = "test-summary";
    note.textContent = "插件当前已停用，真实请求不会被改写。";
    out.append(note);
  }
}

// ---------------------------------------------------------------------- boot

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "providers" in value) {
    return Array.isArray(value.providers) ? value.providers : [];
  }
  return [];
}

function toProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = "id" in item ? item.id : "provider" in item ? item.provider : undefined;
  if (typeof id !== "string" || id === "") return null;
  const name = "name" in item && typeof item.name === "string" ? item.name : "";
  return { id: id, name: name };
}

async function boot() {
  if (!api) {
    setStatus("未连接 magpie", true);
    return;
  }

  try {
    await api.ready;
  } catch (error) {
    // the window answers late sometimes; the defaults below still render
  }

  const power = on("power");
  power.addEventListener("click", () => {
    state.off = !state.off;
    power.setAttribute("aria-checked", String(!state.off));
    scheduleSave();
    scheduleTest();
  });

  on("add").addEventListener("click", addRule);

  on("import").addEventListener("click", () => openImport(on("import-panel").hidden));
  const importLink = on("import-link");
  if (importLink instanceof HTMLAnchorElement) inputEl("import-url").value = importLink.href;
  on("import-link").addEventListener("click", (event) => {
    if (!(importLink instanceof HTMLAnchorElement)) return;
    // a plain click inside the app's webview is treated as in-app navigation;
    // asking for a new window is the same path Ctrl+click takes
    event.preventDefault();
    window.open(importLink.href, "_blank", "noopener");
  });
  on("import-copy").addEventListener("click", copyImportLink);
  inputEl("import-url").addEventListener("click", () => inputEl("import-url").select());
  on("import-apply").addEventListener("click", applyImport);

  on("filter").addEventListener("input", (event) => {
    filter = inputEl("filter").value.trim().toLowerCase();
    renderRules();
  });

  on("provider-btn").addEventListener("click", () => {
    openPopover(on("popover").hidden);
  });
  on("pop-search").addEventListener("input", renderPopover);
  on("pop-clear").addEventListener("click", () => {
    state.providers = [];
    afterProviderChange();
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node)) return;
    if (!on("popover").hidden) {
      const wrap = on("provider-btn").parentElement;
      if (!wrap || !wrap.contains(event.target)) openPopover(false);
    }
    if (!on("import-panel").hidden) {
      const wrap = on("import").parentElement;
      if (!wrap || !wrap.contains(event.target)) openImport(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!on("popover").hidden) {
      openPopover(false);
      on("provider-btn").focus();
      return;
    }
    if (!on("import-panel").hidden) {
      openImport(false);
      on("import").focus();
    }
  });

  const testIn = on("test-in");
  testIn.addEventListener("input", scheduleTest);
  testIn.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      renderTest();
    }
  });

  try {
    const items = asList(await api.read("providers:list"));
    providers = items.map(toProvider).filter(Boolean);
  } catch (error) {
    providers = [];
  }

  /** @type {unknown} */
  let saved = EMPTY;
  try {
    saved = await api.options.get();
  } catch (error) {
    saved = EMPTY;
  }

  const next = normalize(saved);
  if (!hasRuleList(saved)) next.rules = BUILTIN_RULES.map((rule) => ({ ...rule }));

  replaceState(next);
  power.setAttribute("aria-checked", String(!state.off));
  renderProviderSummary();
  updatePopCount();
  renderRules();
  renderTest();
  setStatus("");
}

void boot();
