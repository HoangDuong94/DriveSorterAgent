// scripts/oauth_init.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');
require('dotenv').config();

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const tokenPath = process.env.GOOGLE_OAUTH_TOKEN_PATH || path.join(process.cwd(), '.oauth-token.json');
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET fehlen in .env');
  }

  const redirectUri = 'http://127.0.0.1:53682/callback';
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const scopes = ['https://www.googleapis.com/auth/drive'];

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });

  console.log('\nÖffne diesen Link im Browser und erteile Zugriff:\n', authUrl, '\n');

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url.startsWith('/callback')) {
        res.statusCode = 404; return res.end('Not found');
      }
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get('code');
      if (!code) { res.end('Kein Code'); return; }
      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
      res.end('Auth erfolgreich. Du kannst dieses Fenster schließen.');
      console.log(`\nToken gespeichert unter: ${tokenPath}\n`);
    } catch (e) {
      console.error('Token-Fehler:', e.message);
      res.statusCode = 500; res.end('Token-Fehler');
    } finally {
      setTimeout(() => server.close(), 500);
    }
  });

  server.listen(53682, () => console.log('Warte auf Callback http://127.0.0.1:53682/callback ...'));
}

main().catch(e => { console.error(e); process.exit(1); });

