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
  const RUN_KEY_DIR = "/run/ai-assistant";
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
  const VERSION = "1.0.1";
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
    b.onclick = () => {
      const card = document.querySelector("#chat");
      if (card) card.scrollIntoView({ behavior: "smooth" });
      const p = $("#prompt");
      if (p) p.focus();
    };
    document.body.appendChild(b);
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
    /* user: serverseitige, pro Linux-User getrennte Datei (tmpfs /run) */
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
      .then(u => { u = String(u).replace(/[^A-Za-z0-9_.-]/g, "") || "anon"; return RUN_KEY_DIR + "/" + u + ".json"; });
  }

  function saveRunKey(p, key) {
    return runKeyPath().then(path =>
      cockpit.file(path, { superuser: "try", create: true }).read().then(txt => {
        let m = {}; try { m = JSON.parse(txt || "{}"); } catch (e) { m = {}; }
        if (key) m[p.baseUrl] = key; else delete m[p.baseUrl];
        return cockpit.file(path, { superuser: "try", create: true }).replace(JSON.stringify(m, null, 2));
      }).then(() => {
        cockpit.spawn(["chmod", "600", path], { superuser: "try", err: "message" }).catch(() => {});
      })
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
      user: "Serverdatei pro Cockpit-Login-User (tmpfs /run, chmod 600, nach Logout weg). Empfohlen — funktioniert auf Headless-Hosts.",
      coin: "GNOME Keyring/libsecret ueber cockpit.secrets. Desktop-Hosts; auf Headless-KVM meist nicht verfuegbar.",
      browser: "Nur in DIESEM Browser (localStorage). Anderer Browser = kein Key. Nur Fallback."
    };
    return Promise.all([
      whoAmI(),
      Promise.resolve().then(() => (typeof cockpit.secrets !== "undefined" && !!cockpit.secrets)).catch(() => false)
    ]).then(r => {
      const line = { user: "Cockpit-User: " + r[0], coin: r[1] ? "Keyring verfuegbar" : "Keyring NICHT verfuegbar", browser: "Browser-Profil aktiv" };
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
    return { c: cockpit.http({ host: u.host, port: u.port, tls: u.tls }), path: u.base };
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

  function bubble(cls, who, html) {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    d.innerHTML = (who ? '<div class="who">' + who + "</div>" : "") + html;
    chatEl.appendChild(d);
    d.scrollIntoView({ behavior: "smooth", block: "end" });
    return d;
  }

  function toolBubble(title, output) {
    return bubble("sys", "", '<details class="tool"><summary>&#128295; ' + esc(title) + "</summary><pre>" + esc(output) + "</pre></details>");
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
      if (m.role === "user") bubbleSilent(el, "user", "Du", mdLite(m.content));
      else if (m.role === "assistant") {
        const div = bubbleSilent(el, "ai", "AI Assistant", mdLite(m.content || ""));
        const t = estimateTokens(m.content || "");
        const info = document.createElement("div");
        info.className = "token-info";
        info.innerHTML = "~" + t + " T";
        div.appendChild(info);
        highlightSyntax(div);
        updateTokenBar();
      } else if (m.role === "tool") {
        bubbleSilent(el, "sys", "", '<details class="tool"><summary>&#128295; ' + esc(m.tool_call_id || "Tool") + "</summary><pre>" + esc(m.content || "") + "</pre></details>");
      }
    });
    const last = el.lastElementChild;
    if (last) last.scrollIntoView({ block: "end" });
  }

  function bubbleSilent(parent, cls, who, html) {
    const d = document.createElement("div");
    d.className = "msg " + cls;
    d.innerHTML = (who ? '<div class="who">' + who + "</div>" : "") + html;
    parent.appendChild(d);
    return d;
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

  async function send(text) {
    if (busy || !text) return;
    const p = profile();
    if (p.level === "off") { bubble("sys", "", "Modus ist <b>Aus</b>. In den Einstellungen (Zahnrad) eine Stufe waehlen."); return; }
    const c = activeChat();
    if (!c) return;
    if (!c.messages.length) { c.title = autoTitle(text); saveChats(); }
    busy = true;
    $("#btnSend").disabled = true;
    bubble("user", "Du", mdLite(text));
    c.messages.push({ role: "user", content: text });
    trimMessages();
    try {
      const key = await getKey(p);
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const body = { model: p.model, temperature: p.temperature, max_tokens: p.maxTokens, top_p: p.topP, messages: [{ role: "system", content: sysPrompt(p) }].concat(c.messages) };
        const toolNames = enabledFor(p);
        if (toolNames.length) body.tools = TOOLS.filter(t => toolNames.indexOf(t.function.name) !== -1);
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
            c.messages.push({ role: "tool", tool_call_id: tc.id, content: out });
            saveChats();
          }
          trimMessages();
          continue;
        }
        const text = msg.content || "(leere Antwort)";
        const aiBubble = bubble("ai", "AI Assistant", "");
        typewriter(aiBubble, text, () => {
          const tokens = estimateTokens(text);
          totalTokens += tokens;
          const info = document.createElement("div");
          info.className = "token-info";
          info.innerHTML = "~" + tokens + " T · &#8721; " + totalTokens;
          aiBubble.appendChild(info);
          highlightSyntax(aiBubble);
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

  function fillForm() {
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
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
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

    function submit() {
      const t = $("#prompt").value.trim();
      if (!t) return;
      $("#prompt").value = "";
      send(t);
    }
  }

  function greet() {
    const p = profile();
    bubble("sys", "", "Bereit. " + modeBadge(p) + " · Modell <b>" + esc(p.model || "?") + "</b>. Frag z.B. <b>„Warum startet VM webserver nicht?“</b>");
  }

  /* ---------------- Updater &amp; Token-Bar ---------------- */

  function checkUpdate() {
    const h = cockpit.http({ host: "api.github.com", port: 443, tls: {} });
    return h.request({
      method: "GET",
      path: "/repos/" + GH_REPO + "/releases/latest",
      headers: { "User-Agent": "cockpit-ai-assistant", "Accept": "application/vnd.github.v3+json" }
    }).then(out => {
      const j = JSON.parse(out);
      const latest = (j.tag_name || "").replace(/^v/, "");
      return latest && latest !== VERSION ? { update: true, version: latest } : { update: false };
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
    if (e.data && e.data.mbmSetup === "done") {
      const f = document.querySelector("#setupFrame");
      if (f) f.remove();
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
    buildFab();
    applyUI();
    loadChats();
    renderChatTabs();
    renderChat();
    renderProfileSelect();
    fillAppearance();
    wire();
    refreshVms();
    greetIfEmpty();
    maybeSetup();
    checkUpdate().then(r => { if (r.update) $("#updateBadge").classList.remove("hidden"); });
  });
}());
