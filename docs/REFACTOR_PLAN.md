# Refactor-Plan (präzise Schritte am Code)

## Entfernen/Archivieren
- `src/index_backup_before_refactor.js` → löschen
- `src/simulate.js` → löschen (Simulation wandert in `src/index.js` als DRY_RUN)
- `src/suggest_names.js` → entfernen (enthält duplizierten Block); optional als Dev-Tool später neu aufsetzen

## `src/index.js` – Anpassungen

1) Tote Funktion löschen
   - `analyzePdfWithOpenAIVision(...)` (referenziert `ocr` ohne Import; ungenutzt) → entfernen

2) DRY_RUN strikt durchziehen
   - Vor jedem: `ensureFolderExists`, `drive.files.create`, `drive.files.update`, `renameAndMove`, Transcript‑Upload  
     → wenn DRY_RUN: nur planen/loggen, nichts ausführen

3) Zielinventur rekursiv
   - NEU: `crawlDriveTreeRecursive(drive, rootId, { depth, maxFilesPerFolder })`
   - Ausgabe als Pfadbaum mit 1–2 Beispiel‑Dateien je Ordner (Prompt‑Kontext schlank halten)

4) OCR vereinheitlichen
   - PDFs: `gcsVision.ocrPdfViaGCS(localPdf)` (bestehend)
   - NEU Images: `gcsVision.ocrImageViaGCS(localImage)`
   - Wrapper: `ocrViaGcsAuto(localPath, originalName)` → erkennt MIME und ruft das passende OCR

5) LLM-Aufruf ersetzen
   - `proposeNameFromText(...)` → in `chooseDestinationWithAI(...)` umbenennen
   - Model: `process.env.OPENAI_MODEL || 'gpt-4.1'`
   - Prompt: Inhalte aus `prompts/openai_prompt.md`
   - JSON‑Schema: `{ new_filename, year, subfolder, create_subfolder }`
   - Parser: strikt, mit `{...}`‑Substring‑Fallback

6) Zielablage strikt
   - `ensureNestedPath(drive, TARGET_ID, [year, sub, 'Scan'], ['Texttranskript'])`
     - gibt `[yearId, subId, scanId, textId]` zurück
   - `uploadTranscript(drive, textId, basename(newName)+'.txt', transcript)`
   - `renameAndMove(drive, file, newName, scanId, SOURCE_ID)`

7) GCS Cleanup
   - `cleanupGcsJob({ bucket, inputObject, outputPrefix })`  
     → `deleteGcsObject(bucket, inputObject)` + `deleteGcsPrefix(bucket, outputPrefix)`
   - Global optional: Prefix‑Flush nach Durchlauf

8) Logging
   - Je Datei ein JSON‑ähnlicher Planblock (auch in Ausführung), z. B.:
     ```text
     PLAN for "eingang.pdf":
       ensure: ["2025","2025/Rechnungen","2025/Rechnungen/Scan","2025/Rechnungen/Texttranskript"]
       move:   "2025/Rechnungen/Scan/rechnung-acme-2025-02-01-12345.pdf"
       txt:    "2025/Rechnungen/Texttranskript/rechnung-acme-2025-02-01-12345.txt"
     ```

## `src/utils/gcsVision.js` – Erweiterung

- NEU: `ocrImageViaGCS(localImagePath, opts)` (siehe `docs/GCS_VISION.md`)
- Export `cleanup`-Funktionen bestehen bleiben (werden in `index.js` genutzt)

## `package.json` – Scripts (nach Refactor)

```json
{
  "scripts": {
    "start": "node src/index.js",
    "start:dry": "DRY_RUN=1 node src/index.js",
    "dump:gcs": "node src/dump_gcs_text.js",
    "test": "node --test"
  }
}
```

## Tests

- Vorhanden: `test/pdfNaming.test.js`
- Optional ergänzen: Unit‑Tests für `sanitizeToKeepExt`, Jahr‑Heuristik, JSON‑Parser (robust gegen Markdown oder Textmüll)

## Definition of Done

- Simulation: keine Drive‑Writes, aber vollständige Plan‑Logs
- Ausführung: Dateien & Transkripte an korrekten Pfaden; GCS pro Datei bereinigt; optional Prefix‑Flush
- Jahresregel & Unterordner strikt; Fallbacks funktionieren

