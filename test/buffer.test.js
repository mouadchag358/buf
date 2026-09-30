const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BufferClient, BufferApiError, parseRateLimits } = require("../buffer-client");
const { BufferSync, isoFromLocal, validateMedia } = require("../buffer-sync");
const { PostStore } = require("../post-store");

function temporaryStore(posts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buffer-test-"));
  const file = path.join(directory, "posts.json");
  fs.writeFileSync(file, JSON.stringify(posts), "utf8");
  return { directory, store: new PostStore(file) };
}

function response({ status = 200, headers = {}, payload = {} } = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized.get(name.toLowerCase()) || null },
    json: async () => payload
  };
}

function ignoreConfiguredChannels(context) {
  const keys = ["BUFFER_CHANNEL_IDS", "BUFFER_FACEBOOK_CHANNEL_ID", "BUFFER_INSTAGRAM_CHANNEL_ID"];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  context.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("les dates locales de Casablanca sont converties en UTC", () => {
  assert.equal(isoFromLocal("2026-10-03T09:00:00", "Africa/Casablanca"), "2026-10-03T08:00:00.000Z");
  assert.equal(isoFromLocal("2026-10-03T09:00:00Z"), "2026-10-03T09:00:00.000Z");
});

test("la validation média utilise la taille totale d'une réponse partielle", async () => {
  const fetchImpl = async () => response({
    status: 206,
    headers: {
      "content-type": "image/jpeg",
      "content-length": "32",
      "content-range": "bytes 0-31/5000"
    }
  });
  await assert.rejects(
    validateMedia("https://example.test/photo.jpg", "instagram", { fetchImpl, maxBytes: 1000 }),
    /trop volumineux/
  );
});

test("le client Buffer retente un quota temporaire et transmet une image", async () => {
  const requests = [];
  let calls = 0;
  const client = new BufferClient({
    apiKey: "secret-test",
    sleep: async () => {},
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      calls += 1;
      if (calls === 1) return response({ status: 429, headers: { "retry-after": "1" } });
      return response({ payload: { data: { createPost: { post: { id: "buffer-1", status: "scheduled" } } } } });
    }
  });

  const created = await client.createPost({
    channelId: "channel-1",
    text: "Bonjour",
    imageUrl: "https://example.test/photo.jpg",
    dueAt: "2026-10-03T08:00:00.000Z"
  });
  assert.equal(created.id, "buffer-1");
  assert.equal(calls, 2);
  assert.deepEqual(requests[1].variables.input.assets, [{ image: { url: "https://example.test/photo.jpg" } }]);
  assert.equal(requests[1].variables.input.mode, "customScheduled");
});

test("une coupure pendant une mutation est marquée comme incertaine", async () => {
  const client = new BufferClient({
    apiKey: "secret-test",
    fetchImpl: async () => { throw new Error("coupure"); }
  });
  await assert.rejects(
    client.createPost({ channelId: "channel-1", text: "Bonjour", imageUrl: "https://example.test/a.jpg" }),
    (error) => error instanceof BufferApiError && error.uncertain === true
  );
});

test("les quotas Buffer sont décodés sans exposer la clé", () => {
  assert.deepEqual(parseRateLimits('"fifteen-minute";r=9;t=42, "daily";r=100;t=500'), [
    { name: "fifteen-minute", remaining: 9, resetsInSeconds: 42 },
    { name: "daily", remaining: 100, resetsInSeconds: 500 }
  ]);
});

test("la synchronisation ne duplique pas un envoi Buffer incertain", async (context) => {
  ignoreConfiguredChannels(context);
  const { directory, store } = temporaryStore([{
    id: "post-1",
    text: "Bonjour",
    image: "https://example.test/photo.jpg",
    scheduledAt: "2026-10-03T09:00:00",
    published: false,
    targetNetworks: ["facebook"],
    deliveries: { facebook: { status: "unknown" } }
  }]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let createCalls = 0;
  const client = {
    lastRateLimits: [],
    getOrganizations: async () => [{ id: "org-1" }],
    getChannels: async () => [{ id: "channel-1", service: "facebook" }],
    getPosts: async () => [],
    createPost: async () => { createCalls += 1; }
  };
  const sync = new BufferSync({
    store,
    client,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    validate: async () => {}
  });
  const [summary] = await sync.run();
  assert.equal(createCalls, 0);
  assert.match(summary.errors[0], /incertain/);
  assert.equal(store.read()[0].deliveries.facebook.status, "unknown");
});

test("la synchronisation crée puis mémorise un post Buffer", async (context) => {
  ignoreConfiguredChannels(context);
  const { directory, store } = temporaryStore([{
    id: "post-2",
    text: "Bonjour",
    image: "https://example.test/photo.jpg",
    scheduledAt: "2026-10-03T09:00:00",
    published: false,
    targetNetworks: ["instagram"]
  }]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = {
    lastRateLimits: [],
    getOrganizations: async () => [{ id: "org-1" }],
    getChannels: async () => [{ id: "channel-ig", service: "instagram" }],
    getPosts: async () => [],
    createPost: async (input) => ({ id: "buffer-2", channelId: input.channelId, status: "scheduled", dueAt: input.dueAt })
  };
  const sync = new BufferSync({
    store,
    client,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    validate: async () => {}
  });
  const [summary] = await sync.run();
  const delivery = store.read()[0].deliveries.instagram;
  assert.equal(summary.transferred, 1);
  assert.equal(delivery.status, "scheduled_in_buffer");
  assert.equal(delivery.bufferPostId, "buffer-2");
  assert.equal(delivery.dueAt, "2026-10-03T08:00:00.000Z");
});
