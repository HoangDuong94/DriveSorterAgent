# Umsetzungs-Workflow (zu `src/index.js`)

Diese Datei beschreibt den Zielablauf und die dafür nötigen Funktionen/Schritte. Sie bezieht sich auf den aktuellen Stand im Repo (Repomix oben).

## Übersicht (1–7)

1) Quelle lesen  
   - `listFilesInFolder(drive, SOURCE_ID)`
2) OCR via GCS (rein textbasiert)
   - PDFs: `gcsVision.ocrPdfViaGCS(localPdf)`
   - NEU: Images: `gcsVision.ocrImageViaGCS(localImage)`
3) Zielstruktur auslesen & an LLM geben
   - NEU: `crawlDriveTreeRecursive(drive, TARGET_ROOT_ID, { depth: 3, maxFilesPerFolder: 50 })`
   - Ausgabe als Pfadbaum für den Prompt („Drive‑Zielstruktur (gekürzt)“)
4) OpenAI (gpt‑4.1) für Routing/Benennung
   - Prompt: `prompts/openai_prompt.md`
   - Erwartetes JSON:
     ```json
     { "new_filename": "...", "year": "2025", "subfolder": "Rechnungen", "create_subfolder": true }
     ```
   - Fallback, falls JSON invalide: heuristisch via `pdfNaming` (Kategorie/Datum)
4a) Jahresregel erzwingen
   - Zielpfad immer `YYYY/Subfolder`
5) Move/Umbenennen
   - Simulation: nur planen/loggen
   - Ausführung: `ensureNestedPath()` + `renameAndMove()`
6) Ablage Transkript
   - in `YYYY/Subfolder/Texttranskript/<basename>.txt`
7) GCS Cleanup
   - pro Datei: `deleteGcsObject(inputObject)` + `deleteGcsPrefix(outputPrefix)`
   - optional global: Prefix‑Flush (per `CLEAR_GCS_PREFIX_ON_EXIT`)

## Pseudocode

```js
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

const SOURCE_ID = await resolveFolderId(drive, process.env.SOURCE_FOLDER_ID);
const TARGET_ID = await resolveFolderId(drive, process.env.TARGET_ROOT_FOLDER_ID);

const inventory = await crawlDriveTreeRecursive(drive, TARGET_ID, { depth: 3, maxFilesPerFolder: 50 });
const files = await listFilesInFolder(drive, SOURCE_ID);

for (const f of files) {
  const local = await downloadTemp(drive, f);

  const { text: transcript, job } = await ocrViaGcsAuto(local, f.name); // PDF -> ocrPdfViaGCS, Image -> ocrImageViaGCS

  const proposal = await chooseDestinationWithAI({
    transcript,
    originalName: f.name,
    inventoryText: inventory.asText
  }); // nutzt prompts/openai_prompt.md

  const year = proposal.year || deriveYearFrom(transcript) || currentYear();
  const sub  = proposal.subfolder || 'Sonstiges';
  const newName = sanitizeToKeepExt(proposal.new_filename, f.name);

  const plan = {
    ensure: [
      `${year}`, `${year}/${sub}`, `${year}/${sub}/Scan`, `${year}/${sub}/Texttranskript`
    ],
    move: `${year}/${sub}/Scan/${newName}`,
    uploadTxt: `${year}/${sub}/Texttranskript/${basename(newName)}.txt`
  };

  if (DRY_RUN) {
    logPlan(f, plan, { exists: await checkExists(drive, TARGET_ID, plan.ensure) });
    continue;
  }

  const [yearId, subId, scanId, textId] = await ensureNestedPath(drive, TARGET_ID, [year, sub, 'Scan'], ['Texttranskript']);
  await uploadTranscript(drive, textId, basename(newName)+'.txt', transcript);
  await renameAndMove(drive, f, newName, scanId, SOURCE_ID);

  await cleanupGcsJob(job);
}

if (process.env.CLEAR_GCS_PREFIX_ON_EXIT === '1') {
  await deleteGcsPrefix(bucket, `${GCS_PREFIX}/`);
}
```

## Wichtige Details

- DRY_RUN gilt für alle schreibenden Operationen (Ordner anlegen, Update, Create, Move, Upload).
- LLM‑Robustheit: JSON streng parsen; wenn schief, Fallback via `pdfNaming.extractMetadataFromText()`.
- Jahr: Vorrang LLM; sonst Datum aus Transkript (`extractDateISO`); sonst aktuelles Jahr.
- Logausgabe: Klare, prüfbare Plan‑Blöcke je Datei.

