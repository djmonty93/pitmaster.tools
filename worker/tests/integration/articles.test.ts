import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleArticles } from '../../src/handlers/articles';
import { applyMigrations } from '../helpers/d1';
import { buildContext } from '../helpers/routeContext';

interface E {
  SMOKE_DB: D1Database;
}

const DB = (env as unknown as E).SMOKE_DB;

beforeAll(async () => {
  await applyMigrations(DB);
});

beforeEach(async () => {
  await DB.prepare(`DELETE FROM articles`).run();
});

describe('GET /articles/:slug', () => {
  it('renders a stored article with the required <head> elements and Article JSON-LD', async () => {
    const now = Date.UTC(2026, 4, 15);
    await DB.prepare(
      `INSERT INTO articles (slug, kind, title, body_html, body_text, hero_band, published_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        '2026-w20-summary',
        'weekly-summary',
        'Best Smoke Days, Week 20',
        '<p>It looks good across the southeast.</p>',
        'It looks good across the southeast.',
        'green',
        now,
        now
      )
      .run();
    const res = await handleArticles(
      buildContext(new Request('https://x/articles/2026-w20-summary'), {
        slug: '2026-w20-summary',
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain('<title>Best Smoke Days, Week 20 — pitmaster.tools</title>');
    expect(body).toContain('rel="canonical"');
    expect(body).toContain('pitmaster.tools/articles/2026-w20-summary');
    expect(body).toContain('<meta property="og:title"');
    expect(body).toContain('<meta property="og:type" content="article">');
    expect(body).toContain('"@type":"Article"');
    expect(body).toContain('It looks good across the southeast.');
    // hero band lands in a class for CSS variant.
    expect(body).toContain('article--green');
  });

  it("HTML-escapes the title so an XSS-shaped title can't break out of <head>", async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO articles (slug, kind, title, body_html, body_text, hero_band, published_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        'xss-test',
        'weekly-summary',
        '</title><script>alert(1)</script>',
        '<p>x</p>',
        'x',
        'green',
        now,
        now
      )
      .run();
    const res = await handleArticles(
      buildContext(new Request('https://x/articles/xss-test'), { slug: 'xss-test' })
    );
    const body = await res.text();
    // Exactly one literal `</title>` in the body — the real closing
    // tag. Any second occurrence would indicate the escape missed,
    // either in the visible <title> contents or inside JSON-LD.
    expect(body.split('</title>')).toHaveLength(2);
    expect(body).toContain('&lt;/title&gt;');
    // The injected <script>...</script> must not survive into the
    // rendered HTML in any form that the parser would execute.
    expect(body).not.toContain('<script>alert(1)</script>');
    // JSON-LD `headline` carries the unescaped string, but `<` is
    // <-escaped so it stays inert.
    expect(body).toContain('\\u003c/title\\u003e\\u003cscript\\u003e');
  });

  it('400s on an invalid slug shape', async () => {
    const res = await handleArticles(
      buildContext(new Request('https://x/articles/Has%20Space'), { slug: 'Has Space' })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_slug' });
  });

  it('strips <script>, <iframe>, and on*= handlers from body_html as defense-in-depth', async () => {
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO articles (slug, kind, title, body_html, body_text, hero_band, published_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        'sanitize-test',
        'weekly-summary',
        'Safe title',
        // Hostile body — represents the worst case where a row
        // somehow gets written with attacker-controlled HTML.
        '<p>Hello</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><a href="javascript:alert(2)">x</a><img src="x" onerror="alert(3)">',
        'text',
        'green',
        now,
        now
      )
      .run();
    const res = await handleArticles(
      buildContext(new Request('https://x/articles/sanitize-test'), {
        slug: 'sanitize-test',
      })
    );
    const body = await res.text();
    expect(body).toContain('<p>Hello</p>');
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toContain('<iframe');
    expect(body).not.toMatch(/onerror\s*=/i);
    expect(body).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });

  it('404s with an HTML shell when the slug does not exist', async () => {
    const res = await handleArticles(
      buildContext(new Request('https://x/articles/never-published'), {
        slug: 'never-published',
      })
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).toContain('Article not found');
    expect(body).toContain('<meta name="robots" content="noindex, follow">');
  });
});
