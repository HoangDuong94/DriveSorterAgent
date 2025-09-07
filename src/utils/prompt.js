function buildPrompt(base, opts = {}) {
  const {
    allowedSubfolders = [],
    allowNewSubfolders = false,
    knownInstitutions = [],
    disallowedTerms = []
  } = opts;

  const allowedList = allowedSubfolders.map(s => `- ${s}`).join('\n');
  const guard = [
    'Allowed subfolders (canonical):',
    allowedList,
    '',
    `allow_new_subfolders = ${allowNewSubfolders ? 'true' : 'false'}`,
    '',
    (knownInstitutions.length ? `Known institutions: ${knownInstitutions.join(', ')}` : ''),
    (disallowedTerms.length ? `Do not include these names in filenames: ${disallowedTerms.join(', ')}` : ''),
    '',
    'Choose subfolder strictly from the allowed list. If none fits and allow_new_subfolders=false, select the closest existing folder. Do not invent new folder names.'
  ].filter(Boolean).join('\n');

  return `${(base||'').trim()}\n\n${guard}`;
}

module.exports = { buildPrompt };

