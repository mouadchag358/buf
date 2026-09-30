const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PostStore, validatePosts } = require("../post-store");

function temporaryStore(posts = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buffer-store-"));
  const file = path.join(directory, "posts.json");
  fs.writeFileSync(file, JSON.stringify(posts), "utf8");
  return { directory, store: new PostStore(file) };
}

test("validatePosts refuse les identifiants dupliqués", () => {
  assert.throws(
    () => validatePosts([
      { id: 1, text: "A", image: "images/a.jpg" },
      { id: 1, text: "B", image: "images/b.jpg" }
    ]),
    /dupliqué/
  );
});

test("une livraison Buffer est fusionnée et conservée", async (context) => {
  const { directory, store } = temporaryStore([
    { id: "post-1", text: "Bonjour", image: "images/a.jpg" }
  ]);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await store.recordDelivery("post-1", "facebook", { status: "sending_to_buffer", channelId: "channel-1" });
  await store.recordDelivery("post-1", "facebook", { status: "scheduled_in_buffer", bufferPostId: "buffer-1" });
  assert.deepEqual(store.read()[0].deliveries.facebook, {
    status: "scheduled_in_buffer",
    channelId: "channel-1",
    bufferPostId: "buffer-1"
  });
});
