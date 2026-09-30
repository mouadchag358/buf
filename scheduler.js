const cron = require("node-cron");
const { publishPost } = require("./facebook");
const { PostStore } = require("./post-store");
const { InstagramPublisher, configuration: instagramConfiguration } = require('./instagram');
const { POSTS_FILE, CRON_SCHEDULE, TIME_ZONE } = require("./config");

function formatDate() {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: TIME_ZONE
  }).format(new Date());
}

function errorMessage(error) {
  if (error.response && error.response.data) {
    return JSON.stringify(error.response.data.error || error.response.data);
  }
  return error.message || String(error);
}

class SchedulerService {
  constructor({ store = new PostStore(POSTS_FILE), publisher = publishPost,
    instagramPublisher = new InstagramPublisher(),
    instagramEnabled = publisher === publishPost && instagramConfiguration().enabled } = {}) {
    this.store = store;
    this.publisher = publisher;
    this.instagramPublisher = instagramPublisher;
    this.instagramEnabled = instagramEnabled;
    this.task = null;
    this.scheduledTask = null;
    this.activePostId = null;
    this.lastRunAt = null;
    this.lastResult = null;
  }

  getStatus() {
    return {
      running: Boolean(this.task),
      publishing: this.activePostId !== null,
      activePostId: this.activePostId,
      schedule: CRON_SCHEDULE,
      timeZone: TIME_ZONE,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult
    };
  }

  async publishNextPost(id, options = {}) {
    const post = await this.store.claim(id, { ...options, targetNetworks: this.instagramEnabled ? ['facebook', 'instagram'] : ['facebook'] });

    if (!post) {
      const emptyResult = { status: "empty", at: new Date().toISOString() };
      if (!options.silentWhenEmpty) {
        this.lastRunAt = emptyResult.at;
        this.lastResult = emptyResult;
        console.log(`[${formatDate()}] Aucune publication en attente.`);
      }
      return emptyResult;
    }

    this.lastRunAt = new Date().toISOString();
    this.activePostId = post.id;
    console.log(`[${formatDate()}] Préparation du post ${post.id}.`);

    try {
      const errors = [];
      for (const network of post.targetNetworks) {
        const delivery = post.deliveries?.[network] || {};
        if (delivery.status === 'published' || (network === 'facebook' && post.facebookPostId)) continue;
        try {
          if (network === 'facebook') {
            if (['sending', 'unknown'].includes(delivery.status)) throw new Error('Facebook : résultat précédent incertain. Vérifiez la Page avant toute nouvelle tentative.');
            await this.store.recordDelivery(post.id, network, { status: 'sending' });
            let result;
            try { result = await this.publisher(post.text, post.image); }
            catch (error) {
              await this.store.recordDelivery(post.id, network, { status: error.response ? 'failed' : 'unknown' });
              throw error;
            }
            await this.store.recordDelivery(post.id, network, { ...result, raw: undefined, status: 'published', publishedAt: new Date().toISOString() });
          } else if (network === 'instagram') {
            const result = await this.instagramPublisher.publish(post.text, post.image, {
              delivery,
              save: changes => this.store.recordDelivery(post.id, network, changes)
            });
            await this.store.recordDelivery(post.id, network, { ...result, status: 'published', publishedAt: new Date().toISOString(), lastError: null });
          } else throw new Error(`Réseau inconnu : ${network}`);
        } catch (error) {
          const message = `${network} : ${errorMessage(error)}`;
          await this.store.recordDelivery(post.id, network, { lastError: message });
          errors.push(message);
        }
      }
      if (errors.length) throw new Error(errors.join(' | '));
      await this.store.complete(post.id, {});
      this.lastResult = { status: "published", postId: post.id, at: new Date().toISOString() };
      console.log(`[${formatDate()}] Le post ${post.id} a été enregistré comme publié.`);
      return this.lastResult;
    } catch (error) {
      try {
        await this.store.fail(post.id, new Error(errorMessage(error)));
      } catch (saveError) {
        console.error("Impossible d'enregistrer l'erreur dans posts.json :");
        console.error(errorMessage(saveError));
      }
      this.lastResult = {
        status: "failed",
        postId: post.id,
        error: errorMessage(error),
        at: new Date().toISOString()
      };
      console.error(`[${formatDate()}] Échec du post ${post.id} : ${errorMessage(error)}`);
      throw error;
    } finally {
      this.activePostId = null;
    }
  }

  start() {
    if (this.task) return;
    if (!cron.validate(CRON_SCHEDULE)) {
      throw new Error(`Expression cron invalide : ${CRON_SCHEDULE}`);
    }
    this.task = cron.schedule(
      CRON_SCHEDULE,
      () => this.publishNextPost().catch(() => {}),
      { timezone: TIME_ZONE }
    );
    this.scheduledTask = cron.schedule(
      "* * * * *",
      () => this.publishDuePosts().catch(() => {}),
      { timezone: TIME_ZONE }
    );
    console.log(`Planificateur actif : ${CRON_SCHEDULE} (${TIME_ZONE}).`);
  }

  stop() {
    if (!this.task) return;
    this.task.stop();
    this.task.destroy();
    this.task = null;
    if (this.scheduledTask) {
      this.scheduledTask.stop();
      this.scheduledTask.destroy();
      this.scheduledTask = null;
    }
  }

  async publishDuePosts() {
    while (true) {
      try {
        const result = await this.publishNextPost(undefined, { scheduledOnly: true, silentWhenEmpty: true });
        if (result.status === "empty") return;
      } catch {
        return;
      }
    }
  }
}

async function runCli() {
  const scheduler = new SchedulerService();
  if (process.argv.includes("--test")) {
    console.log("Publication immédiate du prochain post en attente.");
    try {
      await scheduler.publishNextPost();
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  scheduler.start();
  console.log("Laissez cette fenêtre ouverte pour conserver le bot actif.");
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`Erreur fatale : ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { SchedulerService, errorMessage };
