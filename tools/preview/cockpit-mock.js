/* Cockpit-Mock fuer Screenshots NUR unter file:
 *
 * Laedt die echte Plugin-UI (index.html + js/agent.js + css) ohne Cockpit-Bridge:
 * cockpit.spawn/file/http/session werden durch feste Demo-Ausgaben ersetzt, damit
 * Chat, Tools und Einstellungen determiniert gerendert werden koennen.
 *
 * NICHT fuer die Produktion verwenden - echtes Plugin laeuft in Cockpit.
 *
 * Aufnahme (Playwright):
 *   const { chromium } = require("playwright");
 *   const b = await chromium.launch();
 *   const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
 *   await p.addInitScript({ path: "tools/preview/cockpit-mock.js" });
 *   await p.goto("file:///ABS/PFAD/cockpit-ai-assistant/index.html");
 *   await p.waitForTimeout(1200);
 *   await p.screenshot({ path: "docs/screenshot-chat.png" });
 */
(function () {
  "use strict";
  if (location.protocol !== "file:") return;

  /* localStorage: unter file: kann der native Zugriff blockiert sein -> Speicher-Shim */
  try { localStorage.setItem("__probe", "1"); localStorage.removeItem("__probe"); }
  catch (e) {
    var mem = {};
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
        clear: function () { mem = {}; }
      }
    });
  }

  /* ---------------- Demo-Chat vorbefuellen (nur beim ersten Laden) --------- */
  try {
    if (!localStorage.getItem("ai-assistant-seed")) {
      localStorage.setItem("ai-assistant-seed", "1");
      localStorage.setItem("ai-assistant-setup", "done");
      localStorage.setItem("ai-assistant-ui", JSON.stringify({ place: "both", corner: "rb", theme: "dark", lang: "de" }));
      localStorage.setItem("ai-assistant-settings", JSON.stringify({
        active: 0,
        profiles: [{
          name: "Ollama (lokal)", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b",
          keyStored: true, keyStore: "user", level: "advisory", redact: true, tools: null,
          temperature: 0.2, maxTokens: 4096, topP: 1
        }]
      }));
      var log = [
        "2026-09-09 07:12:03.114+0000: starting up libvirt version: 10.1.0, qemu version: 8.2.2",
        "LC_ALL=C PATH=/usr/bin HOME=/root USER=root LOGNAME=root /usr/bin/qemu-kvm -name guest=webserver,...",
        "2026-09-09T07:12:03.402Z qemu-kvm: -device {"
        + "\"driver\":\"virtio-net-pci\",\"netdev\":\"hostnet0\",\"id\":\"net0\",\"mac\":\"52:54:00:1a:2b:3c\"}",

        "2026-09-09T07:12:03.402Z qemu-kvm: network backend 'hostnet0' is not usable:",
        "2026-09-09T07:12:03.402Z qemu-kvm: unable to get bridge virbr1: No such file or directory",
        "2026-09-09T07:12:03.403Z qemu-kvm: terminating on signal 6 from pid 1 (qemu-kvm)"
      ].join("\n");
      var answer = [
        "**Befund:** Die VM `webserver` haengt beim Start an ihrem Netzwerk-Backend. QEMU bricht mit Signal 6 ab,",
        "weil die im XML referenzierte Bridge `virbr1` auf dem Host nicht existiert. Die VM laeuft deshalb nicht,",
        "obwohl libvirt selbst gesund ist.",
        "",
        "**Beleg** (`/var/log/libvirt/qemu/webserver.log`):",
        "`qemu-kvm: unable to get bridge virbr1: No such file or directory`",
        "",
        "**Empfehlung** - Netz der VM auf das vorhandene Default-Netz `virbr0` umhaengen (VM kurz neu definieren,",
        "kein Datenverlust):",
        "",
        "```bash",
        "virsh net-list --all                 # zeigt: virbr0 aktiv, virbr1 fehlt",
        "virsh net-start default              # falls virbr0 inaktiv",
        "virsh dumpxml webserver > /tmp/ws.xml",
        "sed -i 's#<source bridge=\"virbr1\"/>#<source bridge=\"virbr0\"/>#' /tmp/ws.xml",
        "virsh define /tmp/ws.xml && virsh start webserver",
        "```",
        "",
        "**Wirkung:** VM haengt an der aktiven Bridge und startet. **Risiko:** mittel - `virsh define` ueberschreibt",
        "die Domain-Definition; deshalb vorher Dump nach `/tmp/ws.xml`. Alternative ohne Define:",
        "`virsh net-define /etc/libvirt/qemu/networks/autostart/default.xml && virsh net-start default`."
      ].join("\n");
      localStorage.setItem("ai-assistant-chats", JSON.stringify([{
        id: "demo01", title: "Warum startet webserver nicht", created: Date.now(),
        messages: [
          { role: "user", content: "Warum startet die VM webserver nicht?" },
          { role: "tool", tool_call_id: "vm_console_log webserver tail=80", content: log },
          { role: "assistant", content: answer }
        ]
      }]));
    }
  } catch (e) { /* ignore */ }

  /* ---------------- feste Host-Ausgaben ------------------------------------ */
  var VM_TABLE = [
    " Id   Name             State",
    "----------------------------------------",
    " 3    webserver        running",
    " 7    db-primary       running",
    " -    win11-lab        shut off",
    ""
  ].join("\n");

  var OUTPUTS = {
    whoami: "admin\n",
    "virsh list --all": VM_TABLE,
    "virsh net-list --all": [
      " Name      State    Autostart   Persistent",
      "--------------------------------------------",
      " default   inactive no          yes",
      ""
    ].join("\n"),
    "free -h": [
      "               total        used        free      shared  buff/cache   available",
      "Mem:            62Gi        28Gi       9,1Gi       512Mi        25Gi        32Gi",
      "Swap:          8,0Gi          0B       8,0Gi"
    ].join("\n"),
    "uptime": " 09:41:12 up 41 days,  3:22,  2 users,  load average: 0.61, 0.58, 0.52",
    "ip -brief addr show": [
      "lo               UNKNOWN        127.0.0.1/8 ::1/128",
      "enp1s0           UP             10.0.10.21/24 fe80::a6c1:ecff:fe12:34/64",
      "virbr0           UP             192.168.122.1/24",
      "tap0             DOWN"
    ].join("\n"),
    "ip route show": [
      "default via 10.0.10.1 dev enp1s0 proto static metric 100",
      "10.0.10.0/24 dev enp1s0 proto kernel scope link src 10.0.10.21",
      "192.168.122.0/24 dev virbr0 proto kernel scope link src 192.168.122.1"
    ].join("\n"),
    "df -h --total --exclude-type=tmpfs --exclude-type=devtmpfs": [
      "Filesystem                         Size  Used Avail Use% Mounted on",
      "/dev/mapper/rootvg-rootlv           80G   41G   40G  51% /",
      "/dev/sda2                          975M  268M  640M  30% /boot",
      "/dev/mapper/datavg-poollv-mypool    15G  1,2G   14G   8% /var/lib/libvirt/images",
      "total                              1,6T   89G  1,5T   6% -"
    ].join("\n"),
    dmesg: [
      "[Thu Sep  4 03:11:02 2026] qemu-kvm[4122]: segfault at 0 ip 00007f3c error 4 in libglibc",
      "[Fri Sep  5 11:44:19 2026] virbr0: port 2(tap1) entered disabled state",
      "[Sun Sep  7 22:02:41 2026] NFSD: client 10.0.10.30 has stale filehandle",
      "[Tue Sep  9 07:12:03 2026] bridge name virbr1 already in existence"
    ].join("\n")
  };

  var JOURNAL = [
    "Sep 09 07:12:03 kvm01 libvirtd[2114]: internal error: process exited while connecting to monitor",
    "Sep 09 07:12:03 kvm01 libvirtd[2114]: QEMU has terminated unexpectedly: signal=6",
    "Sep 09 07:11:58 kvm01 libvirtd[2114]: Domain webserver starting up",
    "Sep 09 06:40:11 kvm01 libvirtd[2114]: Domain db-primary started",
    "Sep 08 22:00:02 kvm01 libvirtd[2114]: Storage pool 'datavg' refreshed"
  ].join("\n");

  var DOMINFO = [
    "Name:           webserver",
    "UUID:           4f2a1c9e-1b7d-4a11-9f0c-2d5e88aa11bb",
    "OS Type:        hvm",
    "State:          shut off",
    "CPU(s):         4",
    "Max memory:     8388608 KiB",
    "Used memory:    8388608 KiB",
    "Persistent:     yes",
    "Autostart:      disable",
    "Managed save:   no",
    "Security model: qemu",
    "Security DOI:   0"
  ].join("\n");

  var XML = [
    "<domain type='kvm'>",
    "  <name>webserver</name>",
    "  <uuid>4f2a1c9e-1b7d-4a11-9f0c-2d5e88aa11bb</uuid>",
    "  <memory unit='KiB'>8388608</memory>",
    "  <vcpu placement='static'>4</vcpu>",
    "  <os>",
    "    <type arch='x86_64' machine='pc-q35-8.2'>hvm</type>",
    "    <boot dev='hd'/>",
    "  </os>",
    "  <features>",
    "    <acpi/><apic/><pae/></features>",
    "  <on_poweroff>destroy</on_poweroff>",
    "  <devices>",
    "    <interface type='bridge'>",
    "      <source bridge='virbr1'/>",
    "      <target dev='vnet0'/>",
    "    <disk type='file' device='disk'>",
    "      <driver name='qemu' type='qcow2'/>",
    "      <source file='/var/lib/libvirt/images/webserver.qcow2'/>",
    "    <channel type='unix'>",
    "      <target type='virtio' name='org.qemu.guest_agent.0'/>",
    "    <memballoon model='virtio'>",
    "  </devices>",
    "</domain>"
  ].join("\n");

  var CONSOLE_LOG = [
    "2026-09-09 07:12:03.114+0000: starting up libvirt version: 10.1.0, qemu version: 8.2.2",
    "LC_ALL=C PATH=/usr/bin HOME=/root /usr/bin/qemu-kvm -name guest=webserver,debug-threads=on",
    "2026-09-09T07:12:03.402Z qemu-kvm: -device virtio-net-pci,netdev=hostnet0: network backend",
    "2026-09-09T07:12:03.402Z qemu-kvm: unable to get bridge virbr1: No such file or directory",
    "2026-09-09T07:12:03.403Z qemu-kvm: terminating on signal 6"
  ].join("\n");

  var FILES = {
    "/var/log/libvirt/qemu/webserver.log": CONSOLE_LOG,
    "/var/log/libvirt/qemu/db-primary.log": "2026-09-09 06:40:11.001+0000: starting up\n2026-09-09 06:40:12.220+0000: running\n",
    "/etc/os-release": "NAME=\"Fedora Linux\"\nVERSION=\"40 (Server Edition)\"\nID=fedora\nVERSION_ID=40\n",
    "/proc/meminfo": "MemTotal:       65565312 kB\nMemFree:         9542112 kB\nMemAvailable:   33812480 kB\n",
    "/etc/libvirt/qemu/networks/default.xml": "<network>\n  <name>default</name>\n  <bridge name='virbr0'/>\n  <forward mode='nat'/>\n</network>\n"
  };

  function match(argv) {
    var cmd = argv.join(" ");
    if (OUTPUTS[cmd] !== undefined) return OUTPUTS[cmd];
    if (argv[0] === "virsh" && argv[1] === "dominfo") return DOMINFO;
    if (argv[0] === "virsh" && argv[1] === "dumpxml") return XML;
    if (argv[0] === "virsh" && argv[1] === "snapshot-list") return [
      " Name       Creation Time               State",
      "-----------------------------------------------",
      " pre-patch  2026-08-14 10:22:31 +0000   running",
      " v1-clean   2026-07-02 08:05:12 +0000   shut off"
    ].join("\n");
    if (argv[0] === "virsh" && (argv[1] === "start" || argv[1] === "shutdown" || argv[1] === "destroy")) {
      return argv[1] === "start" ? "Domain '" + argv[2] + "' started\n" : "Domain '" + argv[2] + "' " + argv[1] + "ed\n";
    }
    if (argv[0] === "journalctl") return JOURNAL;
    if (argv[0] === "dmesg") return OUTPUTS.dmesg;
    if (argv[0] === "df") return OUTPUTS["df -h --total --exclude-type=tmpfs --exclude-type=devtmpfs"];
    if (argv[0] === "ip" && argv[1] === "route") return OUTPUTS["ip route show"];
    if (argv[0] === "test") return "";
    if (argv[0] === "chmod" || argv[0] === "mkdir" || argv[0] === "cp" || argv[0] === "rm") return "";
    return null;
  }

  /* ---------------- Mock-API ---------------------------------------------- */
  function ok(v, ms) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms === undefined ? 25 : ms); }); }
  function fail(msg) { return new Promise(function (r, j) { setTimeout(function () { j(new Error(msg)); }, 25); }); }

  /* ---------------- Vorschau-Zustand per URL-hash (#settings, #appearance) --- */
  /* scrollIntoView neutralisieren: Screenshots sollen immer oben beginnen */
  try { Element.prototype.scrollIntoView = function () {}; } catch (e) { /* ignore */ }

  window.addEventListener("load", function () {
    setTimeout(function () {
      var h = (location.hash || "").replace("#", "");
      /* Screenshots zeigen das MBM-Logo; die installierte UI nutzt das neutrale
       * icon-brain.svg. Hier zurueckgetauscht, damit die Bilder unveraendert bleiben. */
      [].forEach.call(document.querySelectorAll('img[src="icon-brain.svg"]'), function (i) {
        i.src = "icon.svg";
      });
      if (h === "settings" && document.querySelector("#btnSettings")) document.querySelector("#btnSettings").click();
      if (h === "appearance" && document.querySelector("#btnAppearance")) document.querySelector("#btnAppearance").click();
      if (h === "modal") {
        document.querySelector("#modalTitle").textContent = "VM starten";
        document.querySelector("#modalCmd").textContent = "virsh start webserver";
        document.querySelector("#modalText").textContent =
          "Der Host fuehrt diesen Befehl aus (polkit/Root). Deine Zustimmung erforderlich:";
        document.querySelector("#modal").classList.remove("hidden");
      }
      var f = document.querySelector("#setupFrame");
      if (f) f.remove();
    }, 900);
  });

  window.cockpit = {
    language: "de",
    session: { user: "admin" },

    spawn: function (argv, opts) {
      var out = match(argv);
      if (out === null) return fail("kein Demo-Befehl: " + argv.join(" "));
      return ok(out);
    },

    file: function (path) {
      return {
        read: function () { return ok(FILES[path] !== undefined ? FILES[path] : null); },
        replace: function (v) { FILES[path] = v; return ok(v); }
      };
    },

    http: function () {
      return {
        request: function (o) {
          if (o.method === "GET" && /\/models$/.test(o.path)) {
            return ok(JSON.stringify({ data: [
              { id: "qwen2.5:7b" }, { id: "qwen2.5:14b" }, { id: "llama3.1:8b" }, { id: "mistral:7b" }
            ] }));
          }
          if (o.method === "POST" && /chat\/completions$/.test(o.path)) {
            return ok(JSON.stringify({
              choices: [{ message: { role: "assistant", content: "Befund: keine Auffaelligkeiten in den gelesenen Quellen." } }],
              usage: { total_tokens: 148 }
            }), 400);
          }
          if (/releases\/latest$/.test(o.path)) {
            return ok(JSON.stringify({ tag_name: "v1.0.1" }));
          }
          return fail("Demo-HTTP: " + o.path);
        }
      };
    }
  };
}());
