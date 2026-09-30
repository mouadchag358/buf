const fs = require("node:fs");

const LOCK_RETRY_MS = 50;
const LOCK_ATTEMPTS = 100;
const STALE_LOCK_MS = 30_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validatePosts(posts) {
  if (!Array.isArray(posts)) throw new Error("posts.json doit contenir un tableau JSON.");
  const ids = new Set();
  posts.forEach((post, index) => {
    const label = `Publication ${index + 1}`;
    if (!post || typeof post !== "object" || Array.isArray(post)) throw new Error(`${label} : objet JSON attendu.`);
    if (!["string", "number"].includes(typeof post.id) || String(post.id).trim() === "") {
      throw new Error(`${label} : identifiant manquant ou invalide.`);
    }
    if (ids.has(String(post.id))) throw new Error(`${label} : identifiant dupliqué (${post.id}).`);
    ids.add(String(post.id));
    if (typeof post.text !== "string" || post.text.trim() === "") throw new Error(`${label} : texte vide.`);
    if (typeof post.image !== "string" || post.image.trim() === "") throw new Error(`${label} : chemin d'image vide.`);
    if (post.scheduledAt && Number.isNaN(Date.parse(post.scheduledAt))) throw new Error(`${label} : date invalide.`);
  });
  return posts;
}

class PostStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.localQueue = Promise.resolve();
  }

  read() {
    if (!fs.existsSync(this.filePath)) throw new Error(`Fichier introuvable : ${this.filePath}`);
    return validatePosts(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  write(posts) {
    validatePosts(posts);
    const temporaryFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify(posts, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryFile, this.filePath);
  }

  async acquireFileLock() {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        const descriptor = fs.openSync(this.lockPath, "wx");
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        return descriptor;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(this.lockPath).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(this.lockPath);
        } catch (lockError) {
          if (lockError.code !== "ENOENT") throw lockError;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new Error("Le fichier des publications est occupé.");
  }

  async transaction(callback) {
    const execute = async () => {
      const descriptor = await this.acquireFileLock();
      try {
        const posts = this.read();
        const result = await callback(posts);
        this.write(posts);
        return result;
      } finally {
        fs.closeSync(descriptor);
        try {
          fs.unlinkSync(this.lockPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    };
    const operation = this.localQueue.then(execute, execute);
    this.localQueue = operation.catch(() => {});
    return operation;
  }

  async recordDelivery(id, network, changes) {
    return this.transaction((posts) => {
      const post = this.find(posts, id);
      post.deliveries ||= {};
      post.deliveries[network] = { ...post.deliveries[network], ...changes };
      return post.deliveries[network];
    });
  }

  find(posts, id) {
    const post = posts.find((item) => String(item.id) === String(id));
    if (!post) throw new Error("Publication introuvable.");
    return post;
  }
}

module.exports = { PostStore, validatePosts };
