module.exports = async function (app) {
  const {
    listProfiles,
    saveProfile,
    setDefaultProfile,
    getDefaultProfileId,
  } = require('../../services/configStore');

  function requireOwner(req, reply) {
    const ownerHash = req.ownerHash;
    if (!ownerHash) {
      reply.code(401).send({ error: { code: 401, message: 'unauthorized' } });
      return null;
    }
    return ownerHash;
  }

  app.get('/me', async (req, reply) => {
    const ownerHash = requireOwner(req, reply);
    if (!ownerHash) return;
    try {
      const defaultProfileId = await getDefaultProfileId(ownerHash);
      return reply.send({ ownerHash, defaultProfileId: defaultProfileId || null });
    } catch (e) {
      req.log.error({ err: e }, 'me-failed');
      return reply.code(500).send({ error: { code: 500, message: 'internal', detail: e.message } });
    }
  });

  app.get('/profiles', async (req, reply) => {
    const ownerHash = requireOwner(req, reply);
    if (!ownerHash) return;
    try {
      const { items, defaultId } = await listProfiles(ownerHash);
      return reply.send({ items, defaultId: defaultId || null });
    } catch (e) {
      req.log.error({ err: e }, 'profiles-list-failed');
      return reply.code(500).send({ error: { code: 500, message: 'internal', detail: e.message } });
    }
  });

  app.post('/profiles', async (req, reply) => {
    const ownerHash = requireOwner(req, reply);
    if (!ownerHash) return;
    try {
      const body = req.body || {};
      const { label, sourceFolderId, targetRootFolderId, settings } = body;
      if (!label || !sourceFolderId || !targetRootFolderId) {
        return reply.code(422).send({ error: { code: 422, message: 'missing-fields' } });
      }
      const profile = await saveProfile({ ownerHash, profile: { id: body.id, label, sourceFolderId, targetRootFolderId, settings } });
      return reply.send({ ok: true, profile });
    } catch (e) {
      req.log.error({ err: e }, 'profiles-save-failed');
      return reply.code(500).send({ error: { code: 500, message: 'internal', detail: e.message } });
    }
  });

  app.put('/profiles/:id/default', async (req, reply) => {
    const ownerHash = requireOwner(req, reply);
    if (!ownerHash) return;
    try {
      const id = req.params.id;
      await setDefaultProfile(ownerHash, id);
      return reply.send({ ok: true, id });
    } catch (e) {
      req.log.error({ err: e }, 'profiles-set-default-failed');
      return reply.code(500).send({ error: { code: 500, message: 'internal', detail: e.message } });
    }
  });
};

