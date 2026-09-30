const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PostStore } = require('../post-store');
const { SchedulerService } = require('../scheduler');
const { InstagramPublisher } = require('../instagram');

test('une reprise Instagram ne republie pas sur Facebook', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'posts.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'one', text: 'Bonjour', image: 'images/a.jpg', published: false }]));
  const store = new PostStore(file);
  let facebookCalls = 0;
  let instagramCalls = 0;
  const scheduler = new SchedulerService({ store, instagramEnabled: true,
    publisher: async () => { facebookCalls++; return { postId: 'fb' }; },
    instagramPublisher: { publish: async () => { if (++instagramCalls === 1) throw new Error('Image inaccessible'); return { mediaId: 'ig' }; } }
  });
  await assert.rejects(scheduler.publishNextPost(), /Image inaccessible/);
  assert.equal(store.read()[0].deliveries.facebook.status, 'published');
  assert.equal(store.read()[0].published, false);
  await scheduler.publishNextPost();
  assert.equal(facebookCalls, 1);
  assert.equal(instagramCalls, 2);
  assert.equal(store.read()[0].published, true);
  assert.equal(store.read()[0].instagramMediaId, 'ig');
});

test('Instagram fonctionne malgré un échec Facebook et ne sera pas renvoyé', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'posts.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'one', text: 'Bonjour', image: 'images/a.jpg', published: false }]));
  const store = new PostStore(file);
  let calls = 0;
  const scheduler = new SchedulerService({ store, instagramEnabled: true,
    publisher: async () => { throw new Error('Connexion perdue'); },
    instagramPublisher: { publish: async () => { calls++; return { mediaId: 'ig' }; } }
  });
  await assert.rejects(scheduler.publishNextPost());
  await assert.rejects(scheduler.publishNextPost(), /incertain/);
  assert.equal(calls, 1);
});

test('protocole Instagram : création, attente et publication avec persistance', async t => {
  const keys = ['INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_MEDIA_BASE_URL'];
  const original = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => original[i] === undefined ? delete process.env[key] : process.env[key] = original[i]));
  process.env.INSTAGRAM_ACCOUNT_ID = '123';
  process.env.INSTAGRAM_ACCESS_TOKEN = 'test-secret';
  process.env.INSTAGRAM_MEDIA_BASE_URL = 'https://example.com/media/instagram';
  const saved = [];
  let calls = 0;
  const publisher = new InstagramPublisher({ prepare: async () => 'image.jpg', sleep: async () => {}, client: {
    post: async (url, body) => {
      calls++;
      if (url.endsWith('/media')) { assert.equal(body.get('image_url'), 'https://example.com/media/instagram/image.jpg'); return { data: { id: 'container' } }; }
      assert.equal(saved.at(-1).status, 'sending');
      assert.equal(body.get('creation_id'), 'container');
      return { data: { id: 'published-id' } };
    },
    get: async () => ({ data: { status_code: 'FINISHED' } })
  } });
  const result = await publisher.publish('Bonjour', 'images/a.png', { save: async value => saved.push(value) });
  assert.equal(result.mediaId, 'published-id');
  assert.equal(calls, 2);
  assert.equal(saved[0].containerId, 'container');
  await assert.rejects(publisher.publish('Bonjour', 'images/a.png', { delivery: { containerId: 'container', status: 'sending' } }), /incertain/);
  assert.equal(calls, 2);
  publisher.client.get = async () => ({ data: { status_code: 'PUBLISHED' } });
  assert.equal((await publisher.publish('Bonjour', 'images/a.png', { delivery: { containerId: 'container', status: 'sending' } })).status, 'published');
  process.env.INSTAGRAM_MEDIA_BASE_URL = '';
  await assert.rejects(publisher.publish('Bonjour', 'images/a.png'), /HTTPS publique/);
});
