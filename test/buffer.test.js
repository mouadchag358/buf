const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BufferClient, BufferApiError, parseRateLimits } = require("../buffer-client");
const { BufferSync, isoFromLocal, validateMedia } = require("../buffer-sync");
const { PostStore } = require("../post-store");

// Future offsets can change when the runner updates its IANA time zone data.
// Verify the requested local time rather than freezing an assumed UTC offset.
function assertCasablancaNine(utcValue) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(utcValue)).map(({ type, value }) => [type, value]));
  assert.equal(utcValue.endsWith("Z"), true);
  assert.deepEqual(
    [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second],
    ["2026", "10", "03", "09", "00", "00"]
  );
}

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
  assert.equal(isoFromLocal("2025-10-03T09:00:00", "Africa/Casablanca"), "2025-10-03T08:00:00.000Z");
  assertCasablancaNine(isoFromLocal("2026-10-03T09:00:00", "Africa/Casablanca"));
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

test("le client transmet les métadonnées Facebook et Instagram avec une image", async () => {
  const requests = [];
  const client = new BufferClient({
    apiKey: "secret-test",
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response({ payload: { data: { createPost: { post: { id: "buffer-1", status: "scheduled" } } } } });
    }
  });
  for (const service of ["facebook", "instagram"]) {
    await client.createPost({ channelId: "channel-1", text: "Bonjour", imageUrl: "https://example.test/photo.jpg",
      dueAt: "2026-10-03T08:00:00.000Z", service });
  }
  assert.deepEqual(requests[0].variables.input.metadata, { facebook: { type: "post" } });
  assert.deepEqual(requests[1].variables.input.metadata, { instagram: { type: "post", shouldShareToFeed: true } });
  assert.deepEqual(requests[1].variables.input.assets, [{ image: { url: "https://example.test/photo.jpg" } }]);
  assert.equal(requests[1].variables.input.mode, "customScheduled");
});

test("un HTTP 429 arrête immédiatement les requêtes, même avec retry-after court", async () => {
  let calls = 0;
  const client = new BufferClient({ apiKey: "test", fetchImpl: async () => {
    calls += 1;
    return response({ status: 429, headers: { "retry-after": "1", ratelimit: '\"100-in-15min\";r=0;t=1' } });
  } });
  await assert.rejects(client.getOrganizations(), (error) => error.code === "RATE_LIMIT_EXCEEDED" && error.retryAfterSeconds === 1);
  await assert.rejects(client.getOrganizations(), (error) => error.code === "RATE_LIMIT_EXCEEDED");
  assert.equal(calls, 1);
});

test("une coupure pendant une mutation est marquée comme incertaine", async () => {
  const client = new BufferClient({
    apiKey: "secret-test",
    fetchImpl: async () => { throw new Error("coupure"); }
  });
  await assert.rejects(
    client.createPost({ service: "facebook", channelId: "channel-1", text: "Bonjour", imageUrl: "https://example.test/a.jpg" }),
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
  await assert.rejects(sync.run(), (error) => /incertain/.test(error.summaries[0].errors[0]));
  assert.equal(createCalls, 0);
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
  assertCasablancaNine(delivery.dueAt);
});

for (const failure of [null, "RATE_LIMIT_EXCEEDED", "MUTATION_ERROR"]) {
  test(`la synchronisation borne les tentatives et conserve les réussites (${failure})`, async (context) => {
    ignoreConfiguredChannels(context);
    const posts = Array.from({ length: 242 }, (_, id) => ({ id, text: `Post ${id}`, image: "https://example.test/a.jpg" }));
    const { directory, store } = temporaryStore(posts);
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    const services = [];
    const client = {
      lastRateLimits: [],
      getOrganizations: async () => [{ id: "org" }],
      getChannels: async () => [{ id: "fb", service: "facebook" }, { id: "ig", service: "instagram" }],
      getPosts: async () => [],
      createPost: async (input) => {
        calls += 1;
        services.push(input.service);
        if (failure && calls === 2) throw new BufferApiError("échec", { code: failure });
        assert.ok(["facebook", "instagram"].includes(input.service));
        return { id: `remote-${calls}`, status: "scheduled" };
      }
    };
    const sync = new BufferSync({ store, client, validate: async () => {}, maxAttempts: 5 });
    if (failure) await assert.rejects(sync.run(), /Synchronisation incomplète/);
    else await sync.run();
    assert.equal(calls, failure ? 2 : 5);
    assert.equal(store.read()[0].deliveries.facebook.bufferPostId, "remote-1");
    assert.equal(store.read()[failure ? 2 : 3].deliveries, undefined);
    if (!failure) assert.deepEqual(services, ["facebook", "facebook", "facebook", "instagram", "instagram"]);
  });
}

test("la réconciliation réutilise la liste distante sans requête par publication", async (context) => {
  ignoreConfiguredChannels(context);
  const { directory, store } = temporaryStore([{ id: "p", text: "Bonjour", image: "https://example.test/a.jpg",
    deliveries: { facebook: { status: "scheduled_in_buffer", bufferPostId: "remote" } } }]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = { lastRateLimits: [], getOrganizations: async () => [{ id: "org" }],
    getChannels: async () => [{ id: "fb", service: "facebook" }],
    getPosts: async () => [{ id: "remote", channelId: "fb", status: "sent" }],
    getPost: async () => { throw new Error("Requête inutile"); },
    createPost: async () => { throw new Error("Doublon"); } };
  await new BufferSync({ store, client }).run();
  assert.equal(store.read()[0].deliveries.facebook.status, "published");
});

for (const reason of ["full", "paused", "no-candidates"]) {
  test(`Instagram utilise les cinq tentatives quand Facebook est indisponible (${reason})`, async (context) => {
    ignoreConfiguredChannels(context);
    const posts = Array.from({ length: 6 }, (_, id) => ({ id, text: `Post ${id}`, image: "https://example.test/a.jpg",
      ...(reason === "no-candidates" ? { targetNetworks: ["instagram"] } : {}) }));
    const { directory, store } = temporaryStore(posts);
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const services = [];
    const client = { lastRateLimits: [], getOrganizations: async () => [{ id: "org" }],
      getChannels: async () => [{ id: "fb", service: "facebook", isQueuePaused: reason === "paused" }, { id: "ig", service: "instagram" }],
      getPosts: async () => reason === "full" ? Array.from({ length: 10 }, (_, id) => ({ id: `queued-${id}`, channelId: "fb", status: "scheduled" })) : [],
      createPost: async (input) => { services.push(input.service); return { id: `remote-${services.length}`, status: "scheduled" }; }
    };
    const sync = new BufferSync({ store, client, validate: async () => {}, maxAttempts: 5 });
    if (reason === "paused") await assert.rejects(sync.run(), /Synchronisation incomplète/);
    else await sync.run();
    assert.deepEqual(services, Array(5).fill("instagram"));
  });
}
