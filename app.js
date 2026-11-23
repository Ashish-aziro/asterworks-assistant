// AsterWorks Assistant: chat front end for the Apex (ApexFlow) prediction API.
(() => {
  "use strict";

  const API_URL = "https://apex.aziro.io/apexflow/api/v1/prediction/1700a5e7-a843-4cdc-be31-79372e24ca08";
  const HUMAN_INPUT_NODE = "humanInputAgentflow_0";
  const APPROVAL_PREFIX = "**Please approve this action.**";
  const REQUEST_TIMEOUT_MS = 180000;
  const STATUS_INTERVAL_MS = 4000;
  const STORAGE_KEY = "aw-assistant-chat-v1";
  const MAX_STORED_MESSAGES = 60;
  const STATUS_STEPS = [
    "Searching Jira, Confluence and Slack",
    "Reading GitHub, Drive and Gmail",
    "Checking Salesforce",
    "Putting the answer together",
  ];

  const $ = (id) => document.getElementById(id);
  const log = $("log");
  const empty = $("empty");
  const form = $("composer");
  const input = $("q");
  const sendBtn = $("send");

  let state = loadState();
  let busy = false;

  // ---------- storage (per-browser convenience only) ----------
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved.chatId === "string" && Array.isArray(saved.messages)) return saved;
    } catch (e) { /* storage unavailable or corrupt: start fresh */ }
    return { chatId: newId(), messages: [] };
  }

  function saveState() {
    try {
      const messages = state.messages.slice(-MAX_STORED_MESSAGES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatId: state.chatId, messages }));
    } catch (e) { /* storage unavailable: the chat still works for this visit */ }
  }

  // ---------- safe markdown (DOM nodes only, never innerHTML) ----------
  const INLINE = /(`[^`\n]+`)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^|>\s]+)\|([^>\n]+)>|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"\]])/g;

  function link(href, label) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    return a;
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) { const c = document.createElement("code"); c.textContent = m[1].slice(1, -1); parent.append(c); }
      else if (m[2]) parent.append(link(m[3], m[2]));
      else if (m[4]) parent.append(link(m[4], m[5]));
      else if (m[6]) { const b = document.createElement("strong"); inline(b, m[6]); parent.append(b); }
      else if (m[7]) parent.append(link(m[7], m[7]));
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function markdown(text) {
    const root = document.createDocumentFragment();
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    let para = null;
    let list = null;
    const closeAll = () => { para = null; list = null; };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        closeAll();
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
        code.textContent = body.join("\n");
        pre.append(code);
        root.append(pre);
        continue;
      }
      if (!line.trim()) { closeAll(); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeAll(); root.append(document.createElement("hr")); continue; }
      const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (heading) {
        closeAll();
        const h = document.createElement(heading[0].trim().startsWith("# ") ? "h3" : "h4");
        inline(h, heading[1]);
        root.append(h);
        continue;
      }
      const item = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
      if (item) {
        para = null;
        const tag = item[1] ? "UL" : "OL";
        if (!list || list.tagName !== tag) { list = document.createElement(tag); root.append(list); }
        const li = document.createElement("li");
        inline(li, item[3]);
        list.append(li);
        continue;
      }
      list = null;
      if (para) para.append(document.createElement("br"));
      else { para = document.createElement("p"); root.append(para); }
      inline(para, line.trim());
    }
    return root;
  }

  // ---------- rendering ----------
  function avatar() {
    const wrap = document.createElement("div");
    wrap.className = "avatar";
    const img = document.createElement("img");
    img.src = "assets/aziro-logo.png";
    img.alt = "";
    wrap.append(img);
    return wrap;
  }

  function messageRow(role) {
    const row = document.createElement("div");
    row.className = "msg " + (role === "user" ? "user" : "bot");
    if (role !== "user") row.append(avatar());
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    row.append(bubble);
    return { row, bubble };
  }

  function approvalCard(msg, index) {
    const card = document.createElement("div");
    card.className = "approval";
    const head = document.createElement("div");
    head.className = "approval-head";
    const badge = document.createElement("span");
    badge.className = "az-badge";
    badge.textContent = "Approval needed";
    const note = document.createElement("span");
    note.className = "approval-note";
    note.textContent = "Nothing changes until you choose Proceed.";
    head.append(badge, note);
    const body = document.createElement("div");
    body.append(markdown(msg.text.slice(APPROVAL_PREFIX.length).replace(/^[^\n]*\n?/, "")));
    card.append(head, body);

    if (msg.decided) {
      const status = document.createElement("div");
      status.className = "approval-status";
      status.textContent = msg.decided === "proceed" ? "You approved this action." : "You rejected this action.";
      card.append(status);
      return card;
    }
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const proceed = document.createElement("button");
    proceed.type = "button";
    proceed.className = "az-btn az-btn-primary";
    proceed.textContent = "Proceed";
    proceed.addEventListener("click", () => decide(index, "proceed"));
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "az-btn az-btn-secondary";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => decide(index, "reject"));
    actions.append(proceed, reject);
    card.append(actions);
    return card;
  }

  function render() {
    log.querySelectorAll(".msg").forEach((n) => n.remove());
    empty.hidden = state.messages.length > 0;
    state.messages.forEach((msg, index) => {
      const { row, bubble } = messageRow(msg.role);
      if (msg.role === "user") bubble.textContent = msg.text;
      else if (msg.kind === "approval") bubble.append(approvalCard(msg, index));
      else if (msg.kind === "error") { bubble.classList.add("error"); bubble.textContent = msg.text; }
      else bubble.append(markdown(msg.text));
      log.append(row);
    });
    setBusy(busy);
    log.scrollTop = log.scrollHeight;
  }

  function showThinking() {
    const { row, bubble } = messageRow("bot");
    row.classList.add("pending");
    const box = document.createElement("div");
    box.className = "thinking";
    box.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    const label = document.createElement("span");
    box.append(label);
    bubble.append(box);
    log.append(row);
    log.scrollTop = log.scrollHeight;
    const started = Date.now();
    const tick = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      const step = STATUS_STEPS[Math.min(STATUS_STEPS.length - 1, Math.floor(secs * 1000 / STATUS_INTERVAL_MS))];
      label.textContent = step + "… " + secs + "s";
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { clearInterval(timer); row.remove(); };
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    input.disabled = value;
    document.querySelectorAll(".chips .az-chip, .approval-actions .az-btn").forEach((b) => { b.disabled = value; });
  }

  // ---------- API ----------
  function readReply(raw, contentType) {
    const text = String(raw || "");
    if (/json/i.test(contentType) || /^\s*\{/.test(text)) {
      try {
        const data = JSON.parse(text);
        if (data && typeof data.text === "string") return data.text;
        if (data && typeof data.message === "string") return data.message;
      } catch (e) { /* not JSON: use the plain-text body */ }
    }
    return text;
  }

  async function callApex(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const reply = readReply(await res.text(), res.headers.get("content-type") || "");
      if (!res.ok) throw new Error("The assistant returned an error (HTTP " + res.status + ")" + (reply ? ": " + reply.slice(0, 300) : "."));
      return reply.trim() || "The assistant returned an empty reply. Please try again.";
    } catch (err) {
      if (err.name === "AbortError") throw new Error("The assistant took longer than 3 minutes to reply. Please try again.");
      if (err instanceof TypeError) throw new Error("Couldn't reach the assistant. Check your connection and try again.");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(body) {
    setBusy(true);
    const stopThinking = showThinking();
    try {
      const reply = await callApex(body);
      const kind = reply.startsWith(APPROVAL_PREFIX) ? "approval" : "answer";
      state.messages = [...state.messages, { role: "bot", kind, text: reply }];
    } catch (err) {
      state.messages = [...state.messages, { role: "bot", kind: "error", text: String(err.message || err) }];
    } finally {
      stopThinking();
      busy = false;
      saveState();
      render();
      input.focus();
    }
  }

  function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    state.messages = [...state.messages, { role: "user", text: q }];
    saveState();
    render();
    run({ question: q, chatId: state.chatId });
  }

  function decide(index, type) {
    if (busy) return;
    state.messages = state.messages.map((m, i) => (i === index ? { ...m, decided: type } : m));
    saveState();
    render();
    run({
      question: "",
      chatId: state.chatId,
      humanInput: { type, startNodeId: HUMAN_INPUT_NODE, nodeId: HUMAN_INPUT_NODE, feedback: "" },
    });
  }

  // ---------- events ----------
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
    input.classList.toggle("scroll", input.scrollHeight > 180);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = "";
    autosize();
    ask(q);
  });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  document.querySelectorAll(".chips .az-chip").forEach((chip) => chip.addEventListener("click", () => ask(chip.dataset.q)));
  $("newChat").addEventListener("click", () => {
    if (busy) return;
    state = { chatId: newId(), messages: [] };
    saveState();
    render();
    input.focus();
  });

  render();
})();
