// Test-only helper that applies the worker/migrations/*.sql files to a
// per-test Miniflare D1 instance. Production runs `wrangler d1
// migrations apply` instead; this exists so unit tests can exercise the
// real schema without going through wrangler.

import init from '../../migrations/0001_init.sql?raw';
import seed from '../../migrations/0002_metros_seed.sql?raw';
import articles from '../../migrations/0003_articles.sql?raw';
import addRegion from '../../migrations/0004_add_region.sql?raw';
import fridayCampaignLog from '../../migrations/0005_friday_campaign_log.sql?raw';

/**
 * Strip SQL line comments and split into statements on `;`. Quote-aware
 * so a `;` inside a single-quoted string literal does NOT end the
 * statement — important for INSERTs whose payload column carries JSON
 * (`{"msg":"a;b"}`). SQLite's `''` escape is handled by peeking the
 * next character when we're inside a string.
 *
 * Limitations: doesn't handle nested block comments (`/* … *\/`); our
 * migrations use `--` only, so that's fine. If we ever add block
 * comments, extend or move to a real parser.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inString && sql[i + 1] === "'") {
        // `''` is the SQLite escape — emit both chars, stay in-string.
        current += "''";
        i++;
        continue;
      }
      inString = !inString;
      current += c;
      continue;
    }
    // `--` line comment — only when we're *outside* a string literal,
    // otherwise `'a--b'` would be truncated mid-value. We stop one
    // char before the `\n` so the outer loop still emits the newline
    // (preserves line breaks in the surviving statement text).
    if (!inString && c === '-' && sql[i + 1] === '-') {
      while (i + 1 < sql.length && sql[i + 1] !== '\n') i++;
      continue;
    }
    if (c === ';' && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += c;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function applyMigrations(db: D1Database): Promise<void> {
  // Order matters: schema → seed → schema additions.
  const files = [init, seed, articles, addRegion, fridayCampaignLog];
  for (const file of files) {
    for (const stmt of splitStatements(file)) {
      await db.prepare(stmt).run();
    }
  }
}
