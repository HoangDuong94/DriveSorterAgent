require('dotenv').config();
const { Storage } = require('@google-cloud/storage');

async function run() {
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) throw new Error('GCS_BUCKET not configured');

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const out = { bucket: bucketName };
  try {
    const [metadata] = await bucket.getMetadata();
    out.exists = true;
    out.location = metadata.location || null;
    out.storageClass = metadata.storageClass || null;
    out.locationType = metadata.locationType || null;
    out.ubla = !!(metadata.iamConfiguration && metadata.iamConfiguration.uniformBucketLevelAccess && metadata.iamConfiguration.uniformBucketLevelAccess.enabled);
  } catch (e) {
    out.exists = false;
    out.error = `metadata-error: ${e.message}`;
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  // RW smoke test with current credentials
  const testObj = `tmp/bucket-health-${Date.now()}.txt`;
  try {
    await bucket.file(testObj).save('ok', { resumable: false, contentType: 'text/plain' });
    const [buf] = await bucket.file(testObj).download();
    out.rwTest = { wrote: true, read: buf.toString('utf8') };
  } catch (e) {
    out.rwTest = { wrote: false, error: e.message };
  } finally {
    try { await bucket.file(testObj).delete({ ignoreNotFound: true }); } catch {}
  }

  // Try to fetch IAM policy (may fail if caller lacks permission)
  try {
    const [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
    out.iamPolicyBindings = policy && policy.bindings ? policy.bindings : [];
  } catch (e) {
    out.iamPolicyError = e.message;
  }

  console.log(JSON.stringify(out, null, 2));
}

run().catch((e) => { console.error(e); process.exit(1); });

