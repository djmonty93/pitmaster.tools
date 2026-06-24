import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isoWeekParts,
  runWeeklyArticleCron,
  weeklySummarySlug,
} from '../../../src/crons/weeklyArticle';
import type { Env } from '../../../src/index';
import { applyMigrations } from '../../helpers/d1';

interface E {
  SMOKE_DB: D1Database;
  WEATHER_KV: KVNamespace;
}
const DB = (env as unknown as E).SMOKE_DB;
const KV = (env as unknown as E).WEATHER_KV;

beforeAll(async () => {
  await applyMigrations(DB);
});

beforeEach(async () => {
  await DB.prepare(`DELETE FROM articles`).run();
});

function buildEnv(): Env {
  return {
    ASSETS: undefined as unknown as Fetcher,
    WEATHER_KV: KV,
    SMOKE_DB: DB,
    PIN_BUCKET: undefined as unknown as R2Bucket,
    SENDER_API_TOKEN: 'sender_test_token',
    SUBSCRIBER_TOKEN_SECRET: 'test-secret-32-bytes-long-aaaaaaaaa',
  };
}

interface ArticleRow {
  slug: string;
  kind: string;
  title: string;
  body_html: string;
  body_text: string;
  hero_band: string;
  published_at: number;
  updated_at: number;
}

async function selectArticle(slug: string): Promise<ArticleRow | null> {
  return DB.prepare(
    `SELECT slug, kind, title, body_html, body_text, hero_band, published_at, updated_at
       FROM articles WHERE slug = ?`
  )
    .bind(slug)
    .first<ArticleRow>();
}

describe('isoWeekParts', () => {
  it('returns ISO week 20 for Monday 2026-05-11 (week the user lives in today)', () => {
    expect(isoWeekParts(new Date('2026-05-11T12:00:00Z'))).toEqual({
      year: 2026,
      week: 20,
    });
  });

  it('handles year-boundary weeks correctly (2027-01-01 belongs to ISO 2026-W53)', () => {
    // 2027-01-01 is a Friday; ISO week numbering says this Friday
    // belongs to the week whose Thursday is in 2026 → 2026-W53.
    expect(isoWeekParts(new Date('2027-01-01T12:00:00Z'))).toEqual({
      year: 2026,
      week: 53,
    });
  });

  it('handles week 1 starting in late December (2024-12-30 → 2025-W01)', () => {
    expect(isoWeekParts(new Date('2024-12-30T12:00:00Z'))).toEqual({
      year: 2025,
      week: 1,
    });
  });
});

describe('weeklySummarySlug', () => {
  it('produces a lowercase, hyphen-only slug that matches the route slug regex', () => {
    const slug = weeklySummarySlug({ year: 2026, week: 20 });
    expect(slug).toBe('weekly-summary-2026-w20');
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('zero-pads single-digit week numbers', () => {
    expect(weeklySummarySlug({ year: 2026, week: 1 })).toBe('weekly-summary-2026-w01');
    expect(weeklySummarySlug({ year: 2026, week: 9 })).toBe('weekly-summary-2026-w09');
  });
});

describe('runWeeklyArticleCron', () => {
  const MON_W20 = new Date('2026-05-11T12:00:00Z');

  it('writes a weekly-summary row for the scheduled ISO week', async () => {
    const outcome = await runWeeklyArticleCron(buildEnv(), MON_W20);
    expect(outcome.status).toBe('written');
    expect(outcome.slug).toBe('weekly-summary-2026-w20');

    const row = await selectArticle('weekly-summary-2026-w20');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('weekly-summary');
    expect(row!.title).toContain('2026');
    expect(['red', 'yellow', 'green', 'ideal']).toContain(row!.hero_band);
    expect(row!.published_at).toBeGreaterThan(0);
    expect(row!.updated_at).toBeGreaterThanOrEqual(row!.published_at);
  });

  it("body_text covers every region's anchor city (SEO surface area)", async () => {
    await runWeeklyArticleCron(buildEnv(), MON_W20);
    const row = await selectArticle('weekly-summary-2026-w20');
    expect(row).not.toBeNull();
    // Anchor cities one per region — present so the article reads as
    // national coverage, not a single-region piece.
    for (const city of [
      'New York',
      'Atlanta',
      'Chicago',
      'Kansas City',
      'Denver',
      'Los Angeles',
    ]) {
      expect(row!.body_text).toContain(city);
    }
  });

  it('body_text is at least 300 words (matches metro page bar from F16)', async () => {
    await runWeeklyArticleCron(buildEnv(), MON_W20);
    const row = await selectArticle('weekly-summary-2026-w20');
    const words = row!.body_text.trim().split(/\s+/).filter(Boolean);
    expect(words.length).toBeGreaterThanOrEqual(300);
  });

  it('body_html contains the FTC affiliate disclosure (F15 requirement)', async () => {
    await runWeeklyArticleCron(buildEnv(), MON_W20);
    const row = await selectArticle('weekly-summary-2026-w20');
    expect(row!.body_html.toLowerCase()).toContain('ftc');
    expect(row!.body_html.toLowerCase()).toMatch(/affiliate|commission/);
  });

  it('is idempotent on the same week — bumps updated_at but keeps published_at', async () => {
    const first = await runWeeklyArticleCron(buildEnv(), MON_W20);
    expect(first.status).toBe('written');
    const initial = await selectArticle('weekly-summary-2026-w20');
    const initialPublished = initial!.published_at;

    // Re-run a second later — same week, same slug. The cron is
    // designed to be safe to invoke multiple times (e.g. on retry).
    const second = await runWeeklyArticleCron(
      buildEnv(),
      new Date(MON_W20.getTime() + 1000)
    );
    expect(second.status).toBe('updated');
    expect(second.slug).toBe('weekly-summary-2026-w20');

    const final = await selectArticle('weekly-summary-2026-w20');
    expect(final!.published_at).toBe(initialPublished);
    expect(final!.updated_at).toBeGreaterThanOrEqual(initial!.updated_at);
  });

  it('writes a distinct row for a different ISO week without disturbing prior weeks', async () => {
    await runWeeklyArticleCron(buildEnv(), MON_W20);
    // Skip one week ahead — Mon 2026-05-18 is ISO week 21.
    const MON_W21 = new Date('2026-05-18T12:00:00Z');
    const outcome = await runWeeklyArticleCron(buildEnv(), MON_W21);
    expect(outcome.slug).toBe('weekly-summary-2026-w21');

    const w20 = await selectArticle('weekly-summary-2026-w20');
    const w21 = await selectArticle('weekly-summary-2026-w21');
    expect(w20).not.toBeNull();
    expect(w21).not.toBeNull();
    expect(w20!.slug).not.toBe(w21!.slug);
  });

  it('hero_band varies by season (summer → ideal, winter → red)', async () => {
    // Mon 2026-07-06 is mid-summer (ISO 2026-W28).
    const SUMMER = new Date('2026-07-06T12:00:00Z');
    await runWeeklyArticleCron(buildEnv(), SUMMER);
    const summer = await selectArticle('weekly-summary-2026-w28');
    expect(summer!.hero_band).toBe('ideal');

    // Mon 2026-01-05 is dead winter (ISO 2026-W02).
    const WINTER = new Date('2026-01-05T12:00:00Z');
    await runWeeklyArticleCron(buildEnv(), WINTER);
    const winter = await selectArticle('weekly-summary-2026-w02');
    expect(winter!.hero_band).toBe('red');
  });
});
