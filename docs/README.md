Hier liegen die Screenshots der README.

- `screenshot-chat.png` – Chat mit Befund → Beleg → kopierbarer Befehl
- `screenshot-settings.png` – LLM-Profile, Stufen, Tool-Checkboxen
- `screenshot-appearance.png` – Darstellung & Sprache
- `screenshot-confirm.png` – Bestätigungsdialog einer Write-Aktion
- `screenshot-setup.png` – begleiteter Setup-Dialog

Alle Bilder stammen von der echten UI und werden erzeugt mit:

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-screenshots.ps1
```

Das Skript kopiert die Plugin-Dateien in eine TEMP-Vorschau, hängt
`tools/preview/cockpit-mock.js` (Ersatz für die Cockpit-Bridge, feste Demo-Ausgaben)
vor `js/agent.js` und nimmt mit dem installierten Edge/Chrome headless auf (Standard 1440×900).
Parameter: `-Width`, `-Height`, `-Keep` (Vorschau-Kopie behalten).

Eigene Bilder aus einer echten Installation sind willkommen: 1440×900, Dark-Theme
bevorzugt, gleiche Dateinamen.
