const { PostStore } = require('./post-store');
const { POSTS_FILE } = require('./config');
const { prepareImage } = require('./instagram');
async function main() {
  const images = new Set(new PostStore(POSTS_FILE).read().filter(post => !post.published).map(post => post.image));
  for (const image of images) await prepareImage(image);
  console.log(`${images.size} images JPEG préparées dans images/instagram.`);
}
main().catch(() => { console.error('Préparation Instagram impossible : vérifiez les fichiers images.'); process.exitCode = 1; });
