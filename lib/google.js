const { google } = require('googleapis');

async function initDriveUsingADC() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const client = await auth.getClient();
  return google.drive({ version: 'v3', auth: client });
}

module.exports = { initDriveUsingADC };

