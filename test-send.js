const { PostStore } = require('./post-store');
const { POSTS_FILE } = require('./config');
const { SchedulerService } = require('./scheduler');
async function main() {
  const store = new PostStore(POSTS_FILE);
  const id = 'd7404bb2-b067-419c-95b0-bde65daca0e6';
  // Le premier essai a été refusé avant la connexion TCP, sans envoi à Meta.
  await store.transaction(posts => {
    const post = store.find(posts, id);
    const delivery = post.deliveries?.facebook;
    if (!post.publishing && delivery?.status === 'unknown' && /^facebook : connect EACCES /.test(delivery.lastError || '')) {
      delivery.status = 'failed';
    }
  });
  try { await new SchedulerService({ store }).publishNextPost(id); }
  catch { console.log('Envoi incomplet : consulter les états par réseau.'); }
  const post = store.read().find(post => post.id === id);
  console.log(JSON.stringify({ published: post.published, facebookPostId: post.facebookPostId, instagramMediaId: post.instagramMediaId, deliveries: post.deliveries }, null, 2));
}
main().catch(() => { console.error('Test interrompu.'); process.exitCode = 1; });
