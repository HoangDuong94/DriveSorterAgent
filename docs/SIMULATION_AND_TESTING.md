# Simulation & Tests

## Read‑Only Modus

Starte mit:

```bash
node src/index.js --dry-run
# oder
DRY_RUN=1 node src/index.js
```

Erwartet:

- Keine Ordner werden angelegt
- Keine Dateien werden verschoben/umbenannt/hochgeladen
- Pro Datei ein Plan‑Block wie:

```
PLAN for "eingang-1.pdf":
  ensure: ["2025","2025/Rechnungen","2025/Rechnungen/Scan","2025/Rechnungen/Texttranskript"]
  wouldMove: "2025/Rechnungen/Scan/rechnung-acme-2025-02-01-12345.pdf"
  wouldUploadTxt: "2025/Rechnungen/Texttranskript/rechnung-acme-2025-02-01-12345.txt"
  exists: { "2025": true, "2025/Rechnungen": false, ... }
```

## Manuelle Testfälle

1. PDF (digital) mit ausreichend Text → sollte ohne OCR‑Artefakte klar benannt werden
2. PDF (Scan) → GCS‑OCR greift; Jahr/Absender erkannt
3. Bild (jpg) einer Rechnung → GCS‑OCR greift
4. Unklare Datei → Fallback: `Sonstiges`, generischer Name
5. Mehrere Dateien → prüfe, dass `Scan` und `Texttranskript` korrekt entstehen
6. GCS Cleanup → nach Durchlauf dürfen keine verwaisten `input/` und `output/` Reste für die Jobs bleiben

## Unit-Tests

Vorhanden:

```bash
npm test
```

- `test/pdfNaming.test.js` prüft Heuristik (Kategorie/Datum/Dateiname)

Empfehlung (optional):

- Tests für JSON‑Parser (LLM‑Antworten), Jahr‑Fallback, Sanitize‑Funktion

