const path = require("node:path");
const { PostStore } = require("./post-store");
const { BufferClient } = require("./buffer-client");
const {
  POSTS_FILE,
  TIME_ZONE,
  BUFFER_ORGANIZATION_ID,
  BUFFER_MAX_SCHEDULED,
  MAX_IMAGE_BYTES,
  PUBLIC_MEDIA_REPOSITORY,
  PUBLIC_MEDIA_REF
} = require("./config");

const SUPPORTED_SERVICES = new Set(["facebook", "instagram"]);

function isoFromLocal(value, timeZone = TIME_ZONE) {
  if (!value) return null;
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(value)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`Date invalide : ${value}`);
    return date.toISOString();
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) throw new Error(`Date locale invalide : ${value}`);
  const wanted = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0), +(match[7] || 0));
  let guess = wanted;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let index = 0; index < 3; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    guess += wanted - represented;
  }
  return new Date(guess).toISOString();
}

function encodePath(filePath) {
  return filePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

function mediaUrl(image, { repository = PUBLIC_MEDIA_REPOSITORY, ref = PUBLIC_MEDIA_REF } = {}) {
  if (/^https:\/\//i.test(image)) return image;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("PUBLIC_MEDIA_REPOSITORY doit valoir propriétaire/dépôt pour les images locales.");
  }
  const relative = path.relative(__dirname, path.resolve(__dirname, image));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Image hors du projet.");
  return `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(ref)}/${encodePath(relative)}`;
}

async function validateMedia(url, service, { fetchImpl = global.fetch, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Le média doit utiliser HTTPS.");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Range: "bytes=0-31", "User-Agent": "facebook-bot-buffer-check" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow"
    });
  } catch {
    throw new Error("Média inaccessible ou délai dépassé.");
  }
  if (!response.ok && response.status !== 206) throw new Error(`Média inaccessible (HTTP ${response.status}).`);
  const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!type.startsWith("image/")) throw new Error(`Type média non pris en charge : ${type || "inconnu"}.`);
  const allowed = service === "instagram"
    ? new Set(["image/jpeg", "image/png"])
    : new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  if (!allowed.has(type)) throw new Error(`${service} : format ${type} refusé par cette intégration.`);
  const contentRange = response.headers.get("content-range") || "";
  const rangeTotal = contentRange.match(/\/([0-9]+)$/)?.[1];
  const length = Number(rangeTotal || response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`Média trop volumineux (${length} octets).`);
  return { type, length: Number.isFinite(length) ? length : null };
}

function channelSelection(channels) {
  const explicit = new Set((process.env.BUFFER_CHANNEL_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
  const perService = {
    facebook: process.env.BUFFER_FACEBOOK_CHANNEL_ID,
    instagram: process.env.BUFFER_INSTAGRAM_CHANNEL_ID
  };
  return channels.filter((channel) => {
    if (!SUPPORTED_SERVICES.has(channel.service)) return false;
    if (channel.isDisconnected || channel.isLocked) return false;
    if (explicit.size && !explicit.has(channel.id)) return false;
    if (perService[channel.service] && perService[channel.service] !== channel.id) return false;
    return true;
  });
}

function targetServices(post, availableServices) {
  const requested = Array.isArray(post.targetNetworks) ? post.targetNetworks : ["facebook", "instagram"];
  return requested.filter((service) => SUPPORTED_SERVICES.has(service) && availableServices.has(service));
}

function matchesRemote(post, imageUrl, remote) {
  return remote.text === post.text && remote.assets?.some((asset) => asset.source === imageUrl);
}

function deliveryFromRemote(remote, channel, transferredAt) {
  const failed = remote.status === "error";
  return {
    status: remote.status === "sent" ? "published" : failed ? "failed_in_buffer" : "scheduled_in_buffer",
    bufferStatus: remote.status,
    bufferPostId: remote.id,
    channelId: channel.id,
    channel: channel.service,
    transferredAt,
    dueAt: remote.dueAt || null,
    publishedAt: remote.status === "sent" ? transferredAt : undefined,
    lastError: failed ? "Buffer indique que la publication a échoué." : null,
    lastErrorAt: failed ? transferredAt : null
  };
}

class BufferSync {
  constructor({
    store = new PostStore(POSTS_FILE),
    client = new BufferClient(),
    dryRun = false,
    now = () => new Date(),
    validate = validateMedia,
    maxScheduled = BUFFER_MAX_SCHEDULED
  } = {}) {
    this.store = store;
    this.client = client;
    this.dryRun = dryRun;
    this.now = now;
    this.validate = validate;
    this.maxScheduled = maxScheduled;
  }

  async saveDelivery(postId, service, changes) {
    if (!this.dryRun) await this.store.recordDelivery(postId, service, changes);
  }

  async organizationId() {
    if (BUFFER_ORGANIZATION_ID) return BUFFER_ORGANIZATION_ID;
    const organizations = await this.client.getOrganizations();
    if (organizations.length !== 1) {
      throw new Error("Définissez BUFFER_ORGANIZATION_ID (plusieurs organisations Buffer sont disponibles).");
    }
    return organizations[0].id;
  }

  async reconcileKnownDeliveries(posts) {
    for (const post of posts) {
      for (const [service, delivery] of Object.entries(post.deliveries || {})) {
        if (!delivery.bufferPostId || !["scheduled_in_buffer", "unknown"].includes(delivery.status)) continue;
        try {
          const remote = await this.client.getPost(delivery.bufferPostId);
          const checkedAt = this.now().toISOString();
          await this.saveDelivery(post.id, service, {
            bufferStatus: remote.status,
            status: remote.status === "sent" ? "published" : remote.status === "error" ? "failed_in_buffer" : delivery.status,
            publishedAt: remote.status === "sent" ? checkedAt : delivery.publishedAt,
            lastError: remote.status === "error" ? "Buffer indique que la publication a échoué." : delivery.lastError,
            lastErrorAt: remote.status === "error" ? checkedAt : delivery.lastErrorAt,
            lastCheckedAt: checkedAt
          });
        } catch (error) {
          await this.saveDelivery(post.id, service, { lastError: error.message, lastErrorAt: this.now().toISOString() });
        }
      }
    }
  }

  async run() {
    const organizationId = await this.organizationId();
    const allChannels = await this.client.getChannels(organizationId);
    const channels = channelSelection(allChannels);
    if (!channels.length) throw new Error("Aucun canal Facebook ou Instagram Buffer utilisable.");
    const posts = this.store.read();
    await this.reconcileKnownDeliveries(posts);

    const remotePosts = await this.client.getPosts(
      organizationId,
      channels.map((channel) => channel.id),
      ["scheduled", "sending", "sent", "error"]
    );
    const summaries = [];

    for (const channel of channels) {
      const queued = remotePosts.filter((post) => post.channelId === channel.id && ["scheduled", "sending"].includes(post.status));
      let available = Math.max(0, this.maxScheduled - queued.length);
      const summary = { channel: channel.service, channelId: channel.id, queued: queued.length, available, planned: 0, transferred: 0, errors: [] };
      summaries.push(summary);
      if (channel.isQueuePaused) summary.errors.push("La file Buffer est en pause.");
      if (!available) continue;

      for (const post of posts) {
        if (!available) break;
        const services = targetServices(post, new Set(channels.map((item) => item.service)));
        if (!services.includes(channel.service)) continue;
        const current = post.deliveries?.[channel.service];
        if (["scheduled_in_buffer", "published", "failed_in_buffer"].includes(current?.status)) continue;

        let imageUrl;
        try {
          imageUrl = mediaUrl(post.image);
          const dueAt = isoFromLocal(post.scheduledAt);
          if (dueAt && new Date(dueAt) <= this.now()) {
            const message = `Date dépassée (${dueAt}) : aucun envoi immédiat.`;
            await this.saveDelivery(post.id, channel.service, { status: "past_due", lastError: message, lastErrorAt: this.now().toISOString() });
            summary.errors.push(`${post.id}: ${message}`);
            continue;
          }

          // Réconciliation systématique : protège aussi si le précédent run a créé
          // le post puis a échoué avant de sauvegarder posts.json.
          const existing = remotePosts.find((remote) => remote.channelId === channel.id && matchesRemote(post, imageUrl, remote));
          if (existing) {
            await this.saveDelivery(post.id, channel.service, deliveryFromRemote(existing, channel, this.now().toISOString()));
            if (["scheduled", "sending"].includes(existing.status)) available -= 1;
            continue;
          }

          if (["unknown", "sending_to_buffer"].includes(current?.status)) {
            const message = "État Buffer incertain : vérifiez Buffer avant toute nouvelle tentative.";
            summary.errors.push(`${post.id}: ${message}`);
            continue;
          }

          await this.validate(imageUrl, channel.service);
          summary.planned += 1;
          if (this.dryRun) {
            console.log(`[DRY_RUN] ${post.id} -> ${channel.service} (${dueAt || "file Buffer"})`);
            available -= 1;
            continue;
          }
          await this.saveDelivery(post.id, channel.service, {
            status: "sending_to_buffer", channelId: channel.id, channel: channel.service,
            attemptedAt: this.now().toISOString(), imageUrl, lastError: null
          });
          try {
            const created = await this.client.createPost({ channelId: channel.id, text: post.text, imageUrl, dueAt });
            await this.saveDelivery(post.id, channel.service, deliveryFromRemote(created, channel, this.now().toISOString()));
            summary.transferred += 1;
            available -= 1;
          } catch (error) {
            await this.saveDelivery(post.id, channel.service, {
              status: error.uncertain ? "unknown" : "failed",
              lastError: error.message,
              lastErrorAt: this.now().toISOString(),
              reconciliationRequired: Boolean(error.uncertain)
            });
            summary.errors.push(`${post.id}: ${error.message}`);
          }
        } catch (error) {
          await this.saveDelivery(post.id, channel.service, {
            status: "failed", channelId: channel.id, channel: channel.service,
            lastError: error.message, lastErrorAt: this.now().toISOString()
          });
          summary.errors.push(`${post.id}: ${error.message}`);
        }
      }
      summary.available = available;
    }

    const lowQuota = this.client.lastRateLimits.filter((limit) => limit.remaining <= 10);
    if (lowQuota.length) console.warn(`Quota Buffer faible : ${lowQuota.map((item) => `${item.name}=${item.remaining}`).join(", ")}`);
    console.log(JSON.stringify({ dryRun: this.dryRun, organizationId, summaries }, null, 2));
    return summaries;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run") || /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
  await new BufferSync({ dryRun }).run();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Synchronisation Buffer impossible : ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BufferSync, isoFromLocal, mediaUrl, validateMedia, channelSelection,
  targetServices, matchesRemote, deliveryFromRemote
};
