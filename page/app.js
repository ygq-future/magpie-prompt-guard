// Prompt Guard — the page half of the plugin.
// Reads and writes this plugin's options; the middleware half reads the same
// object on every request whose model matches the configured wildcards.

const BUILTIN_RULES = globalThis.PROMPT_GUARD_RULES ?? [];
const MATCH = globalThis.PROMPT_GUARD_MATCH;
const DEFAULT_MODELS = ["*gemini*"];
const TROUBLESHOOT_PROMPT = `我的请求通过 Antigravity 上游触发了通用 429 (\`RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).\` 且无 details)，这通常是因为系统提示词中的某个关键词/短语命中了上游风控。

请你使用**二分法（Binary Search）**帮我定位具体是系统提示词中的哪一个关键词触发了 429：
1. 构造最小复现：尽量使用快速的 flash-lite 小模型（如 \`gemini-3.5-flash-lite\`）进行验证；保留触发 429 的原始系统提示词（将 \`max_tokens\` 设为 \`16\` 等最小值，用户消息设为简单内容如 \`hi\`），确认稳定返回该通用 429。
2. 刷新 429 冷却状态（关键）：**每次遇到 429 后**，都必须先发送一次小的、干净的、不带任何系统提示词的简短提问（如 \`hi\`）来刷新冷却状态，确认返回 **200** 后再进行下一轮 429 排查；如果干净请求同样返回 429，说明前面尝试过多已影响干净请求，需**停下来冷却 2 分钟**，再继续用干净请求验证，直到回复 200 才能继续尝试碰撞 429。
3. 二分系统提示词：将 \`system\` / \`instructions\` / \`systemInstruction\` 文本对半拆分，分别测试保留前半段和保留后半段，哪一半继续触发 429 就继续对该半对半拆分测试。
4. 缩窄至最短短语：逐层从段落 -> 句子 -> 词组继续二分，直到找出删除其中任意关键单词就不再触发 429 的**最短连续触发短语**。
5. 输出结果：告诉我定位到的「触发原文」以及建议的「无害替换文本」，我将直接添加到 Prompt Guard 规则中（仅作用于系统提示词）。`;

const EMPTY = { off: false, models: DEFAULT_MODELS.slice(), rules: [] };
const SAVE_DEBOUNCE = 700;
const MIN_SET_INTERVAL = 1100;

const api = typeof magpie !== "undefined" ? magpie : null;

const state = { off: false, models: DEFAULT_MODELS.slice(), rules: [] };
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
  const out = { off: false, models: DEFAULT_MODELS.slice(), rules: [] };
  if (!raw || typeof raw !== "object") return out;

  out.off = raw.off === true;

  if (Array.isArray(raw.models)) {
    out.models = raw.models
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item !== "");
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
  state.models = next.models.slice();
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
      models: state.models,
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

// --------------------------------------------------------------------- model

function renderModelSummary() {
  const summary = on("model-summary");
  const list = state.models;
  let text = "未配置";
  if (list.includes("*")) text = "全部模型 (*)";
  else if (list.length === 1) text = list[0];
  else if (list.length > 1) text = `${list.length} 个模型规则`;
  summary.textContent = text;
  summary.classList.toggle("none", list.length === 0);
}

function addModelPattern(raw) {
  const pattern = raw.trim();
  if (!pattern) return;
  if (!state.models.some((item) => item.toLowerCase() === pattern.toLowerCase())) {
    state.models.push(pattern);
    afterModelChange();
  }
  inputEl("pop-input").value = "";
  on("pop-input").focus();
}

function renderPopover() {
  const box = on("pop-list");
  box.textContent = "";

  if (!state.models.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "未配置模型规则，支持 * 和 ? 通配符";
    box.append(empty);
    return;
  }

  state.models.forEach((pattern, index) => {
    const row = document.createElement("div");
    row.className = "pop-model-item";
    row.setAttribute("role", "listitem");

    const code = document.createElement("code");
    code.className = "pop-model-code";
    code.textContent = pattern;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "pop-model-del";
    del.setAttribute("aria-label", `删除 ${pattern}`);
    del.textContent = "×";
    del.addEventListener("click", () => {
      state.models.splice(index, 1);
      afterModelChange();
    });

    row.append(code, del);
    box.append(row);
  });
}

function afterModelChange() {
  renderPopover();
  renderModelSummary();
  updatePopCount();
  scheduleSave();
}

function updatePopCount() {
  const n = state.models.length;
  on("pop-count").textContent = n ? `${n} 条规则` : "未配置";
}

function openPopover(open) {
  const pop = on("popover");
  const btn = on("model-btn");
  pop.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open) {
    renderPopover();
    updatePopCount();
    on("pop-input").focus();
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
function openTroubleshoot(open) {
  const panel = on("troubleshoot-panel");
  const btn = on("troubleshoot");
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open) {
    on("troubleshoot-status").textContent = "";
    const area = textareaEl("troubleshoot-text");
    area.focus();
    area.select();
  }
}

async function copyTroubleshootPrompt() {
  const area = textareaEl("troubleshoot-text");
  const status = on("troubleshoot-status");
  try {
    await navigator.clipboard.writeText(area.value);
    status.textContent = "已复制";
  } catch (error) {
    area.focus();
    area.select();
    status.textContent = "请按 Ctrl+C 复制";
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

  textareaEl("troubleshoot-text").value = TROUBLESHOOT_PROMPT;
  on("troubleshoot").addEventListener("click", () => openTroubleshoot(on("troubleshoot-panel").hidden));
  on("troubleshoot-copy").addEventListener("click", copyTroubleshootPrompt);
  on("import").addEventListener("click", () => openImport(on("import-panel").hidden));
  const importLink = on("import-link");
  if (importLink instanceof HTMLAnchorElement) inputEl("import-url").value = importLink.href;
  on("import-copy").addEventListener("click", copyImportLink);
  inputEl("import-url").addEventListener("click", () => inputEl("import-url").select());
  on("import-apply").addEventListener("click", applyImport);

  on("filter").addEventListener("input", (event) => {
    filter = inputEl("filter").value.trim().toLowerCase();
    renderRules();
  });

  on("model-btn").addEventListener("click", () => {
    openPopover(on("popover").hidden);
  });
  on("pop-add").addEventListener("click", () => {
    addModelPattern(inputEl("pop-input").value);
  });
  on("pop-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addModelPattern(inputEl("pop-input").value);
    }
  });
  on("pop-clear").addEventListener("click", () => {
    state.models = [];
    afterModelChange();
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node)) return;
    if (!on("popover").hidden) {
      const wrap = on("model-btn").parentElement;
      if (!wrap || !wrap.contains(event.target)) openPopover(false);
    }
    if (!on("import-panel").hidden) {
      const wrap = on("import").parentElement;
      if (!wrap || !wrap.contains(event.target)) openImport(false);
    }
    if (!on("troubleshoot-panel").hidden) {
      const wrap = on("troubleshoot").parentElement;
      if (!wrap || !wrap.contains(event.target)) openTroubleshoot(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!on("popover").hidden) {
      openPopover(false);
      on("model-btn").focus();
      return;
    }
    if (!on("import-panel").hidden) {
      openImport(false);
      on("import").focus();
    }
    if (!on("troubleshoot-panel").hidden) {
      openTroubleshoot(false);
      on("troubleshoot").focus();
      return;
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
  renderModelSummary();
  updatePopCount();
  renderRules();
  renderTest();
  setStatus("");
}

void boot();
