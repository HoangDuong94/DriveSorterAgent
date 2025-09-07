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
    recentYears = 3,
    maxFoldersPerLevel = 12,
    maxFilesPerFolder = 12,
    includeNonYearTop = true
  } = opts;

  const allowed = (cfg && Array.isArray(cfg.allowed_subfolders)) ? cfg.allowed_subfolders : null;
  const lines = [];

  const topFolders = await listFolders(drive, rootId);
  const yearFolders = topFolders.filter(f => isYearFolderName(f.name));
  const otherTop = topFolders.filter(f => !isYearFolderName(f.name));

  yearFolders.sort(byNameDesc);
  const yearsPicked = yearFolders.slice(0, Math.max(1, recentYears));

  for (const yf of yearsPicked) {
    lines.push(`${yf.name}/`);
    let yearSubs = await listFolders(drive, yf.id);
    if (allowed && allowed.length) {
      yearSubs.sort((a, b) => {
        const ai = allowed.indexOf(a.name);
        const bi = allowed.indexOf(b.name);
        const aa = ai === -1 ? 999 : ai;
        const bb = bi === -1 ? 999 : bi;
        if (aa !== bb) return aa - bb;
        return a.name.localeCompare(b.name, 'de');
      });
    } else {
      yearSubs.sort(byNameAsc);
    }
    if (yearSubs.length > maxFoldersPerLevel) {
      const omitted = yearSubs.length - maxFoldersPerLevel;
      yearSubs = yearSubs.slice(0, maxFoldersPerLevel);
      lines.push(`  ... (+${omitted} more subfolders omitted)`);
    }
    for (const sf of yearSubs) {
      lines.push(`  ${yf.name}/${sf.name}/`);
      let files = await listFiles(drive, sf.id);
      files.sort(byNameAsc);
      const extra = Math.max(0, files.length - maxFilesPerFolder);
      files = files.slice(0, maxFilesPerFolder);
      for (const f of files) lines.push(`  - ${f.name}`);
      if (extra > 0) lines.push(`  - ... (+${extra} more files)`);
    }
  }

  if (includeNonYearTop && otherTop.length) {
    lines.push(`(non-year)`);
    otherTop.sort(byNameAsc);
    const trimmed = otherTop.slice(0, Math.max(0, maxFoldersPerLevel - yearsPicked.length));
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

