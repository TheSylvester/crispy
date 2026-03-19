/**
 * recall-search — CLI for dual-path recall search
 *
 * Usage:
 *   npx tsx scripts/recall-search.ts "your query here"
 *   npx tsx scripts/recall-search.ts "query" --limit 50
 *   npx tsx scripts/recall-search.ts "query" --raw
 *
 * Outputs deduplicated sessions sorted by RRF score, with natural score-gap
 * cutoff. The gap detector scans from position 10 onward, finds the largest
 * relative drop between consecutive RRF scores, and truncates there if the
 * drop exceeds 15%. Otherwise returns everything up to --limit (default 200).
 */

import { dualPathSearch } from '../src/core/recall/vector-search.js';
import { getDb } from '../src/core/crispy-db.js';
import { getDbPath } from '../src/core/recall/memory-queries.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const raw = args.includes('--raw');
const limitIdx = args.indexOf('--limit');
const ceiling = limitIdx >= 0 ? parseInt(args[limitIdx + 1]!, 10) : 200;

// Positional: skip flags and their values
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--raw') continue;
  if (args[i] === '--limit') { i++; continue; }
  positional.push(args[i]!);
}

const query = positional[0];
if (!query) {
  console.error('Usage: npx tsx scripts/recall-search.ts "query" [--limit N] [--raw]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

getDb(getDbPath());

async function main() {
  const r = await dualPathSearch(query!, { limit: ceiling });
  const { scored } = r;

  // --- Score-gap cutoff ---
  // Scan from position 10 onward. Find the largest relative drop between
  // consecutive scores. If > 15%, truncate there.
  let cutoffIdx = scored.length;
  if (scored.length > 10) {
    let maxDrop = 0;
    let maxDropIdx = -1;
    for (let i = 10; i < scored.length - 1; i++) {
      const curr = scored[i]!.score;
      const next = scored[i + 1]!.score;
      if (curr > 0) {
        const drop = (curr - next) / curr;
        if (drop > maxDrop) {
          maxDrop = drop;
          maxDropIdx = i + 1; // cut *before* the next element
        }
      }
    }
    if (maxDrop > 0.15) {
      cutoffIdx = maxDropIdx;
    }
  }

  const trimmed = scored.slice(0, cutoffIdx);

  // --- Deduplicate by session_id, keep highest-ranked entry ---
  interface SessionRow {
    rank: number;
    session_id: string;
    short_id: string;
    date: string;
    snippet: string;
    hits: number;
    score: number;
  }

  const sessions: SessionRow[] = [];
  const seen = new Map<string, number>(); // session_id -> index in sessions

  for (let i = 0; i < trimmed.length; i++) {
    const x = trimmed[i]!;
    const sid = x.result.session_id;
    const idx = seen.get(sid);
    if (idx !== undefined) {
      sessions[idx]!.hits++;
    } else {
      seen.set(sid, sessions.length);
      sessions.push({
        rank: sessions.length + 1,
        session_id: sid,
        short_id: sid.slice(0, 8),
        date: x.result.created_at
          ? new Date(x.result.created_at).toISOString().slice(0, 10)
          : 'unknown',
        snippet: (x.result.match_snippet || x.result.message_preview || '')
          .slice(0, 120)
          .replace(/\n/g, ' '),
        hits: 1,
        score: x.score,
      });
    }
  }

  // --- Output ---
  if (raw) {
    console.log(JSON.stringify({
      query,
      total_messages: trimmed.length,
      total_before_cutoff: scored.length,
      cutoff_applied: cutoffIdx < scored.length,
      fts_count: r.ftsCount,
      semantic_count: r.semanticCount,
      semantic_available: r.semanticAvailable,
      unique_sessions: sessions.length,
      sessions,
    }, null, 2));
  } else {
    console.log(`Query: "${query}"`);
    console.log(`Results: ${trimmed.length} messages (${scored.length} before cutoff), ${sessions.length} unique sessions`);
    console.log(`Paths: FTS5=${r.ftsCount}  Semantic=${r.semanticCount} (${r.semanticAvailable ? 'active' : 'UNAVAILABLE'})`);
    if (cutoffIdx < scored.length) {
      console.log(`Cutoff: position ${cutoffIdx} of ${scored.length} (score gap detected)`);
    }
    console.log('---');

    // Column widths
    const rankW = 4;
    const idW = 10;
    const dateW = 12;
    const hitsW = 6;

    console.log(
      '#'.padStart(rankW) + '  ' +
      'Session'.padEnd(idW) +
      'Date'.padEnd(dateW) +
      'Hits'.padStart(hitsW) + '  ' +
      'Snippet'
    );

    for (const s of sessions) {
      console.log(
        String(s.rank).padStart(rankW) + '  ' +
        s.short_id.padEnd(idW) +
        s.date.padEnd(dateW) +
        String(s.hits).padStart(hitsW) + '  ' +
        s.snippet
      );
    }
  }

  process.exit(0);
}

main();
