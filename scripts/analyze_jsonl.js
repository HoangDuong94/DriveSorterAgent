#!/usr/bin/env node
const fs = require('fs');

const file = process.argv[2] || 'tmp/plans.jsonl';
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf-8').trim().split(/\r?\n/);

let warn = 0, info = 0;
const dist = { byYear: {}, bySub: {}, ocr: {}, dup: 0 };
const latencies = [];

function inc(map, key) { map[key] = (map[key]||0)+1; }

for (const line of lines) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }

  const plan = j.plan || {};
  const prop = j.proposal || {};
  const ocr = j.ocr_source || j.ocr_source || 'n/a';
  const llm = j.llm || {};
  const wf = String((plan.wouldMove || '').split('/')[0] || '');
  const sub = (prop.subfolder || prop.target_folder || 'Sonstiges');

  if (wf) inc(dist.byYear, wf);
  inc(dist.bySub, sub);
  inc(dist.ocr, ocr);
  if (llm.latency_ms) latencies.push(llm.latency_ms);

  // Warn: fehlende Pflichtfelder
  if (!plan.wouldMove) { console.log('WARN: missing wouldMove'); warn++; }

  // Year mismatch?
  if (prop.year && wf && String(prop.year) !== wf) {
    const sev = /steuern/i.test(sub) ? 'INFO' : 'WARN';
    if (sev === 'WARN') warn++; else info++;
    console.log(`${sev}: proposal.year=${prop.year} vs pathYear=${wf} for ${j.file?.name}`);
  }

  // Name-Date vs Folder-Year Check
  const m = (plan.wouldMove || '').match(/-(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?\.[a-z0-9]+$/i);
  if (m && wf && m[1] !== wf) {
    const sev = /steuern/i.test(sub) ? 'INFO' : 'WARN';
    if (sev === 'WARN') warn++; else info++;
    console.log(`${sev}: filename date=${m[0].slice(1)} vs pathYear=${wf} (${sub})`);
  }

  // Verdächtige 01-01
  if (m && m[2] === '01' && m[3] === '01') {
    console.log(`INFO: placeholder-like date -01-01 in ${plan.wouldMove}`);
    info++;
  }

  // Pflicht: ocr_source & llm.latency_ms (best effort)
  if (!j.ocr_source && !('ocr_source' in j)) { console.log('INFO: missing ocr_source'); info++; }
  if (!llm.latency_ms) { console.log('INFO: missing llm.latency_ms'); info++; }

  // Duplicate Marker
  if (j.duplicate_policy) dist.dup++;
}

const med = latencies.sort((a,b)=>a-b)[Math.floor(latencies.length/2)] || 0;
console.log('\nSummary:');
console.log('- Years:', dist.byYear);
console.log('- Subfolders:', dist.bySub);
console.log('- OCR Sources:', dist.ocr);
console.log(`- Duplicates: ${dist.dup}`);
console.log(`- LLM latency median: ${med} ms`);
console.log(`- WARN: ${warn}, INFO: ${info}`);

process.exit(0);

