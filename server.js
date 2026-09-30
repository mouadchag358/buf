const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { PostStore } = require("./post-store");
const { SchedulerService } = require("./scheduler");
const { configuration: instagramConfiguration } = require('./instagram');
const {
  HOST,
  PORT,
  POSTS_FILE,
  IMAGE_LIBRARY_FILE,
  IMAGES_DIRECTORY,
  MAX_IMAGE_BYTES,
  GRAPH_API_VERSION
} = require("./config");

const PUBLIC_DIRECTORY = path.join(__dirname, "public");
const store = new PostStore(POSTS_FILE);
const scheduler = new SchedulerService({ store });

function readImageLibrary() {
  const items = JSON.parse(fs.readFileSync(IMAGE_LIBRARY_FILE, "utf8"));
  if (!Array.isArray(items)) throw new Error("image-library.json doit contenir un tableau.");
  return items.filter((item) => fs.existsSync(path.join(__dirname, item.image)));
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff"
};

const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/bmp", ".bmp"],
  ["image/tiff", ".tiff"]
]);

function imageSignatureMatches(type, buffer) {
  const hex = buffer.subarray(0, 8).toString("hex");
  if (type === "image/jpeg") return hex.startsWith("ffd8ff");
  if (type === "image/png") return hex === "89504e470d0a1a0a";
  if (type === "image/gif") return buffer.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/);
  if (type === "image/bmp") return buffer.subarray(0, 2).toString("ascii") === "BM";
  if (type === "image/tiff") return ["49492a00", "4d4d002a"].includes(hex.slice(0, 8));
  return false;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendFile(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "Fichier introuvable." });
    return;
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "content-length": fs.statSync(filePath).size,
    "x-content-type-options": "nosniff"
  });
  fs.createReadStream(filePath).pipe(response);
}

function readJson(request) {
  const limit = Math.ceil(MAX_IMAGE_BYTES * 1.45) + 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Requête trop volumineuse."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Corps JSON invalide."));
      }
    });
    request.on("error", reject);
  });
}

function assertText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Le texte de la publication est obligatoire.");
  }
  if (text.length > 63206) throw new Error("Le texte est trop long.");
}

function optionalScheduledAt(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("La date de programmation est invalide.");
  }
  return new Date(value).toISOString();
}

function saveUploadedImage(image) {
  if (!image || typeof image !== "object") throw new Error("Une image est obligatoire.");
  const extension = IMAGE_EXTENSIONS.get(image.type);
  if (!extension) throw new Error("Format non accepté. Utilisez JPEG, PNG, GIF, BMP ou TIFF.");
  if (typeof image.data !== "string" || image.data === "") throw new Error("Image vide.");
  const buffer = Buffer.from(image.data, "base64");
  if (!buffer.length) throw new Error("Image vide.");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("L'image dépasse la taille maximale autorisée.");
  if (!imageSignatureMatches(image.type, buffer)) throw new Error("Le contenu du fichier ne correspond pas à un format d'image accepté.");
  fs.mkdirSync(IMAGES_DIRECTORY, { recursive: true });
  const base = path.basename(image.name || "image", path.extname(image.name || ""))
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "image";
  const fileName = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${base}${extension}`;
  fs.writeFileSync(path.join(IMAGES_DIRECTORY, fileName), buffer, { flag: "wx" });
  return `images/${fileName}`;
}

function publicPost(post) {
  const relativeImage = post.image.replace(/\\/g, "/").replace(/^images\//, "");
  return {
    ...post,
    imageUrl: `/media/${relativeImage.split("/").map(encodeURIComponent).join("/")}`
  };
}

function publicLibraryItem(item) {
  return { ...item, imageUrl: publicPost(item).imageUrl };
}

function resolveLibraryImage(imagePath) {
  const item = readImageLibrary().find((entry) => entry.image === imagePath);
  if (!item) throw new Error("Image de bibliothèque invalide.");
  return item.image;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    const posts = store.read();
    sendJson(response, 200, {
      posts: posts.map(publicPost),
      library: readImageLibrary().map(publicLibraryItem),
      scheduler: scheduler.getStatus(),
      configuration: {
        graphApiVersion: GRAPH_API_VERSION,
        maxImageBytes: MAX_IMAGE_BYTES,
        facebookConfigured: Boolean(process.env.PAGE_ID && process.env.PAGE_ACCESS_TOKEN),
        instagram: instagramConfiguration()
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/posts") {
    const body = await readJson(request);
    assertText(body.text);
    const image = body.libraryImage
      ? resolveLibraryImage(body.libraryImage)
      : saveUploadedImage(body.image);
    try {
      const post = await store.add({
        text: body.text,
        image,
        scheduledAt: optionalScheduledAt(body.scheduledAt)
      });
      sendJson(response, 201, { post: publicPost(post) });
    } catch (error) {
      if (!body.libraryImage) fs.unlinkSync(path.join(__dirname, image));
      throw error;
    }
    return;
  }

  const match = url.pathname.match(/^\/api\/posts\/([^/]+)(?:\/(publish|reset))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];

    if (request.method === "PUT" && !action) {
      const body = await readJson(request);
      assertText(body.text);
      const changes = { text: body.text, scheduledAt: optionalScheduledAt(body.scheduledAt) };
      let uploadedImage;
      if (body.image) {
        uploadedImage = saveUploadedImage(body.image);
        changes.image = uploadedImage;
      }
      let post;
      try {
        post = await store.update(id, changes);
      } catch (error) {
        if (uploadedImage) fs.unlinkSync(path.join(__dirname, uploadedImage));
        throw error;
      }
      sendJson(response, 200, { post: publicPost(post) });
      return;
    }

    if (request.method === "DELETE" && !action) {
      const removed = await store.remove(id);
      sendJson(response, 200, { post: publicPost(removed) });
      return;
    }

    if (request.method === "POST" && action === "publish") {
      const result = await scheduler.publishNextPost(id);
      sendJson(response, 200, { result });
      return;
    }

    if (request.method === "POST" && action === "reset") {
      const post = await store.reset(id);
      sendJson(response, 200, { post: publicPost(post) });
      return;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/reorder") {
    const body = await readJson(request);
    await store.reorder(body.ids);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Route API introuvable." });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      const relativePath = decodeURIComponent(url.pathname.slice(7));
      const imagePath = path.resolve(IMAGES_DIRECTORY, relativePath);
      if (!imagePath.startsWith(`${IMAGES_DIRECTORY}${path.sep}`)) {
        sendJson(response, 403, { error: "Accès refusé." });
        return;
      }
      sendFile(response, imagePath);
      return;
    }
    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safePath = path.resolve(PUBLIC_DIRECTORY, relativePath);
    if (!safePath.startsWith(`${PUBLIC_DIRECTORY}${path.sep}`)) {
      sendJson(response, 403, { error: "Accès refusé." });
      return;
    }
    sendFile(response, safePath);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { error: error.message || String(error) });
    else response.end();
  }
});

function shutdown() {
  scheduler.stop();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

fs.mkdirSync(IMAGES_DIRECTORY, { recursive: true });
scheduler.start();
server.listen(PORT, HOST, () => {
  console.log(`Tableau de bord : http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  scheduler.stop();
  if (error.code === "EADDRINUSE") {
    console.error(`Le port ${PORT} est déjà utilisé. Fermez l'autre instance ou changez PORT dans .env.`);
  } else {
    console.error(`Impossible de démarrer le serveur : ${error.message}`);
  }
  process.exitCode = 1;
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { server, scheduler };
