const axios = require('axios');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { GRAPH_API_VERSION, IMAGES_DIRECTORY } = require('./config');

function configuration() {
  const enabled = Boolean(process.env.INSTAGRAM_ACCOUNT_ID || process.env.INSTAGRAM_ACCESS_TOKEN);
  let mediaReady = false;
  try {
    const url = new URL(process.env.INSTAGRAM_MEDIA_BASE_URL);
    mediaReady = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {}
  return { enabled, credentialsPresent: Boolean(process.env.INSTAGRAM_ACCOUNT_ID && process.env.INSTAGRAM_ACCESS_TOKEN), mediaReady };
}

async function prepareImage(imagePath) {
  const sharp = require('sharp');
  const source = path.resolve(__dirname, imagePath);
  if (!source.startsWith(`${IMAGES_DIRECTORY}${path.sep}`)) throw new Error('Image Instagram hors du dossier images.');
  const input = await fs.readFile(source);
  const name = `${crypto.createHash('sha256').update(input).digest('hex')}.jpg`;
  const directory = path.join(IMAGES_DIRECTORY, 'instagram');
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, name);
  await sharp(input).rotate().resize(1080, 1080, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toFile(output);
  return name;
}

class InstagramPublisher {
  constructor({ client = axios, prepare = prepareImage, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.client = client;
    this.prepare = prepare;
    this.sleep = sleep;
  }

  async publish(text, imagePath, { delivery = {}, save = async () => {} } = {}) {
    const config = configuration();
    if (!config.credentialsPresent) throw new Error('Identifiant ou jeton Instagram manquant dans .env.');
    if (!config.mediaReady) throw new Error('Instagram : configurez INSTAGRAM_MEDIA_BASE_URL avec une URL HTTPS publique vers les JPEG préparés.');
    if ([...text].length > 2200) throw new Error('Instagram : légende limitée à 2 200 caractères.');
    const host = process.env.INSTAGRAM_LOGIN_MODE === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
    const root = `https://${host}/${GRAPH_API_VERSION}`;
    const account = encodeURIComponent(process.env.INSTAGRAM_ACCOUNT_ID);
    const options = { headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` }, timeout: 60000 };
    let containerId = delivery.containerId;
    try {
      if (!containerId) {
        const name = await this.prepare(imagePath);
        const imageUrl = `${process.env.INSTAGRAM_MEDIA_BASE_URL.replace(/\/$/, '')}/${name}`;
        const response = await this.client.post(`${root}/${account}/media`, new URLSearchParams({ image_url: imageUrl, caption: text }), options);
        containerId = response.data.id;
        if (!containerId) throw new Error('Aucun identifiant de conteneur Instagram reçu.');
        await save({ containerId, status: 'prepared' });
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await this.client.get(`${root}/${encodeURIComponent(containerId)}`, { ...options, params: { fields: 'status_code' } });
        const status = response.data.status_code;
        if (status === 'PUBLISHED') return { containerId, status: 'published' };
        if (delivery.status === 'sending') throw new Error('Instagram : résultat précédent incertain. Vérifiez le compte avant toute nouvelle tentative.');
        if (status === 'FINISHED') break;
        if (['ERROR', 'EXPIRED'].includes(status)) {
          await save({ containerId: null, status: 'failed' });
          throw new Error(`Conteneur Instagram ${status}.`);
        }
        if (attempt === 4) throw new Error('Image Instagram encore en préparation ; réessayez plus tard.');
        await this.sleep(60000);
      }
      await save({ containerId, status: 'sending' });
      const result = await this.client.post(`${root}/${account}/media_publish`, new URLSearchParams({ creation_id: containerId }), options);
      if (!result.data.id) throw new Error('Publication Instagram sans identifiant ; vérification nécessaire.');
      return { mediaId: String(result.data.id), containerId, status: 'published' };
    } catch (error) {
      // Ne jamais propager l'objet Axios : il contient le jeton dans les en-têtes.
      const code = error.response?.data?.error?.code;
      const message = error.isAxiosError ? `Requête Instagram échouée${code ? ` (code Meta ${code})` : ''}.` : error.message;
      throw new Error(message);
    }
  }
}

module.exports = { InstagramPublisher, configuration, prepareImage };
