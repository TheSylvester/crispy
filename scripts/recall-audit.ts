import { dualPathSearch } from '../src/core/recall/vector-search.js';
import { getDb } from '../src/core/crispy-db.js';
import { getDbPath } from '../src/core/recall/memory-queries.js';

// Init DB
getDb(getDbPath());

const QUERIES = [
  'recall search quality problems challenges',
  'search results wrong session found incorrect',
  'vocabulary mismatch semantic search miss',
  'IDF filtering stopwords query sanitizer',
  'MCP rename deferred tools tool search',
  'recall golden dataset test queries',
  'recall prompt optimization iteration',
  'BM25 ranking results missing sessions',
  'recall agent found wrong conversation',
  'embedding vector search brute force',
  'query dilution high frequency terms',
  'recall regression test validation',
  'search transcript not finding results',
  'recall system limitations failures',
  'mid-range date gap sessions missing',
];

interface SessionHit {
  session_id: string;
  short_id: string;
  date: string;
  queries: string[];
  snippets: string[];
  best_rank: number;
}

async function main() {
  const sessionMap = new Map<string, SessionHit>();

  for (const query of QUERIES) {
    process.stderr.write(`Searching: "${query}" ... `);
    const r = await dualPathSearch(query, { limit: 100 });
    process.stderr.write(`${r.results.length} results (${r.ftsCount} FTS, ${r.semanticCount} semantic)\n`);

    const seen = new Set<string>();
    for (const x of r.results) {
      if (seen.has(x.session_id)) continue;
      seen.add(x.session_id);

      const short = x.session_id.slice(0, 8);
      const existing = sessionMap.get(x.session_id);
      const rank = r.results.indexOf(x) + 1;
      const snippet = (x.match_snippet || x.message_preview || '').slice(0, 120).replace(/\n/g, ' ');

      if (existing) {
        if (!existing.queries.includes(query)) {
          existing.queries.push(query);
          existing.snippets.push(snippet);
        }
        if (rank < existing.best_rank) existing.best_rank = rank;
      } else {
        sessionMap.set(x.session_id, {
          session_id: x.session_id,
          short_id: short,
          date: x.created_at ? new Date(x.created_at).toISOString().slice(0, 10) : 'unknown',
          queries: [query],
          snippets: [snippet],
          best_rank: rank,
        });
      }
    }
  }

  // Sort by date
  const allSessions = [...sessionMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  console.log('\n' + '='.repeat(120));
  console.log(`CONSOLIDATED RECALL AUDIT — ${allSessions.length} unique sessions across ${QUERIES.length} queries`);
  console.log('='.repeat(120));

  for (const s of allSessions) {
    console.log(`\n${s.short_id}  ${s.date}  (best rank: ${s.best_rank}, found by ${s.queries.length} queries)`);
    console.log(`  Queries: ${s.queries.map(q => `"${q}"`).join(', ')}`);
    console.log(`  Snippet: ${s.snippets[0]}`);
  }

  // Summary: sessions found by 3+ queries are likely highly relevant
  const multiHit = allSessions.filter(s => s.queries.length >= 3);
  console.log('\n' + '='.repeat(120));
  console.log(`HIGH-CONFIDENCE SESSIONS (found by 3+ queries): ${multiHit.length}`);
  console.log('='.repeat(120));
  for (const s of multiHit) {
    console.log(`  ${s.short_id}  ${s.date}  (${s.queries.length} queries, best rank ${s.best_rank})`);
    // Show up to 3 snippets
    for (let i = 0; i < Math.min(3, s.snippets.length); i++) {
      console.log(`    [${s.queries[i]}] ${s.snippets[i]}`);
    }
  }

  process.exit(0);
}

main();
