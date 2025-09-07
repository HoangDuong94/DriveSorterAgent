const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hashText(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex');
}

async function appendJSONL(filePath, obj) {
  if (!filePath) return;
  const p = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.appendFile(p, JSON.stringify(obj) + '\n', 'utf-8');
}

module.exports = { hashText, appendJSONL };

