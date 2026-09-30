require('./config');
const axios = require('axios');
const { GRAPH_API_VERSION } = require('./config');
const { configuration } = require('./instagram');
async function main() {
  const config = configuration();
  console.log(`Identifiant et jeton présents : ${config.credentialsPresent ? 'oui' : 'non'}`);
  console.log(`URL publique des images configurée : ${config.mediaReady ? 'oui' : 'non'}`);
  if (!config.credentialsPresent) { process.exitCode = 1; return; }
  const host = process.env.INSTAGRAM_LOGIN_MODE === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  try {
    const response = await axios.get(`https://${host}/${GRAPH_API_VERSION}/${encodeURIComponent(process.env.INSTAGRAM_ACCOUNT_ID)}`, {
      params: { fields: 'id,username' },
      headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` },
      timeout: 15000
    });
    if (!response.data.id || !response.data.username) throw new Error('INVALID_ACCOUNT');
    console.log('Accès en lecture au compte Instagram confirmé. La publication et ses permissions restent à vérifier.');
  } catch (error) {
    const code = error.response?.data?.error?.code;
    console.error(`Vérification impossible${code ? ` (code Meta ${code})` : ` (${error.code || 'réponse inattendue'})`}. Aucun jeton affiché.`);
    process.exitCode = 1;
  }
}
main();
