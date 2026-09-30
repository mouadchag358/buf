const assert = require('node:assert/strict');
const fs = require('node:fs');
const library = require('./image-library.json');
const base = 'http://127.0.0.1:3000';
const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const openings = ['🍯 اكتشفوا نكهات عسل تمارة', '✨ نكهة جديدة على مائدتكم', '☀️ لحظات لذيذة مع عسل تمارة', '🎁 شاركوا متعة المذاق مع أحبابكم', '🌿 اختيار اليوم من عسل تمارة'];
const endings = ['راسلونا لمعرفة التفاصيل والطلب.', 'شنو هي النكهة المفضلة عندكم؟ تواصلوا معنا للطلب.', 'اختاروا مذاقكم المفضل وراسلونا للطلب.', 'للاستفسار عن هذا الاختيار، راسلونا.', 'مرحبا برسائلكم للاستفسار والطلب.'];
async function dashboard() {
  const response = await fetch(`${base}/api/dashboard`);
  assert(response.ok);
  return response.json();
}
async function main() {
  assert.equal(library.length, 15);
  for (const asset of library) assert(fs.existsSync(asset.image), asset.image);
  const planned = [];
  const days = (Date.UTC(2027, 0, 31) - Date.UTC(2026, 9, 3)) / 86400000 + 1;
  for (let day = 0; day < days; day++) {
    for (const hour of [9, 13]) {
      const i = planned.length;
      const asset = library[i % library.length];
      const variant = Math.floor(i / library.length) % openings.length;
      const date = new Date(Date.UTC(2026, 9, 3 + day, hour - 1));
      const parts = Object.fromEntries(format.formatToParts(date).map(p => [p.type, p.value]));
      assert.equal(Number(parts.hour), hour);
      assert.equal(parts.minute, '00');
      const title = asset.kind === 'pack' ? asset.subtitle : asset.title;
      const text = `${openings[variant]}\n\n${title}\n${asset.details.map(detail => `✓ ${detail}`).join('\n')}\n\n💰 الثمن: ${asset.price}\n\n${endings[variant]}\n📞 للطلب: +212 766-577689\n📷 Instagram: @3sseltemara`;
      planned.push({ text, libraryImage: asset.image, scheduledAt: date.toISOString() });
    }
  }
  assert.equal(planned.length, 242);
  const existing = (await dashboard()).posts;
  let added = 0;
  for (const post of planned) {
    const match = existing.find(item => item.scheduledAt === post.scheduledAt);
    if (match) {
      assert.equal(match.image, post.libraryImage, 'Conflicting scheduled post');
      assert.equal(match.text, post.text, 'Conflicting caption');
      continue;
    }
    const response = await fetch(`${base}/api/posts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(post) });
    if (!response.ok) throw new Error(await response.text());
    added++;
  }
  const result = await dashboard();
  for (const post of planned) {
    const matches = result.posts.filter(item => item.scheduledAt === post.scheduledAt);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].published, false);
    assert.equal(matches[0].text, post.text);
  }
  console.log(JSON.stringify({ added, total: result.posts.length, first: format.format(new Date(planned[0].scheduledAt)), last: format.format(new Date(planned.at(-1).scheduledAt)), running: result.scheduler.running }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
