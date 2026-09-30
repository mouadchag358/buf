const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PostStore, validatePosts } = require("../post-store");
const { SchedulerService } = require("../scheduler");

function temporaryStore(posts = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "facebook-bot-"));
  const file = path.join(directory, "posts.json");
  fs.writeFileSync(file, JSON.stringify(posts), "utf8");
  return { directory, store: new PostStore(file) };
}

test("validatePosts refuse les identifiants dupliqués", () => {
  assert.throws(
    () => validatePosts([
      { id: 1, text: "A", image: "images/a.jpg", published: false },
      { id: 1, text: "B", image: "images/b.jpg", published: false }
    ]),
    /dupliqué/
  );
});

test("la bibliothèque contient uniquement des visuels uniques et disponibles", () => {
  const library = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "image-library.json"), "utf8"));
  assert.equal(library.length, 15);
  assert.equal(new Set(library.map((item) => item.id)).size, library.length);
  for (const item of library) {
    assert.equal(fs.existsSync(path.join(__dirname, "..", item.image)), true, item.image);
    assert.ok(item.title);
    assert.ok(item.price);
    assert.ok(item.details.length > 0);
  }
});

test("la file ajoute, modifie et réordonne les publications", async (context) => {
  const { directory, store } = temporaryStore();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = await store.add({ text: "Première", image: "images/a.jpg" });
  const second = await store.add({ text: "Deuxième", image: "images/b.jpg" });
  await store.update(first.id, { text: "Première modifiée" });
  await store.reorder([second.id, first.id]);

  const posts = store.read();
  assert.equal(posts[0].id, second.id);
  assert.equal(posts[1].text, "Première modifiée");
});

test("le planificateur enregistre une publication réussie", async (context) => {
  const { directory, store } = temporaryStore([
    { id: "post-1", text: "Bonjour", image: "images/a.jpg", published: false }
  ]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scheduler = new SchedulerService({
    store,
    publisher: async () => ({ postId: "facebook-1", photoId: "photo-1" })
  });

  const result = await scheduler.publishNextPost();
  const [post] = store.read();
  assert.equal(result.status, "published");
  assert.equal(post.published, true);
  assert.equal(post.facebookPostId, "facebook-1");
  assert.equal(post.publishing, false);
});

test("le planificateur rend un post retentable après un échec", async (context) => {
  const { directory, store } = temporaryStore([
    { id: "post-2", text: "Bonjour", image: "images/a.jpg", published: false }
  ]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scheduler = new SchedulerService({
    store,
    publisher: async () => { throw new Error("Meta indisponible"); }
  });

  await assert.rejects(() => scheduler.publishNextPost(), /Meta indisponible/);
  const [post] = store.read();
  assert.equal(post.published, false);
  assert.equal(post.publishing, false);
  assert.match(post.lastError, /Meta indisponible/);
});

test("une publication réclamée ne peut pas être réclamée deux fois", async (context) => {
  const { directory, store } = temporaryStore([
    { id: "post-3", text: "Bonjour", image: "images/a.jpg", published: false }
  ]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await store.claim("post-3");
  await assert.rejects(() => store.claim("post-3"), /déjà en cours/);
});

test("une date future est ignorée et une date arrivée devient publiable", async (context) => {
  const { directory, store } = temporaryStore([
    { id: "future", text: "Plus tard", image: "images/a.jpg", published: false, scheduledAt: "2999-01-01T10:00:00.000Z" },
    { id: "daily", text: "File normale", image: "images/b.jpg", published: false },
    { id: "due", text: "Maintenant", image: "images/c.jpg", published: false, scheduledAt: "2020-01-01T10:00:00.000Z" }
  ]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const daily = await store.claim();
  const due = await store.claim(undefined, { scheduledOnly: true });
  assert.equal(daily.id, "daily");
  assert.equal(due.id, "due");
});
