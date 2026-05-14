// Test-only helper that applies the worker/migrations/*.sql files to a
// per-test Miniflare D1 instance. Production runs `wrangler d1
// migrations apply` instead; this exists so unit tests can exercise the
// real schema without going through wrangler.

import init from '../../migrations/0001_init.sql?raw';
import seed from '../../migrations/0002_metros_seed.sql?raw';
import articles from '../../migrations/0003_articles.sql?raw';

/**
 * Strip SQL line comments (`-- …` to end of line, anywhere on the line)
 * and split into statements on `;`. Our migration files happen not to
 * embed `--` inside string literals, so we don't need a full tokenizer.
 * If that changes, switch to a real parser.
 */
export function splitStatements(sql: string): string[] {
  const stripped = sql.replace(/--[^\n]*/g, '');
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function applyMigrations(db: D1Database): Promise<void> {
  // Order matters: schema → seed → schema additions.
  const files = [init, seed, articles];
  for (const file of files) {
    for (const stmt of splitStatements(file)) {
      await db.prepare(stmt).run();
    }
  }
}
