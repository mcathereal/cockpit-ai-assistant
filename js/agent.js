/* AI Assistant - Cockpit-Plugin: LLM-Agent mit beschraenkten, gehaerteten Host-Tools.
 * MIT License - see LICENSE.
 * Grundsaetze:
 *  - Keine freie Shell: ausschliesslich Allowlist (cockpit.spawn argv, feste Schalter).
 *  - LLM sieht standardmaessig NUR Klartext-Text, keine Befehle; Aktionen erst nach GUI-Bestaetigung.
 *  - API-Keys landen in der Secret-Collection (Coin) des Hosts, NICHT im Browser/HTML.
 *  - Jede Tool-Ausgabe wird vor dem RUckweg ins LLM redacted (Secrets/IPs optional).
 *  - Stabilitaet: Timeouts, Chat-Kurzhalten (FIFO), Fehler => saubere Fehlerbox statt Absturz.
 */
(function () {
  "use strict";

  const cockpit = window.cockpit;
  const $ = s => document.querySelector(s);

  const SETTINGS_FILE = "/var/lib/cockpit/ai-assistant.json";
  const LS_KEY = "ai-assistant-settings";
  const LS_UI = "ai-assistant-ui";
  const COIN_SERVICE = "ai-assistant";
  const KEY_DIR = "/var/lib/cockpit/ai-assistant-keys";
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;
  const UNIT_RE = /^[A-Za-z0-9@_.:+-]{1,64}$/;
  const TEMPLATE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
  const MAX_TOOL_ROUNDS = 8;
  const MAX_MESSAGES = 24;
  const LLM_TIMEOUT_MS = 120000;
  const MAX_OUTPUT = 12000;
  const LS_CHATS = "ai-assistant-chats";
  const DEFAULT_UI = {
    place: "both",          // both | page | float
    corner: "rb",           // rb | lb | rt | lt
    theme: "auto",          // auto | dark | light
    lang: "auto"            // auto | de | en
  };
  let ui = JSON.parse(JSON.stringify(DEFAULT_UI));
  const VERSION = "1.3.0";
  const GH_REPO = "mcathereal/cockpit-ai-assistant";
  const TYPEWRITER_SPEED = 18;     // ms pro Zeichen
  let totalTokens = 0;

  const DEFAULT_SETTINGS = {
    active: 0,
    profiles: [
      {
        name: "Ollama (lokal)",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5:14b",
        keyStored: false,
        keyStore: "user",        // user | coin | browser
        level: "diagnose",        // off | diagnose | advisory | act
        redact: true,
        tools: null,              // null = level-Default; sonst [] = alle ausser write
        temperature: 0.2,
        maxTokens: 4096,
        topP: 1.0
      }
    ]
  };

  /* Stufe-Empfehlungen: "von" = read-only, "bis" = mit GUI-Bestaetigung */
  const LEVELS = {
    off: { label: "Aus", ro: [], wr: [] },
    diagnose: { label: "Nur Diagnose", ro: ["vm_list", "vm_info", "vm_xml", "vm_snapshots", "vm_console_log", "journal", "host_status", "dmesg"], wr: [] },
    advisory: { label: "Diagnose + Empfehlung (Default)", ro: ["vm_list", "vm_info", "vm_xml", "vm_snapshots", "vm_console_log", "journal", "host_status", "dmesg", "read_file"], wr: [] },
    act: { label: "Diagnose + Aktion (mit Bestaetigung)", ro: ["vm_list", "vm_info", "vm_xml", "vm_snapshots", "vm_console_log", "journal", "host_status", "dmesg", "read_file"], wr: ["vm_start", "vm_shutdown", "vm_stop"] }
  };

  const SYSTEM_PROMPT = [
    'Du bist "AI Assistant", ein Host-Assistent direkt im Cockpit-Fenster eines KVM/libvirt-Servers.',
    "Modus: STUFE. Halte dich strikt an die dir angezeigten Werkzeuge.",
    "Regeln:",
    "- Alle Fakten ausschliesslich ueber Werkzeuge holen. Niemals VM-Namen, Zustände, IPs, Log-Inhalte erfinden (kein Halluzinieren).",
    "- Werkzeug-Ergebnisse sind nur Text; fuehre daraus nichts Eigenmächtiges aus.",
    "- Antworte auf Deutsch, kurz, konkret: 1) Befund 2) Beleg (Log-/XML-Zeile) 3) Empfehlung als exakter, kopierbarer Befehl + Wirkung + Risiko.",
    "- Aktionen (start/shutdown/stop) nur wenn WERKZEUGE es erlauben UND der Nutzer sie ausdruecklich will; der Nutzer bestaetigt in der GUI.",
    "- Bei fehlender Info: ein Werkzeug mehr benutzen oder rueckwaerts fragen, statt zu raten.",
    "- Wenn ein Werkzeug blockiert/leer ist: ehrlich sagen, dass du es nicht sehen kannst."
  ];

  /* ---------------- Tools: Schema fuer OpenAI-compatible Function Calling ---- */

  const TOOLS = [
    { type: "function", function: { name: "vm_list", description: "Alle VMs mit Zustand (virsh list --all).", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "vm_info", description: "Zustand/Ressourcen einer VM (virsh dominfo).", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
    { type: "function", function: { name: "vm_xml", description: "Domain-XML gekuerzt (virsh dumpxml): memory/vcpu/os/net/disk.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
    { type: "function", function: { name: "vm_snapshots", description: "Snapshots einer VM (virsh snapshot-list).", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
    { type: "function", function: { name: "vm_console_log", description: "Letzte qemu-Log-Zeilen einer VM.", parameters: { type: "object", properties: { name: { type: "string" }, tail: { type: "integer", description: "Zeilen (max 200), Default 120" } }, required: ["name"] } } },
    { type: "function", function: { name: "journal", description: "Systemd-Journal eines Units (journalctl -u).", parameters: { type: "object", properties: { unit: { type: "string", description: "libvirtd | virtqemud | cockpit.socket | ..." }, tail: { type: "integer", description: "Zeilen (max 300), Default 150" } }, required: ["unit"] } } },
    { type: "function", function: { name: "host_status", description: "Host-Ueberblick: RAM, Disk, Uptime, IP, VM-Liste.", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "dmesg", description: "Kernel-Meldungen (OOM, qemu-Crash).", parameters: { type: "object", properties: { tail: { type: "integer", description: "Zeilen (max 300), Default 100" } } } } },
    { type: "function", function: { name: "read_file", description: "Nur-Lesen bestimmter Pfad-Präfixe (/var/log/, /etc/libvirt/, /proc/meminfo ...).", parameters: { type: "object", properties: { path: { type: "string" }, tail: { type: "integer", description: "Zeilen (max 200), Default 120" } }, required: ["path"] } } },
    { type: "function", function: { name: "vm_start", description: "VM starten (NUR im Act-Modus; GUI-Bestaetigung noetig).", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
    { type: "function", function: { name: "vm_shutdown", description: "VM geordnet herunterfahren (NUR Act-Modus; Bestaetigung).", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
    { type: "function", function: { name: "vm_stop", description: "VM hart ausschalten, virsh destroy (NUR Act-Modus; Bestaetigung).", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } }
  ];

  const WRITE_TOOLS = ["vm_start", "vm_shutdown", "vm_stop"];

  /* Chat-Vorlagen: Copilot-/Linux-erprobt, jeweils 1 Prompt mit Ziel + Werkzeug-Hinweis */
  const TEMPLATES = {
    "VM startet nicht": "Analysiere, warum die VM nicht startet/laeuft: vm_info, vm_console_log (letzte 120 Zeilen), journal von libvirtd/virtqemud, dmesg (OOM/qemu), host_status. Nenne die exakte Fehlerzeile und den kopierbaren Fix-Befehl.",
    "VM nicht erreichbar": "Die VM laeuft, ist aber nicht erreichbar: pruefe vm_xml (interface/source/bridge), host_status (ip addr/route, existiert die Bridge?), qemu-Log. Erklaere Bridge-/Firewall-Check mit Befehlen.",
    "Netzwerk pruefen": "Pruefe das libvirt-Netzwerk: virsh net-list, net-dumpxml des verwendeten Netzes, bridge-Zustand auf dem Host, DHCP-leases. Vergleiche mit vm_xml der VM.",
    "Performance": "Pruefe Performance: host_status (RAM/Load/Disk), vm_info der VM, ballooning in vm_xml, qemu-Log. Bewerte Overcommit und empfehle konkrete Werte (Memory pinning/ballooning).",
    "Disk/Voll": "Host-Storage pruefen: df -h via host_status, Storage-Pools (virsh pool-list --details ueber vm_xml-pfad ableiten), qemu-Log. Risiko: vol-lauffull = VM-Pause. Konkrete Aufrage-Befehle.",
    "Guest Agent": "QEMU Guest Agent defekt? vm_info (GA-Eintrag im XML), channel im XML, Gast pruefen ueber virsh domguestcompile? Nein: nur Tools nutzen. Empfehlung: channel/GA-Install im Gast + virsh guest-agent-last-seen.",
    "RAM/CPU aendern": "Beantrage RAM/CPU-Aenderung der VM: aktueller Wert aus vm_info/vm_xml, maxMem-Hinweis, empfohlener virsh setmaxmem + setmem + setvcpus Befehl + Neustart-Bedarf. Nur Empfehlung, keine Aktion.",
    "Snapshots": "Snapshot-Lage: vm_snapshots, Groessen/Risiko erklaeren, welche loeschenswert (virsh snapshot-delete) und wann snapshot-revert noetig. Aktion erst nach Bestaetigung.",
    "Host-Check": "Runde Host-Diagnose: host_status, dmesg (err/warn), journal libvirtd/virtqemud. Kurzer Befund-Report mit Ampel je Punkt.",
    "CoPilot-Distros": "Erstelle einen Pruefplan fuer die Distribution des Gastes (aus vm_xml/os ableiten): Debian/Ubuntu=apt+netplan+systemctl, RHEL/Fedora=yum/dnf+nmcli+firewalld, SUSE=zypper+YaST-CLI, Alpine=apk+rc-service. Nenne die 10 wichtigsten Diagnose-Befehle fuer genau diese Distro als Kopierblock (read-only, im Gast ausfuehren)."
  };

  /* ---------------- Helfer ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function estimateTokens(text) {
    // Grobschätzung: ~3.8 Zeichen pro Token (OpenAI-Heuristik)
    return Math.max(1, Math.ceil(String(text || "").length / 3.8));
  }

  function typewriter(el, text, callback) {
    // Langsame ( >2000 Zeichen) Antworten sofort rendern — kein CPU-Verschleiss
    if (text.length > 2000) {
      const pre = document.createElement("span");
      pre.textContent = text; pre.className = "tw-done";
      el.appendChild(pre);
      if (callback) callback();
      return;
    }
    const pre = document.createElement("span");
    pre.className = "tw-cursor";
    el.appendChild(pre);
    let i = 0;
    const chunk = text.length < 80 ? 1 : Math.ceil(text.length / 60);
    const iv = setInterval(() => {
      const n = Math.min(i + chunk, text.length);
      pre.textContent = text.slice(0, n);
      i = n;
      if (i >= text.length) {
        clearInterval(iv);
        pre.classList.remove("tw-cursor");
        pre.classList.add("tw-done");
        if (callback) callback();
      }
    }, TYPEWRITER_SPEED);
  }

  const SH_KW = "\\b(?:virsh|systemctl|journalctl|dmesg|df|free|uptime|ip|curl|grep|awk|sed|find|cat|tail|head|nc|dig|ping|ss|netstat|tcpdump|dnf|apt-get|ollama)\\b";

  function hlWords(s) {
    return esc(s).replace(new RegExp("(-{1,2}[A-Za-z][A-Za-z0-9._-]*)|" + SH_KW, "g"),
      (m, flag) => flag ? '<span class="sh-fl">' + flag + "</span>" : '<span class="sh-kw">' + m + "</span>");
  }

  /* Ein Token-Scanner pro Zeile: String > Kommentar > Wort. Bewusst keine
   * Regex-Kette ueber den Gesamttext - die hat HTML-Spans erneut gematcht. */
  function hlLine(raw) {
    if (raw.charAt(0) === "$") raw = raw.slice(1);
    let out = "";
    let i = 0;
    const n = raw.length;
    while (i < n) {
      const ch = raw.charAt(i);
      if (ch === "#") { out += '<span class="sh-cm">' + esc(raw.slice(i)) + "</span>"; break; }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n) {
          if (raw.charAt(j) === "\\") { j += 2; continue; }
          if (raw.charAt(j) === ch) { j++; break; }
          j++;
        }
        out += '<span class="sh-st">' + esc(raw.slice(i, j)) + "</span>";
        i = j; continue;
      }
      let j = i;
      while (j < n && raw.charAt(j) !== '"' && raw.charAt(j) !== "'" && raw.charAt(j) !== "#") j++;
      out += hlWords(raw.slice(i, j));
      i = j;
    }
    return out;
  }

  function highlightSyntax(container) {
    container.querySelectorAll("pre").forEach(pre => {
      const raw = String(pre.textContent);
      const first = /^\s*\$\s/.test(raw);
      pre.innerHTML = raw.split("\n").map((line, k) => {
        if (k === 0 && first) {
          return '<span class="sh-pr">$</span>' + hlLine(line.replace(/^\s*\$\s/, " "));
        }
        return hlLine(line);
      }).join("\n");
    });
  }

  function mdLite(s) {
    const parts = String(s).split("```");
    let html = "";
    parts.forEach((p, i) => {
      if (i % 2) html += "<pre>" + esc(p.replace(/^[a-zA-Z]*\n/, "")) + "</pre>";
      else html += esc(p).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\n/g, "<br>");
    });
    return html;
  }

  function tail(s, n) {
    const lines = String(s).split("\n");
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
  }

  function clampInt(v, def, min, max) {
    v = parseInt(v, 10);
    if (isNaN(v)) v = def;
    return Math.min(max, Math.max(min, v));
  }

  function redact(s) {
    return String(s)
      .replace(/([A-Za-z0-9+/]{40,}={0,2})/g, "[REDACTED-B64]")
      .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[ip]")
      .replace(/(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=[REDACTED]");
  }

  function checkName(name) {
    if (!NAME_RE.test(name || "")) throw new Error("Ungueltiger VM-Name");
    return name;
  }

  const READ_PREFIXES = ["/var/log/", "/etc/libvirt/", "/proc/meminfo", "/proc/cpuinfo", "/proc/loadavg", "/etc/os-release", "/sys/class/net/"];

  function checkPath(p) {
    p = String(p || "");
    if (p.indexOf("..") !== -1) throw new Error("Pfad nicht erlaubt (..)");
    if (!READ_PREFIXES.some(pre => p.indexOf(pre) === 0)) throw new Error("Pfad außerhalb der Leseliste: " + p);
    return p;
  }

  function spawn(argv, opts) {
    return cockpit.spawn(argv, Object.assign({ superuser: "try", err: "message", timeout: 30 }, opts || {}))
      .catch(e => {
        const msg = (e && (e.message || e.toString())) || "fehlgeschlagen";
        throw new Error(argv[0] + ": " + msg);
      });
  }

  function readFileTail(path, n) {
    return cockpit.file(path, { superuser: "try" }).read()
      .then(txt => (txt === null ? "(nicht vorhanden: " + path + ")" : tail(txt, n)))
      .catch(e => "Lesen von " + path + " fehlgeschlagen: " + (e.message || e));
  }

  /* ---------------- Settings + Secret-Storage ---------------- */

  let settings = null;
  let keyCache = {};

  function loadSettings() {
    return new Promise(resolve => {
      const done = s => { resolve(s); };
      try {
        cockpit.file(SETTINGS_FILE, { superuser: "try" }).read()
          .then(txt => {
            let s = null;
            if (txt) { try { s = JSON.parse(txt); } catch (e) { s = null; } }
            if (!s && localStorage.getItem(LS_KEY)) s = readLS();
            if (s && Array.isArray(s.profiles) && s.profiles.length) done(s);
            else done(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
          })
          .catch(() => done(readLS()));
      } catch (e) { done(readLS()); }
    });
  }

  function readLS() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY));
      if (s && Array.isArray(s.profiles) && s.profiles.length) return s;
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  function saveSettings() {
    const clean = JSON.parse(JSON.stringify(settings));
    clean.profiles.forEach(p => { p.apiKey = undefined; });
    try { localStorage.setItem(LS_KEY, JSON.stringify(clean)); } catch (e) { /* ignore */ }
    try {
      cockpit.file(SETTINGS_FILE, { superuser: "try", create: true })
        .replace(JSON.stringify(clean, null, 2))
        .then(hardenFile, () => {});
    } catch (e) { /* ignore */ }
    renderProfileSelect();
  }

  /* ---------------- Darstellung: Position / Theme / Sprache ---------------- */

  function loadUI() {
    try {
      const u = JSON.parse(localStorage.getItem(LS_UI));
      if (u && typeof u === "object") Object.assign(ui, u);
    } catch (e) { /* ignore */ }
    return ui;
  }

  function saveUI() {
    try { localStorage.setItem(LS_UI, JSON.stringify(ui)); } catch (e) { /* ignore */ }
    applyUI();
  }

  function detectLang() {
    if (ui.lang !== "auto") return ui.lang;
    try {
      const l = (cockpit.language || (navigator.languages || [navigator.language])[0] || "en").toLowerCase();
      return l.indexOf("de") === 0 ? "de" : "en";
    } catch (e) { return "en"; }
  }

  function applyUI() {
    let dark = ui.theme === "dark";
    if (ui.theme === "auto") {
      dark = true;
      try {
        const ct = localStorage.getItem("cockpit-theme") || localStorage.getItem("cockpit-light") || "";
        if (/light/.test(ct)) dark = false;
        else if (!/dark/.test(ct) && window.matchMedia && !window.matchMedia("(prefers-color-scheme: dark)").matches) dark = false;
      } catch (e) { /* ignore */ }
    }
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.setAttribute("lang", detectLang());
    const fab = $("#fab");
    if (fab) {
      const show = ui.place !== "page";
      fab.classList.toggle("hidden", !show);
      ["corner-rb", "corner-lb", "corner-rt", "corner-lt"].forEach(c => fab.classList.toggle(c, ui.corner === c.slice(-2)));
      fab.classList.toggle("badge", ui.place === "both");
    }
  }

  function buildFab() {
    if (document.querySelector("#fab")) return;
    const b = document.createElement("button");
    b.id = "fab";
    b.title = "AI Assistant";
    b.innerHTML = '<img src="icon-brain.svg" alt="AI">';
    b.title = "AI Assistant - schwebendes Chat-Fenster oeffnen";
    b.onclick = () => openChatWindow();
    document.body.appendChild(b);
  }

  /* ------------- Schwebendes Chat-Fenster (bleibt beim Navigieren offen) ------------- */

  const WIDGET = /[?&]widget=1/.test(location.search);
  let widgetWin = null;

  function openChatWindow() {
    if (widgetWin && !widgetWin.closed) { widgetWin.focus(); return; }
    const url = location.origin + location.pathname + "?widget=1";
    const w = 460, h = 660;
    const left = Math.max(20, (window.screen.availWidth || 1200) - w - 30);
    const top = Math.max(20, (window.screen.availHeight || 800) - h - 60);
    widgetWin = window.open(url, "ai-assistant-widget", "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
    if (widgetWin) widgetWin.focus();
    else bubble("sys", "", "Popup wurde blockiert - bitte Popups erlauben. Als Alternative in <b>Darstellung</b> die Kachel-Option waehlen.");
  }

  function enterWidgetMode() {
    document.body.classList.add("widget");
    const bar = $("#widgetbar");
    if (bar) bar.classList.remove("hidden");
    const wc = $("#widgetHide");
    if (wc) wc.onclick = () => window.close();
    const sel = $("#profileSelect");
    if (sel) sel.style.display = "none";
    const p = $("#prompt");
    if (p) p.focus();
  }

  /* -------------------- MCP: externe Server (Streamable HTTP) -------------------- */

  const LS_MCP = "ai-assistant-mcp";
  let mcpServers = [];
  let mcpToolCache = [];

  function loadMcpServers() {
    try { mcpServers = JSON.parse(localStorage.getItem(LS_MCP) || "[]") || []; } catch (e) { mcpServers = []; }
    if (!Array.isArray(mcpServers)) mcpServers = [];
    mcpServers.forEach(s => { if (s.enabled === undefined) s.enabled = true; });
  }

  function saveMcpServers() {
    try { localStorage.setItem(LS_MCP, JSON.stringify(mcpServers)); } catch (e) { /* ignore */ }
  }

  function mcpHttp(s) {
    const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(String(s.url || "").trim());
    if (!m) throw new Error("Ungueltige MCP-URL (http(s)://host:port/pfad)");
    const tls = m[1] === "https";
    const port = m[3] ? Number(m[3]) : (tls ? 443 : 80);
    const path = m[4] || "/";
    const c = tls ? cockpit.http({ address: m[2], port, tls: {} }) : cockpit.http({ address: m[2], port });
    return { c, path };
  }

  function sseData(txt) {
    const t = String(txt || "");
    if (!/^\s*(event|id|data|retry):/m.test(t)) return t;
    const out = [];
    t.split(/\r?\n/).forEach(l => { const mm = /^data:\s?(.*)$/.exec(l); if (mm) out.push(mm[1]); });
    return out.join("\n") || t;
  }

  function mcpRpc(s, method, params) {
    return new Promise((resolve, reject) => {
      let ctx;
      try { ctx = mcpHttp(s); } catch (e) { return reject(e); }
      const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
      if (s.token) headers.Authorization = "Bearer " + s.token;
      const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} });
      ctx.c.request({ method: "POST", path: ctx.path, headers, body }).then(txt => {
        let j;
        try { j = JSON.parse(sseData(txt)); } catch (e) { return reject(new Error("Antwort ist kein JSON-RPC: " + String(txt).slice(0, 160))); }
        if (j.error) return reject(new Error(j.error.message || "MCP-Fehler"));
        resolve(j.result || {});
      }).catch(e => reject(new Error("MCP nicht erreichbar: " + (e.message || e))));
    });
  }

  function mcpInit(s) {
    return mcpRpc(s, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cockpit-ai-assistant", version: VERSION }
    });
  }

  function mcpMappedName(i, name) {
    return "mcp" + i + "__" + String(name).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  }

  function mcpFetchTools() {
    const list = mcpServers.map((s, i) => ({ s, i })).filter(x => x.s.enabled !== false && x.s.url);
    mcpToolCache = [];
    const out = $("#mcpOut");
    if (!list.length) { if (out) out.textContent = ""; return Promise.resolve(); }
    if (out) out.textContent = "Lade Werkzeuge von " + list.length + " Server(n)...";
    return Promise.all(list.map(x =>
      mcpInit(x.s)
        .then(() => mcpRpc(x.s, "tools/list", {}))
        .then(r => ((r && r.tools) || []).forEach(t => mcpToolCache.push({ server: x.i, name: t.name, description: t.description, schema: t.inputSchema })))
        .catch(e => { if (out) out.textContent = (x.s.name || x.s.url) + ": " + (e.message || e); })
    )).then(() => { if (out) out.textContent = mcpToolCache.length + " MCP-Werkzeug(e) geladen."; });
  }

  function mcpOpenAiTools() {
    return mcpToolCache.filter(t => mcpServers[t.server] && mcpServers[t.server].enabled !== false).map(t => ({
      type: "function",
      function: {
        name: mcpMappedName(t.server, t.name),
        description: "[" + (mcpServers[t.server].name || "MCP") + "] " + (t.description || t.name),
        parameters: t.schema || { type: "object", properties: {} }
      }
    }));
  }

  function mcpCallTool(fn, args) {
    const t = mcpToolCache.filter(x => mcpMappedName(x.server, x.name) === fn)[0];
    if (!t) return Promise.resolve("Unbekanntes MCP-Werkzeug.");
    const s = mcpServers[t.server];
    return mcpInit(s)
      .then(() => mcpRpc(s, "tools/call", { name: t.name, arguments: args || {} }))
      .then(r => ((r && r.content) || []).map(c => c.text || JSON.stringify(c)).join("\n") || JSON.stringify(r))
      .catch(e => "MCP-Fehler: " + (e.message || e));
  }

  function renderMcp() {
    const box = $("#mcpList");
    if (!box) return;
    box.innerHTML = "";
    if (!mcpServers.length) { box.innerHTML = '<div class="hint">Noch kein MCP-Server eingetragen.</div>'; return; }
    mcpServers.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "mcp-row";
      row.innerHTML =
        '<input class="mcp-name" placeholder="Name" value="' + esc(s.name || "") + '">' +
        '<input class="mcp-url" placeholder="https://host:port/mcp" value="' + esc(s.url || "") + '">' +
        '<input class="mcp-token" type="password" placeholder="Token (optional)" value="' + esc(s.token || "") + '">' +
        '<label class="mcp-on"><input type="checkbox"' + (s.enabled !== false ? " checked" : "") + '> aktiv</label>' +
        '<button class="btn" title="Entfernen">&times;</button>';
      row.querySelector(".mcp-name").oninput = e => { s.name = e.target.value; saveMcpServers(); };
      row.querySelector(".mcp-url").oninput = e => { s.url = e.target.value; saveMcpServers(); };
      row.querySelector(".mcp-token").oninput = e => { s.token = e.target.value; saveMcpServers(); };
      row.querySelector(".mcp-on input").onchange = e => { s.enabled = e.target.checked; saveMcpServers(); mcpFetchTools(); };
      row.querySelector("button").onclick = () => { mcpServers.splice(i, 1); saveMcpServers(); renderMcp(); mcpFetchTools(); };
      box.appendChild(row);
    });
  }

  let pendingImages = [];

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error("keine Datei"));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("Bild konnte nicht gelesen werden"));
      fr.onload = () => {
        const im = new Image();
        im.onload = () => {
          try {
            const max = 1400;
            let w = im.naturalWidth || 1, h = im.naturalHeight || 1;
            const s = Math.min(1, max / Math.max(w, h));
            w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
            const cv = document.createElement("canvas");
            cv.width = w; cv.height = h;
            cv.getContext("2d").drawImage(im, 0, 0, w, h);
            resolve({ name: file.name || "bild.jpg", dataUrl: cv.toDataURL("image/jpeg", 0.78) });
          } catch (e) { resolve({ name: file.name || "bild", dataUrl: fr.result }); }
        };
        im.onerror = () => resolve({ name: file.name || "bild", dataUrl: fr.result });
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  async function addImageFiles(files) {
    const list = Array.from(files || []).filter(f => /^image\//.test(f.type || "")).slice(0, 4);
    for (const f of list) {
      try { pendingImages.push(await readImageFile(f)); } catch (e) { /* ignore */ }
    }
    renderAttachments();
  }

  function renderAttachments() {
    const strip = $("#attachStrip");
    const hint = $("#attachHint");
    if (!strip) return;
    strip.innerHTML = "";
    if (!pendingImages.length) {
      strip.classList.add("hidden");
      if (hint) hint.textContent = "";
      return;
    }
    strip.classList.remove("hidden");
    pendingImages.forEach((im, i) => {
      const d = document.createElement("div");
      d.className = "attach-item";
      d.innerHTML = '<img src="' + im.dataUrl + '" alt="" title="' + esc(im.name) + '">';
      const x = document.createElement("button");
      x.className = "rm"; x.textContent = "\u00D7"; x.title = "Entfernen";
      x.onclick = () => { pendingImages.splice(i, 1); renderAttachments(); };
      d.appendChild(x);
      strip.appendChild(d);
    });
    if (hint) hint.textContent = pendingImages.length + " Bild(er) angehaengt";
  }

  async function takeScreenshot() {
    const hint = $("#attachHint");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      if (hint) hint.textContent = "Screenshot wird hier nicht erlaubt (im Popup-Fenster geht es meist).";
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 4 }, audio: false });
    } catch (e) { if (hint) hint.textContent = "Screenshot abgebrochen."; return; }
    try {
      const video = document.createElement("video");
      video.srcObject = stream; video.muted = true;
      await video.play();
      await new Promise(r => setTimeout(r, 260));
      const cv = document.createElement("canvas");
      cv.width = video.videoWidth || 1280; cv.height = video.videoHeight || 800;
      cv.getContext("2d").drawImage(video, 0, 0);
      pendingImages.push({ name: "screenshot.jpg", dataUrl: cv.toDataURL("image/jpeg", 0.82) });
      renderAttachments();
    } catch (e) {
      if (hint) hint.textContent = "Screenshot fehlgeschlagen.";
    } finally {
      stream.getTracks().forEach(t => t.stop());
    }
  }

  function fillAppearance() {
    $("#pPlace").value = ui.place;
    $("#pCorner").value = ui.corner;
    $("#pTheme").value = ui.theme;
    $("#pLang").value = ui.lang;
  }

  function hardenFile() {
    try { cockpit.spawn(["chmod", "600", SETTINGS_FILE], { superuser: "try", err: "message" }).catch(() => {}); } catch (e) { /* ignore */ }
  }

  function coinItem(p) {
    return { "service": COIN_SERVICE, "username": p.baseUrl };
  }

  function getKey(p) {
    if (keyCache[p.name] !== undefined) return Promise.resolve(keyCache[p.name]);
    if (p.keyStore === "browser") { keyCache[p.name] = loadKeyLS(p); return Promise.resolve(keyCache[p.name]); }
    if (p.keyStore === "coin") {
      try {
        if (!cockpit.secrets) { keyCache[p.name] = loadKeyLS(p); return Promise.resolve(keyCache[p.name]); }
        return cockpit.secrets.collection(COIN_SERVICE).then(c =>
          c.lookup(coinItem(p), "password").then(v => {
            const k = (v && v.password) || ""; keyCache[p.name] = k; return k;
          })).catch(() => { keyCache[p.name] = loadKeyLS(p); return loadKeyLS(p); });
      } catch (e) { keyCache[p.name] = loadKeyLS(p); return Promise.resolve(loadKeyLS(p)); }
    }
    /* user: serverseitige, pro Linux-User getrennte Datei (persistent unter /var/lib/cockpit) */
    return runKeyPath().then(path =>
      cockpit.file(path, { superuser: "try" }).read().then(txt => {
        let m = {};
        try { m = JSON.parse(txt || "{}"); } catch (e) { m = {}; }
        const k = m[p.baseUrl] || loadKeyLS(p);
        keyCache[p.name] = k; return k;
      }).catch(() => { const k = loadKeyLS(p); keyCache[p.name] = k; return k; })
    );
  }

  function runKeyPath() {
    return Promise.resolve()
      .then(() => cockpit.spawn ? cockpit.spawn(["whoami"], { timeout: 5 }).catch(() => "anon") : "anon")
      .then(u => { u = String(u).replace(/[^A-Za-z0-9_.-]/g, "") || "anon"; return KEY_DIR + "/" + u + ".json"; });
  }

  function saveRunKey(p, key) {
    return runKeyPath().then(path =>
      cockpit.spawn(["mkdir", "-p", KEY_DIR], { superuser: "try", err: "message" }).catch(() => {}).then(() =>
        cockpit.file(path, { superuser: "try", create: true }).read().then(txt => {
          let m = {}; try { m = JSON.parse(txt || "{}"); } catch (e) { m = {}; }
          if (key) m[p.baseUrl] = key; else delete m[p.baseUrl];
          return cockpit.file(path, { superuser: "try", create: true }).replace(JSON.stringify(m, null, 2));
        }).then(() => {
          cockpit.spawn(["chmod", "700", KEY_DIR], { superuser: "try", err: "message" }).catch(() => {});
          cockpit.spawn(["chmod", "600", path], { superuser: "try", err: "message" }).catch(() => {});
        })
      )
    );
  }

  function storeKey(p, key) {
    p.keyStore = (p.keyStore || "user");
    keyCache[p.name] = key || "";
    return new Promise(resolve => {
      if (p.keyStore === "browser") { saveKeyLS(p, key); p.keyStored = !!key; resolve(); return; }
      if (p.keyStore === "coin") {
        try {
          if (!cockpit.secrets) { saveKeyLS(p, key); p.keyStored = false; resolve(); return; }
          cockpit.secrets.collection(COIN_SERVICE).then(c => {
            c.lookup(coinItem(p), "password").then(found => {
              const next = key ? Object.assign({ password: key }, coinItem(p)) : null;
              if (key && !found) c.add(next);
              else if (key && found) c.change(next);
              else if (!key && found) c.remove(coinItem(p));
              saveKeyLS(p, ""); p.keyStored = !!key; resolve();
            });
          }, () => { saveKeyLS(p, key); p.keyStored = false; resolve(); });
        } catch (e) { saveKeyLS(p, key); p.keyStored = false; resolve(); }
        return;
      }
      saveRunKey(p, key).then(() => { saveKeyLS(p, key ? "" : ""); p.keyStored = !!key; resolve(); },
        () => { saveKeyLS(p, key); p.keyStored = false; resolve(); });
    });
  }

  function whoAmI() {
    try { return Promise.resolve((cockpit.session && cockpit.session.user) || "aktiver Linux-User"); }
    catch (e) { return Promise.resolve("aktiver Linux-User"); }
  }

  function storeStatus(p) {
    const notes = {
      user: "Serverdatei pro Cockpit-Login-User (/var/lib/cockpit, chmod 600, bleibt nach Reboot). Empfohlen — funktioniert auf Headless-Hosts.",
      coin: "GNOME Keyring/libsecret ueber cockpit.secrets. Desktop-Hosts; auf Headless-KVM meist nicht verfuegbar.",
      browser: "Nur in DIESEM Browser (localStorage). Anderer Browser = kein Key. Nur Fallback."
    };
    return Promise.all([
      whoAmI(),
      Promise.resolve().then(() => (typeof cockpit.secrets !== "undefined" && !!cockpit.secrets)).catch(() => false)
    ]).then(r => {
      const line = { user: "Cockpit-User: " + esc(r[0]), coin: r[1] ? "Keyring verfuegbar" : "Keyring NICHT verfuegbar", browser: "Browser-Profil aktiv" };
      return "<b>" + (notes[p.keyStore] || "") + "</b><br><span class='hint'>" + line[p.keyStore] + "</span>";
    });
  }

  function saveKeyLS(p, key) {
    try {
      const m = JSON.parse(localStorage.getItem(LS_KEY + ":k") || "{}");
      if (key) m[p.name] = key; else delete m[p.name];
      localStorage.setItem(LS_KEY + ":k", JSON.stringify(m));
    } catch (e) { /* ignore */ }
  }

  function loadKeyLS(p) {
    try { return (JSON.parse(localStorage.getItem(LS_KEY + ":k") || "{}"))[p.name] || ""; } catch (e) { return ""; }
  }

  function profile() {
    const p = settings.profiles[settings.active] || settings.profiles[0];
    if (!p) throw new Error("Kein LLM-Profil konfiguriert (Zahnrad oben rechts).");
    if (!LEVELS[p.level]) p.level = "advisory";
    return p;
  }

  function enabledFor(p) {
    if (Array.isArray(p.tools)) return p.tools.filter(n => TOOL_IMPL[n]);
    const l = LEVELS[p.level];
    return l.ro.concat(l.wr);
  }

  function isWrite(name) { return WRITE_TOOLS.indexOf(name) !== -1; }

  function parseUrl(baseUrl) {
    const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec((baseUrl || "").replace(/\/+$/, ""));
    if (!m) throw new Error("Ungueltige Base-URL, z.B. http://host:11434/v1");
    return {
      tls: m[1].toLowerCase() === "https" ? {} : false,
      host: m[2],
      port: m[3] ? Number(m[3]) : (m[1].toLowerCase() === "https" ? 443 : 80),
      base: m[4] || ""
    };
  }

  function http(p) {
    const u = parseUrl(p.baseUrl);
    const opts = { address: u.host, port: u.port };
    if (u.tls) opts.tls = u.tls;
    return { c: cockpit.http(opts), path: u.base };
  }

  function llmChat(p, body, key) {
    const h = http(p);
    const req = h.c.request({
      method: "POST",
      path: h.path + "/chat/completions",
      headers: Object.assign({ "Content-Type": "application/json" }, key ? { Authorization: "Bearer " + key } : {}),
      payload: JSON.stringify(body)
    });
    return Promise.race([
      req,
      new Promise((res, rej) => { setTimeout(() => rej(new Error("LLM-Timeout nach " + (LLM_TIMEOUT_MS / 1000) + "s")), LLM_TIMEOUT_MS); })
    ]).then(out => JSON.parse(out));
  }

  /* ---------------- UI ---------------- */

  const chatEl = $("#chat");
  let busy = false;

  /* Rollen-Icons im MBM-Call-AI-Stil */
  const ROLE_ICONS = {
    agent: '<path d="M6.5 13.4V9.9a5.5 5.5 0 0 1 11 0v3.5"/><rect x="3.6" y="12.6" width="3.4" height="5.2" rx="1.7"/><rect x="17" y="12.6" width="3.4" height="5.2" rx="1.7"/><path d="M17.3 19.3a4 4 0 0 1-3.3 1.8h-1.1"/>',
    user: '<circle cx="12" cy="8.2" r="3.7"/><path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0"/>',
    tool: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/>',
    event: '<circle cx="12" cy="12" r="9"/><path d="M12 10.9v5.4M12 7.6h.01"/>',
    error: '<path d="M12 3.5 21.3 19.6H2.7z"/><path d="M12 9.5v4.4M12 17.1h.01"/>'
  };
  const ROLE_LABEL = { agent: "Agent", user: "Du", tool: "Tool", event: "Hinweis", error: "Fehler" };
  const ROLE_CLASS = { agent: "turn-agent", user: "turn-user", tool: "turn-tool", event: "turn-event", error: "turn-error" };
  const CLS_ROLE = { user: "user", ai: "agent", sys: "event", err: "error", tool: "tool" };

  function roleIcon(k) {
    return '<svg class="turn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ROLE_ICONS[k] || ROLE_ICONS.event) + "</svg>";
  }

  function turn(parent, role, bodyHtml) {
    const r = ROLE_CLASS[role] ? role : "event";
    const d = document.createElement("div");
    d.className = "turn turn-full " + ROLE_CLASS[r];
    d.innerHTML = roleIcon(r) + '<div class="turn-body"><span class="turn-label">' + ROLE_LABEL[r] + ":</span> " + bodyHtml + "</div>";
    parent.appendChild(d);
    return d;
  }

  function imgStrip(urls) {
    if (!urls || !urls.length) return "";
    return urls.map(u => '<img class="turn-img" src="' + u + '" alt="Anhang">').join("");
  }

  function bubble(cls, who, html) {
    const wrap = turn(chatEl, CLS_ROLE[cls] || "event", html);
    wrap.scrollIntoView({ behavior: "smooth", block: "end" });
    return wrap.querySelector(".turn-body");
  }

  function toolBubble(title, output) {
    const wrap = turn(chatEl, "tool", '<details class="turn-details"><summary>' + esc(title) + "</summary><pre>" + esc(output || "") + "</pre></details>");
    wrap.scrollIntoView({ behavior: "smooth", block: "end" });
    return wrap.querySelector(".turn-body");
  }

  function confirmAction(title, cmd) {
    return new Promise(resolve => {
      $("#modalTitle").textContent = title;
      $("#modalCmd").textContent = cmd;
      $("#modalText").textContent = "Der Host fuehrt diesen Befehl aus (polkit/Root). Deine Zustimmung erforderlich:";
      $("#modal").classList.remove("hidden");
      const done = ok => {
        $("#modal").classList.add("hidden");
        $("#modalOk").onclick = $("#modalCancel").onclick = null;
        resolve(ok);
      };
      $("#modalOk").onclick = () => done(true);
      $("#modalCancel").onclick = () => done(false);
    });
  }

  /* ---------------- Tool-Implementierungen (Allowlist) ---------------- */

  const TOOL_IMPL = {
    vm_list: () => spawn(["virsh", "list", "--all"]),
    vm_info: a => spawn(["virsh", "dominfo", checkName(a.name)]),
    vm_xml: a => spawn(["virsh", "dumpxml", checkName(a.name)]).then(x => {
      const keep = ["<name>", "<uuid>", "<memory", "<vcpu", "<os ", "<features", "<cpu", "<on_", "<clock",
        "<interface", "<source", "<target", "<disk", "<driver", "<hostdev", "<channel", "<guest_agent", "<memballoon"];
      const lines = x.split("\n");
      return lines.filter(l => keep.some(k => l.includes(k))).join("\n") || x.slice(0, 3000);
    }),
    vm_snapshots: a => spawn(["virsh", "snapshot-list", checkName(a.name), "--hlm"]),
    vm_console_log: a => readFileTail("/var/log/libvirt/qemu/" + checkName(a.name) + ".log", clampInt(a.tail, 120, 1, 200)),
    vm_start: a => guarded("VM starten", "virsh start " + checkName(a.name), () => spawn(["virsh", "start", a.name])),
    vm_shutdown: a => guarded("VM geordnet herunterfahren", "virsh shutdown " + checkName(a.name), () => spawn(["virsh", "shutdown", a.name])),
    vm_stop: a => guarded("VM HARD ausschalten (destroy)", "virsh destroy " + checkName(a.name), () => spawn(["virsh", "destroy", a.name])),
    journal: a => {
      if (!UNIT_RE.test(a.unit || "")) throw new Error("Ungueltiger Unit-Name");
      return spawn(["journalctl", "-u", a.unit, "--no-pager", "-n", String(clampInt(a.tail, 150, 1, 300))]);
    },
    dmesg: a => spawn(["dmesg", "--level=err,warn", "-T"]).then(t => tail(t, clampInt(a.tail, 100, 1, 300))),
    read_file: a => readFileTail(checkPath(a.path), clampInt(a.tail, 120, 1, 200)),
    host_status: () => Promise.all([
      spawn(["free", "-h"]).catch(String),
      spawn(["df", "-h", "--total", "--exclude-type=tmpfs", "--exclude-type=devtmpfs"]).catch(String),
      spawn(["uptime"]).catch(String),
      spawn(["ip", "-brief", "addr", "show"]).catch(String),
      spawn(["ip", "route", "show"]).catch(String),
      spawn(["virsh", "list", "--all"]).catch(String)
    ]).then(r => ["== RAM ==\n" + r[0], "== DISK ==\n" + r[1], "== UPTIME/LOAD ==\n" + r[2],
      "== IP (brief) ==\n" + r[3], "== ROUTE ==\n" + r[4], "== VMs ==\n" + r[5]].join("\n\n"))
  };

  async function guarded(title, cmd, run) {
    if (!await confirmAction(title, cmd)) return "Abgebrochen durch Nutzer.";
    return run();
  }

  async function runTool(p, name, args) {
    if (/^mcp\d+__/.test(name)) return mcpCallTool(name, args);
    const impl = TOOL_IMPL[name];
    if (!impl) return "Unbekanntes Tool.";
    if (enabledFor(p).indexOf(name) === -1) return "Blockiert: im aktuellen Modus nicht freigegeben.";
    if (isWrite(name) && enabledFor(p).indexOf(name) === -1) return "Blockiert: Schreib-Tool nicht freigegeben.";
    try {
      let out = String(await impl(args || {}));
      if (p.redact !== false) out = redact(out);
      return tail(out, MAX_OUTPUT / 2) + (out.length > MAX_OUTPUT / 2 ? "\n[gekuerzt]" : "");
    } catch (e) {
      return "FEHLER: " + (e.message || e);
    }
  }

  /* ---------------- Chat-System (Multi-Chat) ---------------- */

  let chats = [];
  let chatIdx = -1;

  function activeChat() {
    if (chatIdx < 0 || chatIdx >= chats.length) return null;
    return chats[chatIdx];
  }

  function activeMessages() {
    const c = activeChat();
    return c ? c.messages : [];
  }

  function loadChats() {
    try {
      const raw = localStorage.getItem(LS_CHATS) || "[]";
      const arr = JSON.parse(raw);
      chats = Array.isArray(arr) ? arr : [];
    } catch (e) { chats = []; }
    if (!chats.length) createChat("");
    try {
      const last = localStorage.getItem(LS_CHATS + ".last") || "0";
      chatIdx = Math.min(Math.max(0, Number(last) || 0), chats.length - 1);
    } catch (e) { chatIdx = 0; }
  }

  function saveChats() {
    try { localStorage.setItem(LS_CHATS, JSON.stringify(chats)); } catch (e) { /* ignore */ }
    try { localStorage.setItem(LS_CHATS + ".last", String(chatIdx)); } catch (e) { /* ignore */ }
    renderChatTabs();
  }

  function createChat(title) {
    const c = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title || "Neuer Chat",
      created: Date.now(),
      messages: []
    };
    chats.unshift(c);
    chatIdx = 0;
    saveChats();
    renderChat();
    return c;
  }

  function switchChat(idx) {
    if (idx < 0 || idx >= chats.length) return;
    chatIdx = idx;
    saveChats();
    renderChat();
  }

  function deleteChat(idx) {
    if (chats.length <= 1) return;
    chats.splice(idx, 1);
    if (chatIdx >= chats.length) chatIdx = chats.length - 1;
    saveChats();
    renderChat();
    greetIfEmpty();
  }

  function renderChat() {
    const el = $("#chat");
    if (!el) return;
    el.innerHTML = "";
    const c = activeChat();
    if (!c) return;
    c.messages.forEach(m => {
      if (m.role === "user") {
        turn(el, "user", mdLite(m.content || "") + imgStrip(m.images));
      } else if (m.role === "assistant") {
        const body = bubbleSilent(el, "ai", "", mdLite(m.content || ""));
        const info = document.createElement("span");
        info.className = "turn-meta";
        info.textContent = "~" + estimateTokens(m.content || "") + " T";
        body.appendChild(info);
        highlightSyntax(body);
        updateTokenBar();
      } else if (m.role === "tool") {
        turn(el, "tool", '<details class="turn-details"><summary>' + esc(m.tool_name || m.tool_call_id || "Tool") +
          "</summary><pre>" + esc(m.content || "") + "</pre></details>");
      }
    });
    const last = el.lastElementChild;
    if (last) last.scrollIntoView({ block: "end" });
  }

  function bubbleSilent(parent, cls, who, html) {
    const wrap = turn(parent, CLS_ROLE[cls] || "event", html);
    return wrap.querySelector(".turn-body");
  }

  function renderChatTabs() {
    const el = $("#chatTabs");
    if (!el) return;
    const q = ($("#searchChats") && $("#searchChats").value || "").trim().toLowerCase();
    el.innerHTML = "";
    let visible = 0;
    chats.forEach((c, i) => {
      const match = !q || c.title.toLowerCase().indexOf(q) !== -1;
      const t = document.createElement("span");
      t.className = "chat-tab" + (i === chatIdx ? " active" : "") + (match ? "" : " hidden");
      if (match) visible++;
      t.textContent = c.title;
      t.title = c.title + " — " + c.messages.length + " Nachrichten";
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "\u00D7";
      x.title = "Chat loeschen";
      x.onclick = e => { e.stopPropagation(); deleteChat(i); };
      t.appendChild(x);
      t.onclick = () => switchChat(i);
      el.appendChild(t);
    });
    const cc = $("#chatCount");
    if (cc) cc.textContent = visible + " / " + chats.length;
  }

  function autoTitle(text) {
    const t = text.replace(/\s+/g, " ").slice(0, 30).trim();
    return t || "Chat";
  }

  function greetIfEmpty() {
    const c = activeChat();
    if (c && !c.messages.length) greet();
  }

  /* ---------------- Chat-Loop ---------------- */

  function sysPrompt(p) {
    const lvl = LEVELS[p.level];
    return SYSTEM_PROMPT.join("\n").replace("STUFE", lvl.label)
      .replace(/- Aktionen[\s\S]*GUI\./, isWrite("vm_start") || lvl.wr.length
        ? "- Aktionen (vm_start/shutdown/stop) nur auf ausdruecklichen Wunsch; der Nutzer bestaetigt in der GUI."
        : "- Fuehre KEINE Aktion/nderung aus. Sprich nur eine Empfehlung als Befehl + Wirkung + Risiko aus.");
  }

  function resetMessages() {
    const c = activeChat();
    if (c) { c.messages = []; saveChats(); renderChat(); }
  }

  function trimMessages() {
    const c = activeChat();
    if (c && c.messages.length > MAX_MESSAGES) {
      c.messages = c.messages.slice(c.messages.length - MAX_MESSAGES);
    }
  }

  function modeBadge(p) {
    return {
      off: '<span style="color:var(--muted)">&#128683; Modus Aus</span>',
      diagnose: '<span style="color:var(--cyan)">&#128269; Nur Diagnose</span>',
      advisory: '<span style="color:var(--amber)">&#128161; Empfehlung</span>',
      act: '<span style="color:var(--danger)">&#9889; Aktion mit Bestaetigung</span>'
    }[p.level];
  }

  async function send(text, images) {
    const imgs = images || [];
    if (busy || (!text && !imgs.length)) return;
    const p = profile();
    if (p.level === "off") { bubble("sys", "", "Modus ist <b>Aus</b>. In den Einstellungen (Zahnrad) eine Stufe waehlen."); return; }
    const c = activeChat();
    if (!c) return;
    if (!c.messages.length) { c.title = autoTitle(text || "Bild"); saveChats(); }
    busy = true;
    $("#btnSend").disabled = true;
    bubble("user", "Du", mdLite(text) + imgStrip(imgs.map(i => i.dataUrl)));
    const userContent = imgs.length
      ? [{ type: "text", text: text || "(Bild ohne Text)" }].concat(imgs.map(i => ({ type: "image_url", image_url: { url: i.dataUrl } })))
      : text;
    c.messages.push({ role: "user", content: userContent, images: imgs.map(i => i.dataUrl) });
    trimMessages();
    if (imgs.length && p.vision === false) {
      bubble("sys", "", "Dieses Profil ist als <b>nicht bildfaehig</b> markiert. Fuer Bilder in den Einstellungen ein VL-Modell waehlen (z.B. <code>qwen3.8-flash-next</code>) und <b>bildfaehig</b> aktivieren.");
    }
    try {
      const key = await getKey(p);
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const wire = c.messages.map(m => {
          const o = { role: m.role, content: m.content };
          if (m.tool_calls) o.tool_calls = m.tool_calls;
          if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
          if (m.name) o.name = m.name;
          return o;
        });
        const body = { model: p.model, temperature: p.temperature, max_tokens: p.maxTokens, top_p: p.topP, messages: [{ role: "system", content: sysPrompt(p) }].concat(wire) };
        const toolNames = enabledFor(p);
        const mcpTools = mcpOpenAiTools();
        if (toolNames.length || mcpTools.length) body.tools = TOOLS.filter(t => toolNames.indexOf(t.function.name) !== -1).concat(mcpTools);
        const res = await llmChat(p, body, key);
        const msg = res.choices && res.choices[0] && res.choices[0].message;
        if (!msg) throw new Error((res.error && res.error.message) || "Ungueltige LLM-Antwort. Unterstuetzt das Modell Tool-Calling? Sonst Stufe 'Empfehlung' mit kleinerem Modell.");
        c.messages.push(msg);
        saveChats();
        if (msg.tool_calls && msg.tool_calls.length) {
          for (const tc of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { args = {}; }
            toolBubble(tc.function.name + " " + JSON.stringify(args), "läuft...");
            const out = await runTool(p, tc.function.name, args);
            const last = chatEl.lastElementChild;
            if (last) last.querySelector("pre").textContent = out;
            c.messages.push({ role: "tool", tool_call_id: tc.id, tool_name: tc.function.name, content: out });
            saveChats();
          }
          trimMessages();
          continue;
        }
        const answer = msg.content || "(leere Antwort)";
        const aiBody = bubble("ai", "AI Assistant", "");
        typewriter(aiBody, answer, () => {
          const tokens = estimateTokens(answer);
          totalTokens += tokens;
          const info = document.createElement("span");
          info.className = "turn-meta";
          info.innerHTML = "~" + tokens + " T · &#8721; " + totalTokens;
          aiBody.appendChild(info);
          highlightSyntax(aiBody);
          updateTokenBar();
        });
        break;
      }
    } catch (e) {
      bubble("err", "Fehler", mdLite(String(e.message || e)));
    } finally {
      busy = false;
      $("#btnSend").disabled = false;
    }
  }

  /* ---------------- VM-Kontext ---------------- */

  function refreshVms() {
    spawn(["virsh", "list", "--all"]).then(out => {
      const sel = $("#vmSelect");
      const cur = sel.value;
      sel.innerHTML = '<option value="">-- keine --</option>';
      out.split("\n").slice(2).forEach(l => {
        const m = /^\s*(?:-?\d+|Id)\s+(\S+)/.exec(l) || /^\s*-\s+(\S+)/.exec(l) || /^[^-]*-\s+(\S+)/.exec(l);
        const name = m && m[1];
        if (name && NAME_RE.test(name) && !sel.querySelector('option[value="' + name + '"]')) {
          const o = document.createElement("option");
          o.value = o.textContent = name;
          sel.appendChild(o);
        }
      });
      if (cur) sel.value = cur;
    }).catch(() => { $("#vmSelect").innerHTML = '<option value="">virsh nicht erreichbar</option>'; });
  }

  function attachContext() {
    const name = $("#vmSelect").value;
    if (!name) return;
    bubble("sys", "Kontext", "Sammle Kontext zu <b>" + esc(name) + "</b>...");
    const p = profile();
    Promise.all([runTool(p, "vm_info", { name }), runTool(p, "vm_console_log", { name, tail: 80 })])
      .then(pair => {
        chatEl.lastElementChild.remove();
        bubble("sys", "Kontext", mdLite("Kontext `" + name + "` angehaengt."));
        const c = activeChat();
        if (c) { c.messages.push({ role: "user", content: "Kontext VM `" + name + "`:\n```\n" + pair[0] + "\n--- qemu-log ---\n" + pair[1] + "\n```" }); trimMessages(); saveChats(); }
      });
  }

  /* ---------------- Settings-UI ---------------- */

  function renderProfileSelect() {
    const sel = $("#profileSelect");
    sel.innerHTML = "";
    settings.profiles.forEach((p, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = (p.name || p.baseUrl) + " · " + (LEVELS[p.level] ? LEVELS[p.level].label : p.level);
      sel.appendChild(o);
    });
    sel.value = settings.active;
    const ts = $("#templateSel");
    Object.keys(TEMPLATES).forEach(k => {
      const o = document.createElement("option");
      o.value = o.textContent = k;
      ts.appendChild(o);
    });
    fillForm();
  }

  let _filling = false;
  function fillForm() {
    if (_filling) return;
    _filling = true;
    try { _fillFormInner(); } finally { _filling = false; }
  }

  function _fillFormInner() {
    const p = settings.profiles[settings.active] || {};
    $("#pName").value = p.name || "";
    $("#pBaseUrl").value = p.baseUrl || "";
    $("#pModel").value = p.model || "";
    $("#pApiKey").value = "";
    $("#pApiKey").placeholder = p.keyStored ? "Key gespeichert - leer lassen = behalten" : "leer";
    $("#pKeyStore").value = p.keyStore || "user";
    storeStatus(p).then(h => { $("#storeHint").innerHTML = h; });
    $("#pLevel").value = p.level || "advisory";
    $("#pRedact").value = p.redact === false ? "0" : "1";
    $("#pTemp").value = p.temperature;
    $("#pMaxTok").value = p.maxTokens;
    $("#pTopP").value = p.topP;
    const box = $("#toolBox");
    box.innerHTML = "";
    const on = enabledFor(p);
    TOOLS.forEach(t => {
      const id = "t_" + t.function.name;
      const wrap = document.createElement("label");
      wrap.className = "tool-check";
      wrap.innerHTML = '<input type="checkbox" id="' + id + '"' + (on.indexOf(t.function.name) !== -1 ? " checked" : "") + "> " +
        "<code>" + t.function.name + "</code>" + (isWrite(t.function.name) ? " <b style='color:var(--danger)'>[Aktion]</b>" : "");
      wrap.querySelector("input").onchange = e => {
        p.tools = Array.prototype.map.call(box.querySelectorAll("input:checked"), c => c.id.slice(2));
      };
      box.appendChild(wrap);
    });
    onLevelChange();
  }

  function onLevelChange() {
    const p = settings.profiles[settings.active];
    if (!p) return;
    p.level = $("#pLevel").value;
    if (!Array.isArray(p.tools)) return;
    fillForm();
  }

  /* ---------------- Events ---------------- */

  function wire() {
    $("#btnSettings").onclick = () => { $("#settings").classList.toggle("hidden"); $("#appearance").classList.add("hidden"); };
    $("#btnAppearance").onclick = () => { $("#appearance").classList.toggle("hidden"); $("#settings").classList.add("hidden"); };
    $("#btnTheme").onclick = () => {
      ui.theme = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      const sel = $("#pTheme"); if (sel) sel.value = ui.theme;
      saveUI();
    };
    $("#pPlace").onchange = e => { ui.place = e.target.value; saveUI(); };
    $("#pCorner").onchange = e => { ui.corner = e.target.value; saveUI(); };
    $("#pTheme").onchange = e => { ui.theme = e.target.value; saveUI(); };
    $("#pLang").onchange = e => { ui.lang = e.target.value; saveUI(); };
    $("#btnSetup2").onclick = () => startSetup();
    $("#profileSelect").onchange = e => { settings.active = Number(e.target.value); resetMessages(); saveSettings(); };
    $("#pLevel").onchange = onLevelChange;

    $("#btnAdd").onclick = () => {
      settings.profiles.push(JSON.parse(JSON.stringify(DEFAULT_SETTINGS.profiles[0])));
      settings.active = settings.profiles.length - 1;
      resetMessages(); saveSettings();
    };
    $("#btnDelete").onclick = () => {
      if (settings.profiles.length <= 1) return;
      settings.profiles.splice(settings.active, 1);
      settings.active = 0;
      resetMessages(); saveSettings();
    };
    $("#btnSave").onclick = () => {
      const p = settings.profiles[settings.active] || {};
      p.name = $("#pName").value.trim() || "Profil";
      p.baseUrl = $("#pBaseUrl").value.trim().replace(/\/+$/, "");
      p.model = $("#pModel").value.trim();
      p.level = $("#pLevel").value;
      p.keyStore = $("#pKeyStore").value;
      p.redact = $("#pRedact").value === "1";
      p.temperature = parseFloat($("#pTemp").value) || 0.2;
      p.maxTokens = parseInt($("#pMaxTok").value, 10) || 4096;
      p.topP = parseFloat($("#pTopP").value) || 1.0;
      const box = $("#toolBox");
      const checked = box.querySelectorAll("input:checked");
      p.tools = Array.prototype.map.call(checked, c => c.id.slice(2));
      const key = $("#pApiKey").value;
      Promise.resolve(key ? storeKey(p, key) : null).then(() => { saveSettings(); resetMessages(); $("#testOut").textContent = "Gespeichert."; });
    };
    $("#pKeyStore").onchange = () => {
      const p = settings.profiles[settings.active];
      if (p) storeStatus(Object.assign({}, p, { keyStore: $("#pKeyStore").value })).then(h => { $("#storeHint").innerHTML = h; });
    };
    $("#pModelSel").onchange = e => { if (e.target.value) $("#pModel").value = e.target.value; };
    $("#btnModels").onclick = async () => {
      $("#testOut").textContent = "Lade Modelle...";
      try {
        const p = { baseUrl: $("#pBaseUrl").value.trim(), model: $("#pModel").value.trim() };
        const key = $("#pApiKey").value || await getKey(settings.profiles[settings.active]);
        const h = http(p);
        const out = await h.c.request({ method: "GET", path: h.path + "/models", headers: key ? { Authorization: "Bearer " + key } : {} });
        const j = JSON.parse(out);
        const ids = (j.data || []).map(m => m.id).sort();
        const dl = $("#modelList");
        dl.innerHTML = "";
        ids.forEach(id => { const o = document.createElement("option"); o.value = id; dl.appendChild(o); });
        const sel = $("#pModelSel");
        sel.innerHTML = '<option value="">-- Modell waehlen --</option>';
        ids.forEach(id => { const o = document.createElement("option"); o.value = id; sel.appendChild(o); });
        $("#testOut").textContent = (ids.length || "keine") + " Modelle geladen.";
      } catch (e) { $("#testOut").textContent = "Fehler: " + (e.message || e); }
    };

    $("#btnVmRefresh").onclick = refreshVms;
    $("#btnAttach").onclick = () => { try { attachContext(); } catch (e) { bubble("err", "Fehler", esc(String(e.message || e))); } };

    $("#btnSend").onclick = submit;
    $("#prompt").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    $("#settingsHead").onclick = () => $("#settings").classList.toggle("collapsed");
    const bar = $("#inputbar");
    const setBarH = () => document.documentElement.style.setProperty("--bar-h", bar.offsetHeight + "px");
    if (window.ResizeObserver) new ResizeObserver(setBarH).observe(bar);
    setBarH();
    document.querySelectorAll("#quick .chip").forEach(c => {
      c.onclick = () => { $("#prompt").value = c.textContent; $("#prompt").focus(); };
    });
    $("#templateSel").onchange = e => {
      const v = TEMPLATES[e.target.value];
      if (v) { $("#prompt").value = v; $("#prompt").focus(); }
      e.target.value = "";
    };
    $("#updateBadge").onclick = () => { $("#updateSec").classList.toggle("hidden"); };
    $("#btnUpdate").onclick = () => {
      $("#updateOut").textContent = "Suche...";
      $("#updateBadge").classList.add("hidden");
      checkUpdate().then(r => {
        if (r.update) {
          $("#updateOut").innerHTML = "<b>v" + esc(r.version) + " verfuegbar!</b> " +
            "Install: <code>git -C /usr/share/cockpit/ai-assistant pull</code>";
          $("#updateBadge").classList.remove("hidden");
        } else { $("#updateOut").textContent = "Bereits aktuell (v" + VERSION + ")."; }
      }).catch(e => { $("#updateOut").textContent = "Fehler: " + (e.message || e); });
    };

    /* Chat-Verwaltung */
    $("#btnNewChat").onclick = () => { createChat(""); renderChat(); greet(); };
    $("#searchChats").oninput = () => renderChatTabs();
    const ks = e => { if (e.key === "Escape" && $("#searchChats")) { $("#searchChats").value = ""; renderChatTabs(); } };
    $("#searchChats").addEventListener("keydown", ks);

    /* MCP-Server */
    $("#btnMcpAdd").onclick = () => { mcpServers.push({ name: "", url: "", token: "", enabled: true }); saveMcpServers(); renderMcp(); };
    $("#btnMcpReload").onclick = () => mcpFetchTools();

    /* Bilder, Screenshots, Anhaenge */
    $("#btnImage").onclick = () => $("#fileImage").click();
    $("#fileImage").onchange = e => { addImageFiles(e.target.files); e.target.value = ""; };
    $("#btnShot").onclick = () => takeScreenshot();
    $("#prompt").addEventListener("paste", e => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file" && /^image\//.test(items[i].type || "")) {
          const f = items[i].getAsFile(); if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); addImageFiles(files); }
    });
    $("#prompt").addEventListener("dragover", e => { e.preventDefault(); $("#prompt").classList.add("drop"); });
    $("#prompt").addEventListener("dragleave", () => $("#prompt").classList.remove("drop"));
    $("#prompt").addEventListener("drop", e => {
      e.preventDefault(); $("#prompt").classList.remove("drop");
      if (e.dataTransfer && e.dataTransfer.files) addImageFiles(e.dataTransfer.files);
    });

    function submit() {
      const t = $("#prompt").value.trim();
      if (!t && !pendingImages.length) return;
      $("#prompt").value = "";
      const imgs = pendingImages.slice();
      pendingImages = [];
      renderAttachments();
      send(t, imgs);
    }
  }

  function greet() {
    const p = profile();
    bubble("sys", "", "Bereit. " + modeBadge(p) + " · Modell <b>" + esc(p.model || "?") + "</b>. Frag z.B. <b>„Warum startet VM webserver nicht?“</b>");
  }

  /* ---------------- Updater &amp; Token-Bar ---------------- */

  function cmpVer(a, b) {
    const x = String(a).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
    const y = String(b).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const p = x[i] || 0, q = y[i] || 0;
      if (q > p) return 1;
      if (q < p) return -1;
    }
    return 0;
  }

  function checkUpdate() {
    const h = cockpit.http({ address: "api.github.com", port: 443, tls: {} });
    return h.request({
      method: "GET",
      path: "/repos/" + GH_REPO + "/releases?per_page=100",
      headers: { "User-Agent": "cockpit-ai-assistant", "Accept": "application/vnd.github.v3+json" }
    }).then(out => {
      const list = JSON.parse(out);
      let best = "";
      (Array.isArray(list) ? list : []).forEach(r => {
        const t = String(r.tag_name || "").replace(/^v/, "");
        if (!t) return;
        if (!best || cmpVer(best, t) > 0) best = t;
      });
      if (!best) best = VERSION;
      return cmpVer(VERSION, best) > 0 ? { update: true, version: best } : { update: false };
    }).catch(() => ({ update: false }));
  }

  function updateTokenBar() {
    const bar = $("#tokenBar");
    if (bar) bar.textContent = "Σ " + totalTokens + "";
  }

  /* ---------------- Setup-Gate ---------------- */

  const LS_SETUP = "ai-assistant-setup";

  function startSetup() {
    const old = document.querySelector("#setupFrame");
    if (old) old.remove();
    const f = document.createElement("iframe");
    f.id = "setupFrame";
    f.src = "setup.html";
    f.setAttribute("style", "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:70;background:transparent");
    document.body.appendChild(f);
    $("#setupbar").classList.add("hidden");
  }

  window.addEventListener("message", e => {
    const f = document.querySelector("#setupFrame");
    if (f && e.source === f.contentWindow && e.data && e.data.mbmSetup === "done") {
      f.remove();
      let state = "";
      try { state = localStorage.getItem(LS_SETUP) || ""; } catch (err) { /* ignore */ }
      if (state === "skipped") $("#setupbar").classList.remove("hidden");
    }
  });

  function maybeSetup() {
    let state = "";
    try { state = localStorage.getItem(LS_SETUP) || ""; } catch (e) { /* ignore */ }
    if (state === "done") return;
    if (state === "skipped") { $("#setupbar").classList.remove("hidden"); return; }
    startSetup();
  }

  /* ---------------- Start ---------------- */

  loadSettings().then(s => {
    settings = s;
    settings.profiles.forEach(p => {
      if (!p.level) p.level = "advisory";
      if (p.redact === undefined) p.redact = true;
    });
    loadUI();
    loadMcpServers();
    buildFab();
    applyUI();
    loadChats();
    renderChatTabs();
    renderChat();
    renderProfileSelect();
    fillAppearance();
    wire();
    renderMcp();
    mcpFetchTools();
    refreshVms();
    greetIfEmpty();
    if (WIDGET) { enterWidgetMode(); return; }
    maybeSetup();
    checkUpdate().then(r => { if (r.update) $("#updateBadge").classList.remove("hidden"); });
  });
}());
