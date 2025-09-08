const path = require('path');

async function listFolders(drive, parentId, pageSize = 200) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize,
      pageToken
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

async function listFiles(drive, parentId, pageSize = 200) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize,
      pageToken
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

function isYearFolderName(name) {
  return /^\d{4}$/.test(String(name || '').trim());
}

function byNameAsc(a, b) { return a.name.localeCompare(b.name, 'de'); }
function byNameDesc(a, b) { return b.name.localeCompare(a.name, 'de'); }

async function buildTargetInventoryText(drive, rootId, cfg, opts = {}) {
  const {
    depth = 3,
    recentYears = 3,             // how many years per theme to show
    maxFoldersPerLevel = 12,     // how many themes at top level
    maxFilesPerFolder = 12,
    includeNonYearTop = true     // now: include non-theme top-level folders
  } = opts;

  const allowed = (cfg && Array.isArray(cfg.allowed_subfolders)) ? cfg.allowed_subfolders : [];
  const lines = [];

  // Top-level themes (Subfolders), then years inside theme
  const topFolders = await listFolders(drive, rootId);
  const themeTop = allowed.length
    ? topFolders.filter(f => allowed.includes(f.name))
    : topFolders.filter(f => !isYearFolderName(f.name));
  const nonThemeTop = topFolders.filter(f => !themeTop.find(t => t.id === f.id));

  // Sort themes by allowed order, then alpha
  themeTop.sort((a, b) => {
    if (!allowed.length) return byNameAsc(a, b);
    const ai = allowed.indexOf(a.name);
    const bi = allowed.indexOf(b.name);
    const aa = ai === -1 ? 999 : ai;
    const bb = bi === -1 ? 999 : bi;
    if (aa !== bb) return aa - bb;
    return a.name.localeCompare(b.name, 'de');
  });

  const themesPicked = themeTop.slice(0, maxFoldersPerLevel);
  if (themeTop.length > themesPicked.length) {
    const omitted = themeTop.length - themesPicked.length;
    // Header note could be added; keep concise for prompt
  }

  for (const tf of themesPicked) {
    lines.push(`${tf.name}/`);
    // Under each theme, list years (folders named YYYY)
    let yearFolders = await listFolders(drive, tf.id);
    yearFolders = yearFolders.filter(y => isYearFolderName(y.name));
    yearFolders.sort(byNameDesc);
    const yearsPicked = yearFolders.slice(0, Math.max(1, recentYears));
    for (const yf of yearsPicked) {
      lines.push(`  ${tf.name}/${yf.name}/`);
      // Try to find Scan folder and list sample files
      const children = await listFolders(drive, yf.id);
      const scan = children.find(c => c.name === 'Scan');
      if (scan) {
        let files = await listFiles(drive, scan.id);
        files.sort(byNameAsc);
        const extra = Math.max(0, files.length - maxFilesPerFolder);
        files = files.slice(0, maxFilesPerFolder);
        for (const f of files) lines.push(`  - ${f.name}`);
        if (extra > 0) lines.push(`  - ... (+${extra} more files)`);
      } else {
        lines.push('  - (Scan leer)');
      }
    }
  }

  if (includeNonYearTop && nonThemeTop.length) {
    lines.push(`(other)`);
    nonThemeTop.sort(byNameAsc);
    const trimmed = nonThemeTop.slice(0, Math.max(0, maxFoldersPerLevel - themesPicked.length));
    for (const ofo of trimmed) {
      lines.push(`${ofo.name}/`);
      let files = await listFiles(drive, ofo.id);
      files.sort(byNameAsc);
      const extra = Math.max(0, files.length - maxFilesPerFolder);
      files = files.slice(0, maxFilesPerFolder);
      for (const f of files) lines.push(`- ${f.name}`);
      if (extra > 0) lines.push(`- ... (+${extra} more files)`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  buildTargetInventoryText,
  listFolders,
  listFiles,
  isYearFolderName
};
