// Charge PAGE_ID et PAGE_ACCESS_TOKEN depuis le fichier .env.
require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const { GRAPH_API_VERSION, TIME_ZONE } = require("./config");

function formatDate() {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: TIME_ZONE
  }).format(new Date());
}

function getReadableError(error) {
  // Les erreurs Graph API se trouvent généralement dans error.response.data.
  if (error.response && error.response.data) {
    const apiError = error.response.data.error || error.response.data;
    return JSON.stringify(apiError, null, 2);
  }

  return error.message || String(error);
}

/**
 * Publie une image accompagnée d'une légende sur une Page Facebook.
 *
 * @param {string} text Texte qui accompagnera l'image.
 * @param {string} imagePath Chemin absolu ou relatif au dossier du projet.
 * @returns {Promise<{postId: string, photoId: string, raw: object}>}
 */
async function publishPost(text, imagePath) {
  const pageId = process.env.PAGE_ID;
  const pageAccessToken = process.env.PAGE_ACCESS_TOKEN;

  if (!pageId || !pageAccessToken) {
    throw new Error(
      "Configuration manquante : remplissez PAGE_ID et PAGE_ACCESS_TOKEN dans le fichier .env."
    );
  }

  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Le texte de la publication est vide.");
  }

  if (typeof imagePath !== "string" || imagePath.trim() === "") {
    throw new Error("Le chemin de l'image est vide.");
  }

  const absoluteImagePath = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(__dirname, imagePath);

  if (!fs.existsSync(absoluteImagePath)) {
    throw new Error(`Image introuvable : ${absoluteImagePath}`);
  }

  if (!fs.statSync(absoluteImagePath).isFile()) {
    throw new Error(`Le chemin indiqué n'est pas un fichier : ${absoluteImagePath}`);
  }

  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/photos`;
  const form = new FormData();

  form.append("caption", text.trim());
  form.append("source", fs.createReadStream(absoluteImagePath));
  form.append("access_token", pageAccessToken);

  console.log(`[${formatDate()}] Envoi de l'image à la Page Facebook...`);

  try {
    const response = await axios.post(endpoint, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 60_000
    });

    // Meta retourne normalement l'identifiant de la photo et peut aussi
    // retourner post_id, l'identifiant de la publication visible sur la Page.
    const photoId = String(response.data.id || "");
    const postId = String(response.data.post_id || response.data.id || "");

    if (!postId) {
      throw new Error(
        `Meta n'a retourné aucun identifiant : ${JSON.stringify(response.data)}`
      );
    }

    console.log(`[${formatDate()}] Publication réussie.`);
    console.log(`ID de la publication Facebook : ${postId}`);
    if (photoId && photoId !== postId) {
      console.log(`ID de la photo Facebook : ${photoId}`);
    }

    return { postId, photoId, raw: response.data };
  } catch (error) {
    console.error(`[${formatDate()}] Échec de la publication Facebook.`);
    console.error(getReadableError(error));
    throw error;
  }
}

module.exports = { publishPost };
