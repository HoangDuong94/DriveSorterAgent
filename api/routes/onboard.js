const { extractId } = require('../../lib/id');
const { initDriveUsingADC } = require('../../lib/google');
const { buildTargetInventoryText } = require('../../src/utils/inventory');
const { loadConfig } = require('../../src/utils/config');

module.exports = async function (app) {
  // Resolve: id|url|name -> folder info + capabilities
  app.get('/resolve', async (req, reply) => {
    try {
      const q = (req.query && req.query.q) ? String(req.query.q) : '';
      if (!q) return reply.code(422).send({ error: { code: 422, message: 'missing-fields', detail: 'q' } });
      const drive = await initDriveUsingADC();

      async function getInfo(id) {
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
      }

      // Try ID or URL first
      const maybeId = extractId(q) || (/^[A-Za-z0-9_-]{15,}$/.test(q) ? q : null);
      if (maybeId) {
        try { return reply.send(await getInfo(maybeId)); } catch (_) { /* fallthrough to name */ }
      }

      // Fallback: search by name equals
      const res = await drive.files.list({
        q: `name = '${String(q).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)'
        ,includeItemsFromAllDrives: true, supportsAllDrives: true, pageSize: 1
      });
      const id = (res.data.files && res.data.files[0] && res.data.files[0].id) || null;
      if (!id) return reply.code(404).send({ error: { code: 404, message: 'not-found' } });
      return reply.send(await getInfo(id));
    } catch (e) {
      app.log.error({ err: e }, 'resolve-failed');
      return reply.code(500).send({ error: { code: 500, message: 'resolve-failed', detail: e.message } });
    }
  });

  // Target inventory preview (compact text)
  app.get('/target-inventory', async (req, reply) => {
    try {
      const targetRootId = (req.query && req.query.targetRootId) ? String(req.query.targetRootId) : '';
      if (!targetRootId) return reply.code(422).send({ error: { code: 422, message: 'missing-fields', detail: 'targetRootId' } });
      const drive = await initDriveUsingADC();
      const cfg = loadConfig();
      const inventoryText = await buildTargetInventoryText(
        drive, targetRootId, cfg,
        { depth: 3, recentYears: 3, maxFoldersPerLevel: 12, maxFilesPerFolder: 12, includeNonYearTop: true }
      );
      return reply.send({ ok: true, inventoryText });
    } catch (e) {
      app.log.error({ err: e }, 'target-inventory-failed');
      return reply.code(500).send({ error: { code: 500, message: 'inventory-failed', detail: e.message } });
    }
  });
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
      if (!bothOk) {
        let serviceIdentityEmail = process.env.SERVICE_IDENTITY_EMAIL || null;
        if (!serviceIdentityEmail) {
          try {
            const about = await drive.about.get({ fields: 'user(emailAddress)', supportsAllDrives: true });
            serviceIdentityEmail = about && about.data && about.data.user && about.data.user.emailAddress || null;
          } catch (_) { /* ignore */ }
        }
        const hint = serviceIdentityEmail ? {
          serviceIdentityEmail,
          action: "Bitten Sie den Ordner-Eigentümer, der obigen Identität 'Bearbeiten' zu gewähren."
        } : undefined;
        return reply.code(403).send({ ok: false, source: srcInfo, target: trgInfo, hint });
      }
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
