const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOCK_RETRY_MS = 50;
const LOCK_ATTEMPTS = 100;
const STALE_LOCK_MS = 30_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validatePosts(posts) {
  if (!Array.isArray(posts)) {
    throw new Error("posts.json doit contenir un tableau JSON.");
  }

  const ids = new Set();
  posts.forEach((post, index) => {
    const label = `Publication ${index + 1}`;
    if (!post || typeof post !== "object" || Array.isArray(post)) {
      throw new Error(`${label} : objet JSON attendu.`);
    }
    if (!["string", "number"].includes(typeof post.id) || String(post.id).trim() === "") {
      throw new Error(`${label} : identifiant manquant ou invalide.`);
    }
    if (ids.has(String(post.id))) {
      throw new Error(`${label} : identifiant dupliqué (${post.id}).`);
    }
    ids.add(String(post.id));
    if (typeof post.text !== "string" || post.text.trim() === "") {
      throw new Error(`${label} : texte vide.`);
    }
    if (typeof post.image !== "string" || post.image.trim() === "") {
      throw new Error(`${label} : chemin d'image vide.`);
    }
    if (typeof post.published !== "boolean") {
      throw new Error(`${label} : published doit être true ou false.`);
    }
    if (post.publishing !== undefined && typeof post.publishing !== "boolean") {
      throw new Error(`${label} : publishing doit être true ou false.`);
    }
    if (post.scheduledAt !== undefined && post.scheduledAt !== null) {
      if (typeof post.scheduledAt !== "string" || Number.isNaN(Date.parse(post.scheduledAt))) {
        throw new Error(`${label} : date de programmation invalide.`);
      }
    }
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
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`Fichier introuvable : ${this.filePath}`);
    }
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
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > STALE_LOCK_MS) fs.unlinkSync(this.lockPath);
        } catch (lockError) {
          if (lockError.code !== "ENOENT") throw lockError;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new Error("La file des publications est occupée. Réessayez dans quelques secondes.");
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

  async add({ text, image, scheduledAt }) {
    return this.transaction((posts) => {
      const post = {
        id: crypto.randomUUID(),
        text: text.trim(),
        image,
        published: false,
        createdAt: new Date().toISOString()
      };
      if (scheduledAt) post.scheduledAt = scheduledAt;
      posts.push(post);
      return post;
    });
  }

  async update(id, changes) {
    return this.transaction((posts) => {
      const post = this.find(posts, id);
      if (post.publishing) throw new Error("Impossible de modifier une publication en cours.");
      if (changes.text !== undefined) post.text = changes.text.trim();
      if (changes.image !== undefined) post.image = changes.image;
      if (changes.scheduledAt) post.scheduledAt = changes.scheduledAt;
      else if (changes.scheduledAt === null) delete post.scheduledAt;
      post.updatedAt = new Date().toISOString();
      return post;
    });
  }

  async remove(id) {
    return this.transaction((posts) => {
      const index = posts.findIndex((post) => String(post.id) === String(id));
      if (index === -1) throw new Error("Publication introuvable.");
      if (posts[index].publishing) throw new Error("Impossible de supprimer une publication en cours.");
      return posts.splice(index, 1)[0];
    });
  }

  async reorder(ids) {
    return this.transaction((posts) => {
      if (!Array.isArray(ids) || ids.length !== posts.length) {
        throw new Error("La nouvelle liste doit contenir toutes les publications.");
      }
      const byId = new Map(posts.map((post) => [String(post.id), post]));
      const reordered = ids.map((id) => byId.get(String(id)));
      if (reordered.some((post) => !post) || new Set(ids.map(String)).size !== posts.length) {
        throw new Error("Ordre de publications invalide.");
      }
      posts.splice(0, posts.length, ...reordered);
      return posts;
    });
  }

  async claim(id, { scheduledOnly = false, targetNetworks = ['facebook'] } = {}) {
    return this.transaction((posts) => {
      const post = id === undefined
        ? posts.find((item) => {
          if (item.published !== false || item.publishing === true) return false;
          if (scheduledOnly) return Boolean(item.scheduledAt) && Date.parse(item.scheduledAt) <= Date.now();
          return !item.scheduledAt || Date.parse(item.scheduledAt) <= Date.now();
        })
        : this.find(posts, id);
      if (!post) return null;
      if (post.published) throw new Error("Cette publication a déjà été envoyée.");
      if (post.publishing) throw new Error("Cette publication est déjà en cours.");
      if (!post.targetNetworks) post.targetNetworks = targetNetworks;
      post.publishing = true;
      post.lastAttemptAt = new Date().toISOString();
      return { ...post };
    });
  }

  async complete(id, result) {
    return this.transaction((posts) => {
      const post = this.find(posts, id);
      post.published = true;
      post.publishing = false;
      post.publishedAt = new Date().toISOString();
      if (result.postId) post.facebookPostId = result.postId;
      if (result.photoId) post.facebookPhotoId = result.photoId;
      delete post.lastError;
      delete post.lastErrorAt;
      return post;
    });
  }

  async fail(id, error) {
    return this.transaction((posts) => {
      const post = this.find(posts, id);
      post.publishing = false;
      post.lastError = error.message || String(error);
      post.lastErrorAt = new Date().toISOString();
      return post;
    });
  }

  async recordDelivery(id, network, changes) {
    return this.transaction(posts => {
      const post = this.find(posts, id);
      post.deliveries ||= {};
      post.deliveries[network] = { ...post.deliveries[network], ...changes };
      if (network === 'facebook' && changes.postId) post.facebookPostId = changes.postId;
      if (network === 'facebook' && changes.photoId) post.facebookPhotoId = changes.photoId;
      if (network === 'instagram' && changes.mediaId) post.instagramMediaId = changes.mediaId;
    });
  }

  async reset(id) {
    return this.transaction((posts) => {
      const post = this.find(posts, id);
      if (post.publishing && post.lastAttemptAt) {
        const age = Date.now() - new Date(post.lastAttemptAt).getTime();
        if (Number.isFinite(age) && age < 90_000) {
          throw new Error("Cette publication est encore en cours. Attendez au moins 90 secondes.");
        }
      }
      post.publishing = false;
      post.published = false;
      post.recoveredAt = new Date().toISOString();
      return post;
    });
  }

  find(posts, id) {
    const post = posts.find((item) => String(item.id) === String(id));
    if (!post) throw new Error("Publication introuvable.");
    return post;
  }
}

module.exports = { PostStore, validatePosts };
