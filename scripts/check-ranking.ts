import { searchMessagesFts } from '../src/core/recall/message-store.js';
import { initDb } from '../src/core/crispy-db.js';
initDb();

const fts = searchMessagesFts('recall prompt', 120);
const targets = ['f7c7f61e', 'cd9af95d'];
for (const t of targets) {
  const pos = fts.findIndex(r => r.session_id.startsWith(t));
  console.log('FTS5: ' + t + ' pos=' + (pos === -1 ? 'NOT IN TOP 120' : pos));
}
console.log('FTS5 results: ' + fts.length);
const seen = new Set<string>();
let count = 0;
for (const r of fts) {
  if (!seen.has(r.session_id)) {
    seen.add(r.session_id);
    count++;
    if (r.session_id.startsWith('f7c7f61e') || r.session_id.startsWith('cd9af95d')) {
      console.log('  ** ' + count + '. ' + r.session_id.slice(0,8) + ' rank=' + r.rank.toFixed(2));
    }
  }
}
console.log('Unique sessions in top 120: ' + count);
