# AI Assistant — LLM-Assistent für Red Hat Cockpit (KVM/libvirt)

<p align="center">
  <img src="icon.svg" width="90" alt="AI Assistant"><br>
  <b>Von Fans für Cockpit</b> — Tribute an <a href="https://cockpit-project.org">cockpit-project/cockpit</a> und <a href="https://github.com/cockpit-project/cockpit-machines">cockpit-machines</a>.<br>
  MIT &amp; offen: jeder darf weiterentwickeln. Weniger Code, mehr Stabilität.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="#"><img src="https://img.shields.io/badge/Cockpit-%E2%89%A5265-0f6ec9.svg" alt="Cockpit"></a>
  <a href="#"><img src="https://img.shields.io/badge/no%20build%20step-100%25%20statisch-brightgreen.svg" alt="no build"></a>
  <a href="#"><img src="https://img.shields.io/badge/PRs-welcome-ccffdd.svg" alt="PRs welcome"></a>
  <a href="https://libvirt.org"><img src="https://img.shields.io/badge/libvirt-QEMU/KVM-6e97c3.svg" alt="libvirt"></a>
  <a href="https://github.com/ShaoRou459/CockpitAgent"><img src="https://img.shields.io/badge/inspired%20by-CockpitAgent-9cf.svg" alt="CockpitAgent"></a>
</p>

---

## Screenshot

| Chat-Ansicht (Befund → Beleg → Befehl) | LLM-Profile & Stufen |
|---|---|
| ![Chat-Ansicht](docs/screenshot-chat.png) | ![Einstellungen](docs/screenshot-settings.png) |
| **Darstellung & Sprache** | **Aktion mit Bestätigung** |
| ![Darstellung](docs/screenshot-appearance.png) | ![Bestätigung](docs/screenshot-confirm.png) |

Setup-Dialog (beim ersten Öffnen, überspringbar):

![Begleitetes Setup](docs/screenshot-setup.png)

> Die Bilder stammen von der echten UI. Ohne Cockpit-Host neu erzeugen:
> `powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-screenshots.ps1`
> (nutzt den installierten Chromium-Browser + `tools/preview/cockpit-mock.js` als Bridge-Ersatz).

## Funktionen

| | |
|---|---|
| **In Cockpit, nicht daneben** | Eigenes Menü-Plugin und/oder schwebende Chat-Kachel — direkt neben "Virtual Machines". |
| **Empfehlungs-Charakter** | Standard: Befund → Beleg (Log-/XML-Zeile) → exakter, kopierbarer Befehl inkl. Wirkung + Risiko. |
| **12 Host-Tools statt Freiflug** | `virsh`/`journalctl`/`dmesg`/`df`/`ip` & Co. als benannte Funktionen mit Regex-validierten Argumenten. Keine Shell-Pipes. |
| **Vier Stufen + Feinjustierung** | `Aus` → `Diagnose` → `Empfehlung` (Default) → `Aktion`. Jede Funktion einzeln abwählbar. |
| **Begleitetes Setup** | Dialog mit Erklärung, Häkchen und Skip — nichts läuft ohne dein OK. |
| **Multi-Chat** | Threads mit Suche, Titel-Automatik, Persistenz. |
| **Jede OpenAI-kompatible API** | Ollama, vLLM, OpenRouter, DeepSeek, … Profile komplett in der GUI. |
| **Key-Sicherheit** | tmpfs-Datei pro Login-User (`chmod 600`) — der Key ist nie im Browser-HTML. |
| **Redaction** | IPs, Base64-Blobs, `password=`-Zeilen werden vor dem LLM-Call entfernt. |
| **DE/EN + Hell/Dunkel** | Systemsprache/-theme Erkennung, alles später umschaltbar. |

## Warum dieses Plugin?

Cockpit ist eine brillante Server-GUI — aber wenn eine VM nicht startet, sitzt man trotzdem vor Logs.
**AI Assistant** sitzt *in* Cockpit, darf dem Host nur über eine eng definierte Allowlist „hineinschauen“
und antwortet im **Empfehlungs-Charakter**: Befund → Beleg → kopierbarer Befehl.
Es ist bewusst *kein* Autopilot. Du bestimmst per **Stufe**, was das LLM tun darf.

Dank `cockpit.http` (Bridge-Proxy) und `cockpit.spawn` (argv-Allowlist + polkit) laufen
alle Zugriffe über die Cockpit-Schicht — ohne Build-Step, ohne Daemon, ohne Shell-Pipes.

## Einrichten — begleitet, optional, überspringbar

Das Plugin startet beim ersten Öffnen einen **geführten Setup-Dialog**: jeder Schritt hat eine
Erklärung, ein Häkchen (mag ich / mag ich nicht) und einen **Skip**-Button. Nichts wird
ungefragt installiert. Der Dialog lässt sich später über „⚙ Setup starten“ erneut öffnen.

Alternativ manuell (1 Befehl):

```bash
git clone https://github.com/mcathereal/cockpit-ai-assistant
sudo cp -r cockpit-ai-assistant/ai-assistant /usr/share/cockpit/ai-assistant
```

Browser neu laden → Menüpunkt **AI Assistant**. Kein Cockpit-Neustart nötig.

## Position & Aussehen (später änderbar)

Knopf **◑ (Darstellung)** oben rechts — dort wählst du:

| Option | Wirkung |
|---|---|
| Seite &amp; Kachel (empfohlen) | Fester Menüpunkt + schwebendes Chat-Icon |
| Nur eigene Seite im Menü | Wie cockpit-machines — nur Navigationspunkt |
| Nur schwebende Kachel | Chat-Icon am Rand, kein Menüpunkt sichtbar |

Kachel-Position: unten rechts / unten links / oben rechts / oben links.
Farbtheme: System/Cockpit folgen, Dunkel (Navy) oder Hell.
Sprache: System folgen, Deutsch oder Englisch.

Alles lokal in `localStorage` gespeichert — pro Browser, sofort wirksam, ohne Cockpit-Neustart.

## Sicherheitsmodell (Kurzfassung)

| Ebene | Umsetzung |
|---|---|
| **Keys** | **Niemals** im Browser, nie im HTML/JS. Primär: Serverdatei pro Login-User auf tmpfs (`/run/ai-assistant/<user>.json`, `chmod 600`, nach Logout weg). Fallback: `localStorage` des Browsers + Warnhinweis. |
| **LLM-Zugriff** | Stufe `off` / `diagnose` / `advisory` (Default) / `act`. Granular pro Tool abwählbar. Write-Tools (`vm_*`) immer GUI-bestätigt, `superuser:"try"` nur auf deklarierten Pfaden. |
| **Datenweg** | Tool-Ausgaben werden vor Rückgabe ans LLM **redacted** (Base64-Sequenzen, IPs, `password=`-Zeilen) und auf `tail`-Größen gecappt. |
| **Stabilität** | spawn-timeout 30 s, LLM-Timeout 120 s, Chat-FIFO (24 Meldungen), jede Fehlerstelle → saubere Fehlerbox statt weißer Bildschirm. |
| **Kein Freiflug** | Das LLM sieht **niemals** eine Shell. Nur benannte Funktionen mit validierten Argumenten (Regex), feste Schalter, Präfix-Leseliste. |

## LLM-Profile (in der GUI, kein Editieren von Dateien)

Zahnrad → Profil anlegen → Base-URL + Modell + optional Key → **Stufe** wählen → Speichern.

| Backend | Base-URL | Modell (Tool-Calling) |
|---|---|---|
| Ollama (lokal, empfohlen) | `http://127.0.0.1:11434/v1` | `qwen2.5:14b`, `llama3.1` |
| vLLM | `http://host:8000/v1` | serving-Modell |
| OpenRouter | `https://openrouter.ai/api/v1` | frei wählbar |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI-kompatibel | eigene URL | — |

**Stufen:**
- `Aus` — Chat sendet nichts ans LLM.
- `Nur Diagnose` — read-only Werkzeuge, keine Handlungsempfehlung als Befehl.
- `Empfehlung` (Default) — wie Diagnose, aber mit exaktem Lösungsbefehl + Risiko-Abschätzung.
- `Aktion` — zusätzlich `vm_start` / `vm_shutdown` / `vm_stop`, **jeder** Aufruf mit Bestätigungsdialog.

Feiner: im Profil jede Funktion einzeln an-/ausschalten (Checkbox-Liste).

## Changelog

Siehe [CHANGELOG.md](CHANGELOG.md) — SemVer, Keep-a-Changelog-Format.

## Mitmachen — so wie Cockpit es uns vormacht

Wir sind Cockpit-**Fans** und verstehen dieses Plugin als Tribut an die
[cockpit-project](https://github.com/cockpit-project/cockpit)-Community (und als Anstoß an
[cockpit-machines](https://github.com/cockpit-project/cockpit-machines), mal über einen
LLM-Kontext-Knopf nachzudenken). Wenn du eine Idee hast:

1. Fork → Branch `feature/...`
2. `node --check ai-assistant/js/agent.js` (kein Build sonst)
3. PR — wir Reviewen mit dem Ziel „weniger Code, mehr Stabilität“

**Guidelines:** keine Build-Tools, keine npm-Dependencies, kein externer CDN-Laden,
alles `superuser`-relevante muss in `manifest.json` deklariert sein.

## Dank

An die **cockpit-project**-Leute: Dass eine Server-GUI so sauber erweiterbar ist — `spawn`,
`http`, `manifest.json`, keine Build-Pflicht — ist der eigentliche Grund, warum dieses Plugin
überhaupt in wenigen Tagen entstehen konnte. Ihr habt die Brücken gebaut; wir haben nur
einen Chat daneben gesetzt.

Ebenso danke an die **cockpit-machines**-Maintainer: deren Code-Lesart (`libvirt-dbus`,
Tool-Namensgebung, Bestätigungsdialoge) war stiller Leitfaden für jedes Tool hier.

Und danke an [CockpitAgent](https://github.com/ShaoRou459/CockpitAgent): der frühe Beweis,
dass AI in Cockpit kein Fremdkörper sein muss.

## Inspiration & Tribute

- [cockpit-project/cockpit](https://github.com/cockpit-project/cockpit) — API/Design-Vorbild
- [cockpit-machines](https://github.com/cockpit-project/cockpit-machines) — die VM-GUI, die wir lieben
- [cockpit-project.org/guide](https://cockpit-project.org/guide/latest/) — Bridge/`spawn`/`http` dokumentiert
- [CockpitAgent](https://github.com/ShaoRou459/CockpitAgent) — früher Proof, dass AI-in-Cockpit geht

## License

[MIT](LICENSE) © 2026 Marcel Weise. Teilen, verbessen, forken erwünscht.
