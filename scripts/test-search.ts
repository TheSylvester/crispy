import { dualPathSearch } from '../src/core/recall/vector-search.js';
import { getDb } from '../src/core/crispy-db.js';
import { getDbPath } from '../src/core/recall/memory-queries.js';

// Init DB so vector-search can use it
getDb(getDbPath());

async function main() {
  const r = await dualPathSearch('recall prompt feature implementation', { limit: 200 });
  const target = ['f7c7f61e', 'cd9af95d', '118619d7'];
  const found = r.results.filter(x => target.some(t => x.session_id.startsWith(t)));
  console.log('Total results:', r.results.length);
  console.log('FTS:', r.ftsCount, 'Semantic:', r.semanticCount, 'Available:', r.semanticAvailable);
  console.log('Target sessions found:', found.length);
  for (const f of found) {
    const idx = r.results.indexOf(f);
    console.log('  rank', idx + 1, f.session_id.slice(0,8), f.match_snippet?.slice(0, 80));
  }
  const seen = new Set<string>();
  let count = 0;
  for (const x of r.results) {
    if (!seen.has(x.session_id)) {
      seen.add(x.session_id);
      count++;
      if (count <= 20) console.log('  top', count, x.session_id.slice(0,8), x.match_snippet?.slice(0, 80));
    }
  }
  console.log('  ... total unique sessions:', seen.size);
  for (const t of target) {
    const inResults = r.results.some(x => x.session_id.startsWith(t));
    console.log(`  ${t}: ${inResults ? 'FOUND' : 'MISSING'}`);
  }
  process.exit(0);
}
main();
