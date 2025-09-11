const { extractId } = require('../../lib/id');
const { initDriveUsingADC } = require('../../lib/google');

module.exports = async function (app) {
  app.post('/share-check', async (req, reply) => {
    try {
      const body = req.body || {};
      const src = extractId(body.sourceFolder);
      const trg = extractId(body.targetRoot);
      if (!src || !trg) return reply.code(422).send({ error: { code: 422, message: 'invalid-ids' } });

      const drive = await initDriveUsingADC();
      async function check(id) {
        try {
          const r = await drive.files.get({
            fileId: id,
            fields: 'id,name,mimeType,capabilities(canEdit,canAddChildren)',
            supportsAllDrives: true,
          });
          const f = r.data;
          return {
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            canEdit: !!(f.capabilities && f.capabilities.canEdit),
            canAddChildren: !!(f.capabilities && f.capabilities.canAddChildren),
          };
        } catch (e) {
          const code = e.code || e.status || 500;
          return { id, error: code === 404 ? 'not-found' : code === 403 ? 'forbidden' : 'error', detail: e.message };
        }
      }

      const [srcInfo, trgInfo] = await Promise.all([check(src), check(trg)]);
      const bothOk = [srcInfo, trgInfo].every(x => !x.error && x.mimeType === 'application/vnd.google-apps.folder' && x.canEdit && x.canAddChildren);
      if (!bothOk) return reply.code(403).send({ ok: false, source: srcInfo, target: trgInfo });
      return reply.send({ ok: true, source: srcInfo, target: trgInfo });
    } catch (e) {
      app.log.error({ err: e }, 'share-check failed');
      return reply.code(500).send({ error: { code: 500, message: 'share-check-failed', detail: e.message } });
    }
  });

  app.post('/save-config', async (req, reply) => {
    try {
      const { email, sourceFolderId, targetRootFolderId } = req.body || {};
      if (!email || !sourceFolderId || !targetRootFolderId) {
        return reply.code(422).send({ error: { code: 422, message: 'missing-fields' } });
      }
      const { saveUserConfig } = require('../../services/configStore');
      const ref = await saveUserConfig({ email, sourceFolderId, targetRootFolderId });
      return reply.send({ ok: true, configRef: ref });
    } catch (e) {
      app.log.error({ err: e }, 'save-config failed');
      return reply.code(500).send({ error: { code: 500, message: 'save-config-failed', detail: e.message } });
    }
  });
};
