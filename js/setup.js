/* AI Assistant - begleitetes Setup: Schritte mit Haekchen, Erklaerung, Warnung und Skip.
 * Laeuft im iframe setup.html; meldet fertig/skip per postMessage an agent.js.
 * MIT License - see LICENSE. */
(function () {
  "use strict";

  const cockpit = window.cockpit;
  const $ = s => document.querySelector(s);
  const LS_SETUP = "ai-assistant-setup";
  const REPO = "https://github.com/mcathereal/cockpit-ai-assistant.git";
  const DEST = "/usr/share/cockpit/ai-assistant";

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  function log(s, cls) {
    const d = el("div", cls, esc(s));
    $("#setupOut").appendChild(d);
    d.scrollIntoView({ block: "end" });
  }

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  function run(argv, opts) {
    return cockpit.spawn(argv, Object.assign({ superuser: "try", err: "message", timeout: 180 }, opts || {}));
  }

  const steps = [
    {
      id: "pkg", title: "Pruefwerkzeuge installieren (optional)",
      what: "Bringt 'git' und 'curl' mit (dnf/apt). Falls schon vorhanden: macht nichts.",
      why: "Ohne git kann das Plugin nicht vom GitHub-Repo geholt werden.",
      defaultOn: true,
      warn: "Installiert Pakete aus den Standard-Repos des Hosts.",
      run: async () => {
        const has = c => run([c, "--version"]).then(() => true).catch(() => false);
        if (await has("git") && await has("curl")) { log("git + curl vorhanden - nichts zu tun.", "ok"); return; }
        const hasDnf = await has("dnf");
        const hasApt = await has("apt-get");
        if (!hasDnf && !hasApt) { log("Kein dnf/apt-get gefunden - bitte git selbst installieren.", "e"); return; }
        const pkg = hasDnf ? "dnf" : "apt-get";
        log("Installiere git curl mit " + pkg + " ...");
        if (pkg === "dnf") await run(["dnf", "install", "-y", "git", "curl"]);
        else { await run(["apt-get", "update"]); await run(["apt-get", "install", "-y", "git", "curl"]); }
      }
    },
    {
      id: "dl", title: "Plugin herunterladen",
      what: "git clone --depth 1 " + REPO + " /tmp/ai-assistant-src",
      why: "Holt den aktuellen Quellcode in einen temporaeren Ordner.",
      defaultOn: true,
      warn: "Laedt Code von github.com (HTTPS, ohne Zugangsdaten).",
      run: async () => {
        log("Deaktiviert: kein Re-Download - Plugin ist bereits installiert.", "ok"); return;
        await run(["git", "clone", "--depth", "1", REPO, "/tmp/ai-assistant-src"]);
      }
    },
    {
      id: "install", title: "Installieren nach " + DEST,
      what: "Kopiert den Ordner nach " + DEST + " (davor Backup nach /var/lib/ai-assistant-backup).",
      why: "Cockpit ladet den Ordner sofort - kein Neustart noetig.",
      defaultOn: true,
      warn: "Eine alte Version wird gesichert, nicht geloescht.",
      run: async () => {
        log("Deaktiviert: keine Neuinstallation - wuerde lokale Fixes ueberschreiben.", "ok"); return;
        if (has) {
          const stamp = Math.floor(Date.now() / 1000);
          await run(["mkdir", "-p", "/var/lib/ai-assistant-backup"]);
          await run(["cp", "-a", DEST, "/var/lib/ai-assistant-backup/ai-assistant." + stamp]);
          log("Alte Version gesichert -> /var/lib/ai-assistant-backup/", "ok");
        }
        await run(["mkdir", "-p", DEST]);
        await run(["cp", "-a", "/tmp/ai-assistant-src/.", DEST + "/"]);
      }
    },
    {
      id: "cockpit", title: "Cockpit pruefen/neu starten (optional)",
      what: "systemctl restart cockpit",
      why: "Normaleerweise NICHT noetig. Nur wenn das Menue danach keinen Punkt 'AI Assistant' zeigt.",
      defaultOn: false,
      warn: "Aktive Cockpit-Sessions koennen kurz getrennt werden.",
      run: async () => {
        await run(["systemctl", "status", "cockpit.service", "--no-pager", "-n", "3"]);
        await run(["systemctl", "restart", "cockpit.service"]);
        log("cockpit neu gestartet.", "ok");
      }
    },
    {
      id: "ollama", title: "Lokales LLM (Ollama) einrichten (optional)",
      what: "Install + 'systemctl enable --now ollama' + Modell-Pull (qwen2.5:7b, ~4.7 GB).",
      why: "Ohne LLM-Endpunkt kann der Assistent nicht antworten. Alternative spaeter in den Einstellungen (OpenRouter/DeepSeek/vLLM).",
      defaultOn: false,
      warn: "Laedt ~5 GB herunter und braucht dauerhaft ~5 GB RAM. Loeschbar mit: rm -rf ~/.ollama /usr/local/bin/ollama.",
      run: async () => {
        const up = await run(["systemctl", "is-active", "ollama"]).then(o => o.trim() === "active").catch(() => false);
        if (!up) {
          log("Ollama nicht gefunden - Installation ueber ollama.com/install.sh ...");
          await run(["curl", "-fsSLo", "/tmp/ollama-install.sh", "https://ollama.com/install.sh"]);
          await run(["sh", "/tmp/ollama-install.sh"]);
          await run(["systemctl", "enable", "--now", "ollama"]);
        }
        log("Pull qwen2.5:7b (grosser Download) ...");
        await run(["ollama", "pull", "qwen2.5:7b"], { timeout: 3600 });
      }
    }
  ];

  function card(s) {
    const c = el("div", "step");
    const head = el("label", "head");
    const box = el("input"); box.type = "checkbox"; box.checked = !!s.defaultOn;
    const ttl = el("div", "ttl", esc(s.title) + '<div class="why">' + esc(s.what) + "</div>" +
      '<div class="why sub">' + esc(s.why) + "</div>" +
      (s.warn ? '<div class="warn">&#9888; ' + esc(s.warn) + "</div>" : ""));
    head.appendChild(box); head.appendChild(ttl);
    c.appendChild(head);
    const btns = el("div", "btns");
    const bRun = el("button", "b", "Nur diesen Schritt ausfuehren");
    const st = el("span", "st", "");
    btns.appendChild(bRun); btns.appendChild(st);
    c.appendChild(btns);
    bRun.onclick = () => exec(s, st);
    s._box = box; s._st = st;
    return c;
  }

  function exec(s, st, done) {
    st.textContent = "laeuft..."; st.className = "st run";
    Promise.resolve().then(s.run)
      .then(() => { st.textContent = "fertig"; st.className = "st ok"; log("OK: " + s.title, "ok"); if (done) done(); })
      .catch(e => { st.textContent = "FEHLER"; st.className = "st err"; log("Fehler bei '" + s.title + "': " + (e.message || e), "e"); if (done) done(); });
  }

  function build() {
    $("#steps").innerHTML = "";
    steps.forEach(s => $("#steps").appendChild(card(s)));
    $("#btnRun").onclick = () => {
      steps.forEach(s => { s._box.disabled = true; });
      const chain = steps.filter(s => s._box.checked)
        .reduce((p, s) => p.then(() => new Promise(res => exec(s, s._st, res))), Promise.resolve());
      chain.then(() => {
        log("Setup abgeschlossen.", "ok");
        $("#btnRun").classList.add("hidden");
        $("#btnFinish").classList.remove("hidden");
      });
    };
    $("#btnSkip").onclick = () => {
      try { localStorage.setItem(LS_SETUP, "skipped"); } catch (e) { /* ignore */ }
      (window.parent || window).postMessage({ mbmSetup: "done" }, window.location.origin);
    };
    $("#btnFinish").onclick = () => {
      try { localStorage.setItem(LS_SETUP, "done"); } catch (e) { /* ignore */ }
      (window.parent || window).postMessage({ mbmSetup: "done" }, window.location.origin);
    };
  }

  build();
}());
