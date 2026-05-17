# Sender.net Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MailerLite integration with a Sender.net integration of identical surface shape, in a greenfield D1 reset (no data preservation).

**Architecture:** Mirror-replace pattern. New `worker/src/lib/sender/` module exports the same factory and method names as `worker/src/lib/mailerlite/` does today. Handlers and cron change by import path + factory name only — except the Friday cron, which gains a per-region "API Call Is Made" trigger URL because Sender has no automation-run-by-id endpoint. D1 migrations 0001–0004 squash into a single new `0001_init.sql` with `sender_retry` replacing `mailerlite_retry`. Custom field payload keys are wrapped in `{$bbq_*}` tokens inside the client. `Idempotency-Key` HTTP header is dropped; client-side dedup keys on `sender_retry.idempotency_key UNIQUE` do the work alone.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, D1, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec reference:** `docs/superpowers/specs/2026-05-16-mailerlite-to-sender-net-migration-design.md`

**Branch:** Work happens on `feat/sender-net-migration` (already created and contains the spec commit).

**Test commands:**
- Worker unit + integration: `npx vitest run --root worker` (or `npm test` for the full suite including script tests)
- Single test file: `npx vitest run --root worker tests/unit/sender/client.test.ts`
- Typecheck: `npm run typecheck`

**Conventions:**
- Every code file ends with a trailing newline.
- TypeScript files use single quotes, semicolons, ESM-style imports (`./file.js` even for `.ts` sources — Wrangler/Vitest setup expects this).
- Test files import from `cloudflare:test` for D1/KV bindings; use `installFetchStub` for HTTP mocking.
- Commit messages: `feat:` for new files, `refactor:` for in-place renames, `chore:` for docs/config, `test:` for test-only changes.

---

## Task 0: Confirm branch state and create scaffolding

**Files:**
- Working tree clean check
- Verify branch `feat/sender-net-migration`

- [ ] **Step 1: Confirm branch + tree state**

Run: `git status -sb`
Expected: `## feat/sender-net-migration` and a clean working tree (the spec commit is the most recent).

If branch is wrong, run `git checkout feat/sender-net-migration`.

- [ ] **Step 2: Create empty sender module directory**

Run: `mkdir -p worker/src/lib/sender worker/tests/unit/sender`

- [ ] **Step 3: Commit the scaffolding**

Skip — directories without files are not tracked by git. Real commits start with Task 1.

---

## Task 1: Port `errors.ts` → `sender/errors.ts`

**Files:**
- Create: `worker/src/lib/sender/errors.ts`
- Create: `worker/tests/unit/sender/errors.test.ts`
- Reference (read, don't edit yet): `worker/src/lib/mailerlite/errors.ts`

- [ ] **Step 1: Read the reference file in full**

Run: `cat worker/src/lib/mailerlite/errors.ts`

You will mirror its structure exactly, with these diffs:
1. Class name `MailerLiteError` → `SenderError`.
2. Type names `MailerLiteRequestKind` → `SenderRequestKind`, `MailerLiteErrorKind` → `SenderErrorKind`.
3. `SenderRequestKind` union: replace `'send' | 'campaign'` with `'digest_trigger' | 'field_update'`. Final union: `'subscribe' | 'unsubscribe' | 'digest_trigger' | 'group_assign' | 'group_remove' | 'group_list' | 'field_update'`.
4. `SenderErrorKind` union unchanged: `'http_5xx' | 'http_4xx' | 'timeout' | 'malformed' | 'network'`.
5. `RETRYABLE_4XX` set unchanged: `new Set([408, 425, 429])`.
6. Error message prefix `mailerlite ${requestKind}:` → `sender ${requestKind}:`.
7. `name = 'MailerLiteError'` → `name = 'SenderError'`.
8. JSDoc comment `mailerlite_retry` → `sender_retry`.

- [ ] **Step 2: Write the failing test**

Create `worker/tests/unit/sender/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SenderError } from '../../../src/lib/sender/errors.js';

describe('SenderError', () => {
  it('formats the message with request kind, error kind, and status', () => {
    const err = new SenderError('subscribe', 'http_4xx', 'Validation failed', 422);
    expect(err.message).toBe('sender subscribe: http_4xx (422): Validation failed');
    expect(err.name).toBe('SenderError');
  });

  it('shouldRetry: true for 5xx', () => {
    expect(new SenderError('subscribe', 'http_5xx', 'boom', 503).shouldRetry).toBe(true);
  });

  it('shouldRetry: true for network/timeout', () => {
    expect(new SenderError('subscribe', 'network', 'fetch failed').shouldRetry).toBe(true);
    expect(new SenderError('subscribe', 'timeout', 'timed out').shouldRetry).toBe(true);
  });

  it('shouldRetry: true for 408/425/429 4xx', () => {
    for (const status of [408, 425, 429]) {
      expect(new SenderError('subscribe', 'http_4xx', 'x', status).shouldRetry).toBe(true);
    }
  });

  it('shouldRetry: false for 422 validation', () => {
    expect(new SenderError('subscribe', 'http_4xx', 'x', 422).shouldRetry).toBe(false);
  });

  it('shouldRetry: false for malformed', () => {
    expect(new SenderError('subscribe', 'malformed', 'bad json').shouldRetry).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/sender/errors.test.ts`
Expected: FAIL with module not found error pointing at `src/lib/sender/errors.js`.

- [ ] **Step 4: Write the implementation**

Create `worker/src/lib/sender/errors.ts`:

```ts
// errors.ts
//
// Error taxonomy for the Sender.net client. Mirrors lib/weather/errors.ts
// so the /api/subscribe handler and the Friday cron can branch on the
// same `shouldRetry` rule across clients.

export type SenderRequestKind =
  | 'subscribe'
  | 'unsubscribe'
  | 'digest_trigger'
  | 'group_assign'
  | 'group_remove'
  | 'group_list'
  | 'field_update';

export type SenderErrorKind =
  | 'http_5xx'
  | 'http_4xx'
  | 'timeout'
  | 'malformed'
  | 'network';

/** 4xx codes that should still trigger a retry-queue enqueue. */
const RETRYABLE_4XX = new Set([408, 425, 429]);

export class SenderError extends Error {
  constructor(
    public readonly requestKind: SenderRequestKind,
    public readonly kind: SenderErrorKind,
    message: string,
    public readonly status?: number
  ) {
    super(
      `sender ${requestKind}: ${kind}${status !== undefined ? ` (${status})` : ''}: ${message}`
    );
    this.name = 'SenderError';
  }

  /** True if the call should be enqueued on sender_retry. */
  get shouldRetry(): boolean {
    if (this.kind === 'http_4xx') {
      return this.status !== undefined && RETRYABLE_4XX.has(this.status);
    }
    return this.kind !== 'malformed';
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --root worker tests/unit/sender/errors.test.ts`
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/sender/errors.ts worker/tests/unit/sender/errors.test.ts
git commit -m "feat(sender): port errors.ts to SenderError with 422 non-retryable"
```

---

## Task 2: Port `tags.ts` → `sender/tags.ts`

**Files:**
- Create: `worker/src/lib/sender/tags.ts`
- Create: `worker/tests/unit/sender/tags.test.ts`
- Reference: `worker/src/lib/mailerlite/tags.ts`

The public `BbqSubscriberFields` keys stay `bbq_*` (those are domain types, not transport). The `{$bbq_*}` token wrapping is an internal client concern — it lives in `client.ts`, NOT here.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/unit/sender/tags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toBbqSubscriberFields } from '../../../src/lib/sender/tags.js';

describe('toBbqSubscriberFields', () => {
  it('emits required keys', () => {
    const fields = toBbqSubscriberFields({
      zip: '23219',
      state: 'VA',
      region: 'southeast',
      timezone: 'America/New_York',
    });
    expect(fields).toEqual({
      bbq_zip: '23219',
      bbq_state: 'VA',
      bbq_region: 'southeast',
      bbq_timezone: 'America/New_York',
    });
  });

  it('omits optional keys when null/undefined', () => {
    const fields = toBbqSubscriberFields({
      zip: '23219', state: 'VA', region: 'southeast', timezone: 'America/New_York',
      city: null, cut: null, cooker: null, signupDate: null,
    });
    expect(fields).not.toHaveProperty('bbq_city');
    expect(fields).not.toHaveProperty('bbq_cut_pref');
    expect(fields).not.toHaveProperty('bbq_cooker_pref');
    expect(fields).not.toHaveProperty('bbq_signup_date');
  });

  it('includes optional keys when provided', () => {
    const fields = toBbqSubscriberFields({
      zip: '23219', state: 'VA', region: 'southeast', timezone: 'America/New_York',
      city: 'Richmond', cut: 'brisket-flat', cooker: 'pellet',
      signupDate: new Date('2026-05-16T12:00:00Z'),
    });
    expect(fields.bbq_city).toBe('Richmond');
    expect(fields.bbq_cut_pref).toBe('brisket-flat');
    expect(fields.bbq_cooker_pref).toBe('pellet');
    expect(fields.bbq_signup_date).toBe('2026-05-16');
  });

  it('rejects invalid zip', () => {
    expect(() => toBbqSubscriberFields({
      zip: '123', state: 'VA', region: 'southeast', timezone: 'America/New_York',
    })).toThrow(/Invalid zip/);
  });

  it('rejects invalid state', () => {
    expect(() => toBbqSubscriberFields({
      zip: '23219', state: 'Virginia', region: 'southeast', timezone: 'America/New_York',
    })).toThrow(/Invalid state/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/sender/tags.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Copy `mailerlite/tags.ts` content**

Run: `cat worker/src/lib/mailerlite/tags.ts` — copy the entire file content. Write it to `worker/src/lib/sender/tags.ts` with this diff:

- File-level docstring (if any) — replace "MailerLite" with "Sender.net" in prose only.
- Leave types, function bodies, regex, and `formatDate` helper unchanged.

The result must keep these exact exported names: `BbqTagInput`, `BbqSubscriberFields`, `toBbqSubscriberFields`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root worker tests/unit/sender/tags.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/tags.ts worker/tests/unit/sender/tags.test.ts
git commit -m "feat(sender): port tags.ts (bbq_* field shape unchanged)"
```

---

## Task 3: Stub `sender/client.ts` skeleton + `subscribe` method

**Files:**
- Create: `worker/src/lib/sender/client.ts`
- Create: `worker/tests/unit/sender/client.test.ts`
- Reference: `worker/src/lib/mailerlite/client.ts`, `worker/tests/helpers/fetchStub.ts`

The full `SenderClient` interface (8 methods) lands in one file but tests + implementation roll in over Tasks 3–9, one method per task. This task lays the skeleton + the first method.

- [ ] **Step 1: Read the reference client**

Run: `cat worker/src/lib/mailerlite/client.ts` and study the factory shape, the timeout/abort plumbing, the JSON parse error handling, and how `MailerLiteError` is constructed from response context. The Sender client mirrors this pattern; only the URL, payload shape, and field-key wrapping differ.

- [ ] **Step 2: Write the failing `subscribe` test**

Create `worker/tests/unit/sender/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { installFetchStub, jsonResponse } from '../../helpers/fetchStub.js';
import { createSenderClient } from '../../../src/lib/sender/client.js';
import { SenderError } from '../../../src/lib/sender/errors.js';

const baseFields = {
  bbq_zip: '23219',
  bbq_state: 'VA',
  bbq_region: 'southeast' as const,
  bbq_timezone: 'America/New_York',
};

describe('SenderClient.subscribe', () => {
  it('POSTs /v2/subscribers with bearer auth and {$bbq_*} wrapped fields', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () => jsonResponse(200, { data: { id: 'sub_abc', email: 'a@b.co', status: 'active' } }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok_xyz' });
      const res = await client.subscribe({ email: 'a@b.co', fields: baseFields });
      expect(res).toEqual({ id: 'sub_abc', email: 'a@b.co', status: 'active' });
      expect(stub.calls).toHaveLength(1);
      const call = stub.calls[0];
      expect(call.method).toBe('POST');
      expect(call.headers['authorization']).toBe('Bearer tok_xyz');
      expect(call.headers['content-type']).toContain('application/json');
      expect(call.body).toMatchObject({
        email: 'a@b.co',
        fields: {
          '{$bbq_zip}': '23219',
          '{$bbq_state}': 'VA',
          '{$bbq_region}': 'southeast',
          '{$bbq_timezone}': 'America/New_York',
        },
      });
    } finally {
      stub.restore();
    }
  });

  it('throws SenderError(http_5xx) with retryable=true on 503', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers', respond: () => jsonResponse(503, { message: 'down' }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await expect(client.subscribe({ email: 'a@b.co', fields: baseFields })).rejects.toThrow(SenderError);
    } finally {
      stub.restore();
    }
  });

  it('throws SenderError(http_4xx, 422) non-retryable on validation failure', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () => jsonResponse(422, { message: 'Validation', errors: { email: ['invalid'] } }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.subscribe({ email: 'bad', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).status).toBe(422);
      expect((err as SenderError).shouldRetry).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it('throws SenderError(timeout) when fetch is aborted', async () => {
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/subscribers',
        respond: () => new Promise<Response>(() => { /* never resolves */ }),
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok', timeoutMs: 25 });
      const err = await client.subscribe({ email: 'a@b.co', fields: baseFields }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).kind).toBe('timeout');
    } finally {
      stub.restore();
    }
  });

  it('does not send an Idempotency-Key header (Sender does not honor it)', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers', respond: () => jsonResponse(200, { data: { id: 'x', email: 'a@b.co', status: 'active' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.subscribe({ email: 'a@b.co', fields: baseFields });
      expect(stub.calls[0].headers['idempotency-key']).toBeUndefined();
    } finally {
      stub.restore();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --root worker tests/unit/sender/client.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 4: Implement skeleton + `subscribe`**

Create `worker/src/lib/sender/client.ts`:

```ts
import type { BbqSubscriberFields } from './tags.js';
import { SenderError, type SenderRequestKind } from './errors.js';

export type Fetcher = typeof fetch;

export interface SenderClientOptions {
  apiToken: string;
  fetcher?: Fetcher;
  /** Per-call request timeout. Defaults to 8s. */
  timeoutMs?: number;
  /** Override for tests / staging. */
  baseUrl?: string;
}

export interface SubscribeInput {
  email: string;
  fields: BbqSubscriberFields;
}

export interface SubscribeResult {
  id: string;
  email: string;
  status: 'active' | 'unsubscribed' | 'bounced' | 'reported_spam' | 'non_subscribed';
}

export interface UnsubscribeInput { email: string }

export interface SenderGroup { id: string; name: string }

export interface TriggerDigestInput {
  /** Per-region "API Call Is Made" trigger URL configured in Sender dashboard. */
  triggerUrl: string;
  /** Stable per-week tag, e.g. "southeast:2026-05-15". Body-only. */
  idempotencyTag: string;
}

export interface SenderClient {
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  updateSubscriberFields(email: string, fields: Record<string, unknown>): Promise<{ id: string } | null>;
  getSubscriberByEmail(email: string): Promise<{ id: string } | null>;
  unsubscribe(input: UnsubscribeInput): Promise<void>;
  listGroups(): Promise<SenderGroup[]>;
  assignGroup(subscriberId: string, groupId: string): Promise<void>;
  removeGroup(subscriberId: string, groupId: string): Promise<void>;
  triggerWeeklyDigest(input: TriggerDigestInput): Promise<void>;
}

const DEFAULT_BASE_URL = 'https://api.sender.net/v2';
const DEFAULT_TIMEOUT_MS = 8_000;

export function createSenderClient(opts: SenderClientOptions): SenderClient {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const auth = `Bearer ${opts.apiToken}`;

  async function request(
    requestKind: SenderRequestKind,
    method: string,
    pathOrUrl: string,
    body?: unknown
  ): Promise<unknown> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetcher(url, {
        method,
        headers: {
          authorization: auth,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const kind = err instanceof DOMException && err.name === 'AbortError' ? 'timeout' : 'network';
      const message = err instanceof Error ? err.message : String(err);
      throw new SenderError(requestKind, kind, message);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SenderError(requestKind, 'malformed', `non-JSON body: ${text.slice(0, 200)}`, res.status);
      }
    }
    if (!res.ok) {
      const errKind = res.status >= 500 ? 'http_5xx' : 'http_4xx';
      const msg = extractMessage(parsed) ?? `HTTP ${res.status}`;
      throw new SenderError(requestKind, errKind, msg, res.status);
    }
    return parsed;
  }

  function wrapFieldKeys(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      out[`{$${k}}`] = v;
    }
    return out;
  }

  return {
    async subscribe(input) {
      const body = {
        email: input.email,
        fields: wrapFieldKeys(input.fields as Record<string, unknown>),
        trigger_automation: false,
      };
      const parsed = await request('subscribe', 'POST', '/subscribers', body) as
        | { data?: { id?: string; email?: string; status?: SubscribeResult['status'] } }
        | null;
      const data = parsed?.data;
      if (!data?.id || !data.email || !data.status) {
        throw new SenderError('subscribe', 'malformed', 'missing data.{id,email,status} in response');
      }
      return { id: data.id, email: data.email, status: data.status };
    },
    async updateSubscriberFields() { throw new Error('not implemented'); },
    async getSubscriberByEmail() { throw new Error('not implemented'); },
    async unsubscribe() { throw new Error('not implemented'); },
    async listGroups() { throw new Error('not implemented'); },
    async assignGroup() { throw new Error('not implemented'); },
    async removeGroup() { throw new Error('not implemented'); },
    async triggerWeeklyDigest() { throw new Error('not implemented'); },
  };
}

function extractMessage(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof (parsed as { message: unknown }).message === 'string') {
    return (parsed as { message: string }).message;
  }
  return null;
}
```

Note on `trigger_automation: false`: this prevents Sender from firing all subscriber-add automations during routine subscribes; the Friday cron uses a different mechanism (per-region trigger URL) to fire the digest specifically.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --root worker tests/unit/sender/client.test.ts`
Expected: 5 tests pass (subscribe-related).

- [ ] **Step 6: Commit**

```bash
git add worker/src/lib/sender/client.ts worker/tests/unit/sender/client.test.ts
git commit -m "feat(sender): client skeleton + subscribe(), {\$bbq_*} field wrapping"
```

---

## Task 4: Implement `getSubscriberByEmail`

**Files:**
- Modify: `worker/src/lib/sender/client.ts`
- Modify: `worker/tests/unit/sender/client.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `worker/tests/unit/sender/client.test.ts`:

```ts
describe('SenderClient.getSubscriberByEmail', () => {
  it('returns { id } on 200', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/a%40b.co', respond: () => jsonResponse(200, { data: { id: 'sub_1' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      expect(await client.getSubscriberByEmail('a@b.co')).toEqual({ id: 'sub_1' });
      expect(stub.calls[0].method).toBe('GET');
    } finally { stub.restore(); }
  });

  it('returns null on 404', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/missing', respond: () => jsonResponse(404, { message: 'not found' }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      expect(await client.getSubscriberByEmail('missing@x.co')).toBeNull();
    } finally { stub.restore(); }
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run --root worker tests/unit/sender/client.test.ts`
Expected: 2 new tests FAIL (one with "not implemented", one expects null).

- [ ] **Step 3: Implement**

Replace the `getSubscriberByEmail` stub in `client.ts` with:

```ts
    async getSubscriberByEmail(email) {
      try {
        const parsed = await request(
          'subscribe',
          'GET',
          `/subscribers/${encodeURIComponent(email)}`
        ) as { data?: { id?: string } } | null;
        if (!parsed?.data?.id) {
          throw new SenderError('subscribe', 'malformed', 'missing data.id');
        }
        return { id: parsed.data.id };
      } catch (err) {
        if (err instanceof SenderError && err.kind === 'http_4xx' && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --root worker tests/unit/sender/client.test.ts`
Expected: all client tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/client.ts worker/tests/unit/sender/client.test.ts
git commit -m "feat(sender): getSubscriberByEmail() with 404 -> null"
```

---

## Task 5: Implement `updateSubscriberFields`

**Files:**
- Modify: `worker/src/lib/sender/client.ts`
- Modify: `worker/tests/unit/sender/client.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `worker/tests/unit/sender/client.test.ts`:

```ts
describe('SenderClient.updateSubscriberFields', () => {
  it('PATCHes /v2/subscribers/{email} with wrapped field keys', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/a%40b.co', respond: () => jsonResponse(200, { data: { id: 'sub_1' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const res = await client.updateSubscriberFields('a@b.co', { bbq_cut_pref: 'pork-butt' });
      expect(res).toEqual({ id: 'sub_1' });
      const call = stub.calls[0];
      expect(call.method).toBe('PATCH');
      expect(call.body).toMatchObject({ fields: { '{$bbq_cut_pref}': 'pork-butt' } });
      // Confirm no status: status MUST NOT appear (so an unsubscribed user isn't reactivated)
      expect(call.body).not.toHaveProperty('status');
    } finally { stub.restore(); }
  });

  it('returns null on 404', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/missing', respond: () => jsonResponse(404, {}) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      expect(await client.updateSubscriberFields('missing@x.co', {})).toBeNull();
    } finally { stub.restore(); }
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run --root worker tests/unit/sender/client.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement**

Replace the `updateSubscriberFields` stub with:

```ts
    async updateSubscriberFields(email, fields) {
      try {
        const parsed = await request(
          'field_update',
          'PATCH',
          `/subscribers/${encodeURIComponent(email)}`,
          { fields: wrapFieldKeys(fields) }
        ) as { data?: { id?: string } } | null;
        if (!parsed?.data?.id) {
          throw new SenderError('field_update', 'malformed', 'missing data.id');
        }
        return { id: parsed.data.id };
      } catch (err) {
        if (err instanceof SenderError && err.kind === 'http_4xx' && err.status === 404) {
          return null;
        }
        throw err;
      }
    },
```

- [ ] **Step 4: Verify pass**

Run: `npx vitest run --root worker tests/unit/sender/client.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/client.ts worker/tests/unit/sender/client.test.ts
git commit -m "feat(sender): updateSubscriberFields() PATCH without status"
```

---

## Task 6: Implement `unsubscribe`

**Files:**
- Modify: `worker/src/lib/sender/client.ts`
- Modify: `worker/tests/unit/sender/client.test.ts`

- [ ] **Step 1: Add failing test**

```ts
describe('SenderClient.unsubscribe', () => {
  it('PATCHes status=unsubscribed', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/a%40b.co', respond: () => jsonResponse(200, { data: { id: 'sub_1' } }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.unsubscribe({ email: 'a@b.co' });
      const call = stub.calls[0];
      expect(call.method).toBe('PATCH');
      expect(call.body).toMatchObject({ status: 'unsubscribed' });
    } finally { stub.restore(); }
  });
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run --root worker tests/unit/sender/client.test.ts`. Expected: 1 new fail.

- [ ] **Step 3: Implement**

```ts
    async unsubscribe(input) {
      await request(
        'unsubscribe',
        'PATCH',
        `/subscribers/${encodeURIComponent(input.email)}`,
        { status: 'unsubscribed' }
      );
    },
```

- [ ] **Step 4: Verify pass** — same command. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/client.ts worker/tests/unit/sender/client.test.ts
git commit -m "feat(sender): unsubscribe() PATCH status=unsubscribed"
```

---

## Task 7: Implement `listGroups` (paginated)

**Files:**
- Modify: `worker/src/lib/sender/client.ts`
- Modify: `worker/tests/unit/sender/client.test.ts`

Sender returns paginated `{ data: [...], links: { next? }, meta: {...} }`. Follow `links.next` until null.

- [ ] **Step 1: Add failing test**

```ts
describe('SenderClient.listGroups', () => {
  it('paginates via links.next', async () => {
    let call = 0;
    const stub = installFetchStub([
      {
        match: 'api.sender.net/v2/groups',
        respond: () => {
          call++;
          if (call === 1) return jsonResponse(200, {
            data: [{ id: 'g1', name: 'pitmaster_all' }],
            links: { next: 'https://api.sender.net/v2/groups?page=2' },
          });
          return jsonResponse(200, {
            data: [{ id: 'g2', name: 'pitmaster_northeast' }],
            links: { next: null },
          });
        },
      },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const groups = await client.listGroups();
      expect(groups).toEqual([
        { id: 'g1', name: 'pitmaster_all' },
        { id: 'g2', name: 'pitmaster_northeast' },
      ]);
      expect(stub.calls).toHaveLength(2);
    } finally { stub.restore(); }
  });
});
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement**

```ts
    async listGroups() {
      const out: SenderGroup[] = [];
      let url: string | null = '/groups?limit=100';
      while (url !== null) {
        const parsed = await request('group_list', 'GET', url) as
          | { data?: Array<{ id?: string; name?: string }>; links?: { next?: string | null } }
          | null;
        for (const row of parsed?.data ?? []) {
          if (typeof row.id === 'string' && typeof row.name === 'string') {
            out.push({ id: row.id, name: row.name });
          }
        }
        url = parsed?.links?.next ?? null;
      }
      return out;
    },
```

- [ ] **Step 4: Verify pass.**

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/client.ts worker/tests/unit/sender/client.test.ts
git commit -m "feat(sender): listGroups() with links.next pagination"
```

---

## Task 8: Implement `assignGroup` + `removeGroup`

**Files:**
- Modify: `worker/src/lib/sender/client.ts`
- Modify: `worker/tests/unit/sender/client.test.ts`

Sender endpoints: `POST /v2/subscribers/groups/{group_id}` and `DELETE /v2/subscribers/groups/{group_id}` with body `{ subscribers: ["<id>"] }`. 404 on remove is swallowed; 404 on assign is an error.

- [ ] **Step 1: Add failing tests**

```ts
describe('SenderClient.assignGroup', () => {
  it('POSTs to /v2/subscribers/groups/{id} with subscribers array', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/groups/g1', respond: () => jsonResponse(200, { data: {} }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.assignGroup('sub_1', 'g1');
      const call = stub.calls[0];
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({ subscribers: ['sub_1'] });
    } finally { stub.restore(); }
  });
});

describe('SenderClient.removeGroup', () => {
  it('DELETEs and swallows 404', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/subscribers/groups/g1', respond: () => jsonResponse(404, {}) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await expect(client.removeGroup('sub_1', 'g1')).resolves.toBeUndefined();
    } finally { stub.restore(); }
  });
});
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement**

```ts
    async assignGroup(subscriberId, groupId) {
      await request(
        'group_assign',
        'POST',
        `/subscribers/groups/${encodeURIComponent(groupId)}`,
        { subscribers: [subscriberId] }
      );
    },
    async removeGroup(subscriberId, groupId) {
      try {
        await request(
          'group_remove',
          'DELETE',
          `/subscribers/groups/${encodeURIComponent(groupId)}`,
          { subscribers: [subscriberId] }
        );
      } catch (err) {
        if (err instanceof SenderError && err.kind === 'http_4xx' && err.status === 404) return;
        throw err;
      }
    },
```

- [ ] **Step 4: Verify pass.**

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/client.ts worker/tests/unit/sender/client.test.ts
git commit -m "feat(sender): assignGroup + removeGroup (404 swallowed on remove)"
```

---

## Task 9: Implement `triggerWeeklyDigest`

**Files:**
- Modify: `worker/src/lib/sender/client.ts`
- Modify: `worker/tests/unit/sender/client.test.ts`

- [ ] **Step 1: Add failing test**

```ts
describe('SenderClient.triggerWeeklyDigest', () => {
  it('POSTs to the per-region trigger URL with tag body', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/automations/trigger/se-token', respond: () => jsonResponse(200, {}) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      await client.triggerWeeklyDigest({
        triggerUrl: 'https://api.sender.net/v2/automations/trigger/se-token',
        idempotencyTag: 'southeast:2026-05-15',
      });
      const call = stub.calls[0];
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({ tag: 'southeast:2026-05-15' });
      expect(call.headers['authorization']).toBe('Bearer tok');
    } finally { stub.restore(); }
  });

  it('throws SenderError(digest_trigger) on non-2xx', async () => {
    const stub = installFetchStub([
      { match: 'api.sender.net/v2/automations/trigger/se-token', respond: () => jsonResponse(500, { message: 'boom' }) },
    ]);
    try {
      const client = createSenderClient({ apiToken: 'tok' });
      const err = await client.triggerWeeklyDigest({
        triggerUrl: 'https://api.sender.net/v2/automations/trigger/se-token',
        idempotencyTag: 'x:1',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SenderError);
      expect((err as SenderError).requestKind).toBe('digest_trigger');
    } finally { stub.restore(); }
  });
});
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement**

```ts
    async triggerWeeklyDigest(input) {
      await request('digest_trigger', 'POST', input.triggerUrl, { tag: input.idempotencyTag });
    },
```

- [ ] **Step 4: Verify pass.**

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/client.ts worker/tests/unit/sender/client.test.ts
git commit -m "feat(sender): triggerWeeklyDigest() POSTs to per-region URL with tag body"
```

---

## Task 10: Port `groups.ts` → `sender/groups.ts`

**Files:**
- Create: `worker/src/lib/sender/groups.ts`
- Create: `worker/tests/unit/sender/groups.test.ts`
- Reference: `worker/src/lib/mailerlite/groups.ts`, `worker/tests/unit/mailerlite/groups.test.ts`

- [ ] **Step 1: Read the references**

Run: `cat worker/src/lib/mailerlite/groups.ts worker/tests/unit/mailerlite/groups.test.ts`. The Sender version is a verbatim copy with three string-literal diffs.

- [ ] **Step 2: Copy + diff `groups.ts`**

Create `worker/src/lib/sender/groups.ts` as a copy of `worker/src/lib/mailerlite/groups.ts` with these exact replacements:

1. `import type { MailerLiteClient } from './client.js';` → `import type { SenderClient } from './client.js';`
2. Every type reference `MailerLiteClient` → `SenderClient`.
3. `const KV_PREFIX = 'mailerlite_group_id';` → `const KV_PREFIX = 'sender_group_id';`
4. Update file-level comment (if present) — replace "MailerLite" prose with "Sender".

Do NOT change `ALL_GROUP_NAME = 'pitmaster_all'`, region→name mapping, or function logic.

- [ ] **Step 3: Copy + diff `groups.test.ts`**

Create `worker/tests/unit/sender/groups.test.ts` as a copy of `worker/tests/unit/mailerlite/groups.test.ts` with these replacements:

1. Import paths `'../../../src/lib/mailerlite/...'` → `'../../../src/lib/sender/...'`
2. KV cache key string literals `'mailerlite_group_id:...'` → `'sender_group_id:...'`
3. Any `MailerLiteClient` type reference → `SenderClient`.
4. If a mock client mocks `assignGroup`/`removeGroup`/`listGroups`, signatures already match — no changes needed.

- [ ] **Step 4: Run test**

Run: `npx vitest run --root worker tests/unit/sender/groups.test.ts`
Expected: all groups tests pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/sender/groups.ts worker/tests/unit/sender/groups.test.ts
git commit -m "feat(sender): port groups.ts (KV prefix sender_group_id:)"
```

---

## Task 11: Port `retry.ts` → `sender/retry.ts`

**Files:**
- Create: `worker/src/lib/sender/retry.ts`
- Create: `worker/tests/unit/sender/retry.test.ts`
- Reference: `worker/src/lib/mailerlite/retry.ts`, `worker/tests/unit/mailerlite/retry.test.ts`

The retry queue's table name and enum literals change; replay logic mostly stays but loses the `'send'` branch and gains a `'digest_trigger'` no-op (digest failures are not auto-retried — cron rerun hourly handles it).

- [ ] **Step 1: Read references**

Run: `cat worker/src/lib/mailerlite/retry.ts worker/tests/unit/mailerlite/retry.test.ts` and note these structural points:
- The `replayRow` (or equivalent dispatcher) switches on `request_kind` to call the right client method.
- The drain filter SQL — `WHERE request_kind IN ('subscribe','unsubscribe')` — defines which kinds get drained.

- [ ] **Step 2: Copy + diff `retry.ts`**

Create `worker/src/lib/sender/retry.ts` as a copy of `worker/src/lib/mailerlite/retry.ts` with these diffs:

1. Imports: `mailerlite/errors.js`/`mailerlite/client.js`/`mailerlite/groups.js` → `sender/errors.js`/`sender/client.js`/`sender/groups.js`.
2. Type references `MailerLiteError` → `SenderError`, `MailerLiteRequestKind` → `SenderRequestKind`, `MailerLiteClient` → `SenderClient`.
3. SQL: every `mailerlite_retry` → `sender_retry` (table name).
4. In the `replayRow` switch (or wherever `'send'` is handled): remove the `'send'` case. The drain filter (`WHERE request_kind IN (...)`) keeps `'subscribe','unsubscribe'` only — same as today.
5. `EnqueueInput.kind` typed as `SenderRequestKind` — but at runtime, only `'subscribe' | 'unsubscribe'` rows survive the DB CHECK + drain filter. The wider type is fine; the table CHECK constraint (Task 12) is the gate.

If the existing `MailerLite` code declares `EnqueueInput.kind: Exclude<MailerLiteRequestKind, 'send'>` or similar narrow type, mirror that pattern with the new union: `Exclude<SenderRequestKind, 'digest_trigger' | 'field_update' | 'group_assign' | 'group_remove' | 'group_list'>` — i.e. `'subscribe' | 'unsubscribe'`.

- [ ] **Step 3: Copy + diff `retry.test.ts`**

Create `worker/tests/unit/sender/retry.test.ts` as a copy of `worker/tests/unit/mailerlite/retry.test.ts` with these diffs:

1. Import paths → `sender/...`
2. SQL string literals: `mailerlite_retry` → `sender_retry`.
3. Any `MailerLiteError` → `SenderError`.
4. If a test exercises the `'send'` request kind being drained, delete it (no longer reachable).
5. If a test asserts `'send'` is parked: replace with a test asserting unknown kinds like `'digest_trigger'` cannot be inserted (DB CHECK blocks them) — but if that's painful, drop the test; it's redundant with the Task 12 migration test.

- [ ] **Step 4: Run test**

Note: this will fail until Task 12 lands the new schema. Mark this run as expected-fail or skip until Task 12 completes.

For now: `npx vitest run --root worker tests/unit/sender/retry.test.ts` — expect failures around table name (table doesn't exist in test fixtures yet).

- [ ] **Step 5: Stage the files but DON'T COMMIT**

```bash
git add worker/src/lib/sender/retry.ts worker/tests/unit/sender/retry.test.ts
```

Defer the commit until Task 12 squashes migrations and Task 21 fixes the migrations test — then `retry.test.ts` will pass.

---

## Task 12: Squash D1 migrations + update Env type

**Files:**
- Delete: `worker/migrations/0002_metros_seed.sql`, `worker/migrations/0003_articles.sql`, `worker/migrations/0004_add_region.sql`
- Modify (overwrite): `worker/migrations/0001_init.sql`
- Modify: `worker/src/index.ts`
- Modify: `.dev.vars.example`
- Reference: existing 0001–0004 contents (already read in planning phase)

- [ ] **Step 1: Read current migrations**

Run: `cat worker/migrations/0001_init.sql worker/migrations/0002_*.sql worker/migrations/0003_*.sql worker/migrations/0004_*.sql`. You will combine them into a single new file with the `mailerlite_retry` → `sender_retry` swap.

- [ ] **Step 2: Write the new `0001_init.sql`**

Overwrite `worker/migrations/0001_init.sql` with a single combined migration. The exact content:

```sql
-- 0001_init.sql — initial Best Smoke Days schema.
--
-- Tables:
--   subscribers       — Sender.net-synced subscribers, used by F14 cron.
--   metros            — 50 top metros for F16 SEO pages + F14 routing.
--   events            — append-only audit log for /api/status and Sentry
--                       enrichment; capped by retention policy.
--   sender_retry      — durable retry queue when Sender.net returns 5xx.
--   articles          — weekly article archive (F17).
--   friday_campaign_log — per-region weekly digest idempotency log.

CREATE TABLE IF NOT EXISTS subscribers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  zip             TEXT    NOT NULL,
  cut             TEXT    CHECK (cut IS NULL OR cut IN (
                            'brisket-flat', 'brisket-packer', 'pork-butt',
                            'spare-ribs', 'baby-back-ribs', 'pork-loin',
                            'whole-chicken', 'spatchcock-chicken', 'chicken-thighs',
                            'whole-turkey', 'turkey-breast', 'fish', 'lamb-shoulder'
                          )),
  cooker          TEXT    CHECK (cooker IS NULL OR cooker IN (
                            'offset', 'pellet', 'kamado', 'kettle', 'electric'
                          )),
  timezone        TEXT    NOT NULL,
  region          TEXT    CHECK (region IS NULL OR region IN (
                            'northeast', 'southeast', 'midwest', 'south_central', 'mountain', 'pacific'
                          )),
  created_at      INTEGER NOT NULL,
  unsubscribed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subscribers_timezone
  ON subscribers (timezone)
  WHERE unsubscribed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscribers_region
  ON subscribers (region)
  WHERE unsubscribed_at IS NULL;

CREATE TABLE IF NOT EXISTS metros (
  slug          TEXT    NOT NULL PRIMARY KEY,
  name          TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  zip           TEXT    NOT NULL,
  latitude      REAL    NOT NULL,
  longitude     REAL    NOT NULL,
  timezone      TEXT    NOT NULL,
  population    INTEGER NOT NULL,
  description   TEXT
);

CREATE INDEX IF NOT EXISTS idx_metros_state ON metros (state);

-- Metros seed: copy the entire INSERT OR IGNORE block from the old
-- 0002_metros_seed.sql verbatim. (50 rows.)

-- [PASTE 0002_metros_seed.sql INSERT BLOCK HERE]

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('forecast', 'subscribe', 'unsubscribe', 'send', 'error')),
  payload     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind);

CREATE TABLE IF NOT EXISTS sender_retry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_kind    TEXT    NOT NULL CHECK (request_kind IN ('subscribe', 'unsubscribe', 'digest_trigger')),
  request_payload TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_status     INTEGER,
  last_error      TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sender_retry_next
  ON sender_retry (next_attempt_at);

CREATE TABLE IF NOT EXISTS articles (
  slug         TEXT    NOT NULL PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('weekly-summary', 'metro-roundup', 'seasonal')),
  metro_slug   TEXT REFERENCES metros(slug) ON DELETE SET NULL,
  title        TEXT    NOT NULL,
  body_html    TEXT    NOT NULL,
  body_text    TEXT    NOT NULL,
  hero_band    TEXT    NOT NULL CHECK (hero_band IN ('red', 'yellow', 'green', 'ideal')),
  published_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles (published_at);
CREATE INDEX IF NOT EXISTS idx_articles_metro_slug
  ON articles (metro_slug)
  WHERE metro_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS friday_campaign_log (
  region       TEXT NOT NULL CHECK (region IN ('northeast', 'southeast', 'midwest', 'south_central', 'mountain', 'pacific')),
  send_date    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error        TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (region, send_date)
);
```

**Important:** the `friday_campaign_log` schema above is a best-guess reconstruction. Before pasting, run `cat worker/migrations/0001_init.sql worker/migrations/0002*.sql worker/migrations/0003*.sql worker/migrations/0004*.sql | grep -A 20 friday_campaign_log` to verify the actual columns; if it lives in a later migration, copy its `CREATE TABLE` block verbatim. If it doesn't exist as a migration yet (i.e. created ad-hoc by tests), look in `worker/tests/helpers/d1.ts` or similar test helper for the schema and add it here.

Also: when pasting the metros seed block (50 rows from `0002_metros_seed.sql`), include the full file content verbatim — every metro row must be present or `tests/unit/migrations.test.ts` will fail snapshot checks.

- [ ] **Step 3: Delete the obsolete migrations**

```bash
git rm worker/migrations/0002_metros_seed.sql worker/migrations/0003_articles.sql worker/migrations/0004_add_region.sql
```

- [ ] **Step 4: Update `worker/src/index.ts` Env type**

Read `worker/src/index.ts` to find the `Env` interface. Replace MailerLite fields with Sender fields:

```ts
// In the Env interface:
// REMOVE:
//   MAILERLITE_API_KEY: string;
//   MAILERLITE_FROM_EMAIL?: string;
//   MAILERLITE_FROM_NAME?: string;
//   MAILERLITE_REPLY_TO?: string;
//   MAILERLITE_AUTOMATION_NORTHEAST_ID?: string;
//   MAILERLITE_AUTOMATION_SOUTHEAST_ID?: string;
//   MAILERLITE_AUTOMATION_MIDWEST_ID?: string;
//   MAILERLITE_AUTOMATION_SOUTH_CENTRAL_ID?: string;
//   MAILERLITE_AUTOMATION_MOUNTAIN_ID?: string;
//   MAILERLITE_AUTOMATION_PACIFIC_ID?: string;
// ADD:
SENDER_API_TOKEN: string;
SENDER_FROM_EMAIL?: string;
SENDER_FROM_NAME?: string;
SENDER_REPLY_TO?: string;
SENDER_DIGEST_TRIGGER_URL_NORTHEAST?: string;
SENDER_DIGEST_TRIGGER_URL_SOUTHEAST?: string;
SENDER_DIGEST_TRIGGER_URL_MIDWEST?: string;
SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL?: string;
SENDER_DIGEST_TRIGGER_URL_MOUNTAIN?: string;
SENDER_DIGEST_TRIGGER_URL_PACIFIC?: string;
```

Update any JSDoc comments above these fields: replace "MailerLite" prose with "Sender.net" and update the description of the trigger URL to reference the per-region "API Call Is Made" automation.

- [ ] **Step 5: Rewrite `.dev.vars.example`**

Overwrite `.dev.vars.example` with:

```
# Sender.net API token. Required.
# Dashboard: Settings -> API access tokens -> Create.
# SENDER_API_TOKEN=your_token_here

# Sending identity (optional; only consumed if POST /v2/message/send is wired).
# SENDER_FROM_EMAIL=hello@mail.pitmaster.tools
# SENDER_FROM_NAME=Pitmaster.tools
# SENDER_REPLY_TO=hello@mail.pitmaster.tools

# Per-region "API Call Is Made" automation trigger URLs.
# Configure one automation per region in Sender (audience filter = pitmaster_<region> group),
# copy each automation's trigger URL into the matching var below.
# A missing var dark-disables that region in the Friday cron.
# SENDER_DIGEST_TRIGGER_URL_NORTHEAST=
# SENDER_DIGEST_TRIGGER_URL_SOUTHEAST=
# SENDER_DIGEST_TRIGGER_URL_MIDWEST=
# SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL=
# SENDER_DIGEST_TRIGGER_URL_MOUNTAIN=
# SENDER_DIGEST_TRIGGER_URL_PACIFIC=

# Subscriber token HMAC secret (used for unsubscribe + preferences links).
# Generate with: openssl rand -hex 32
# SUBSCRIBER_TOKEN_SECRET=

# Optional Sentry observability.
# SENTRY_DSN=
# SENTRY_ENVIRONMENT=
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: many errors — every handler/cron file still references `MAILERLITE_*` env vars and old client imports. Note the error count; it should drop to 0 by the end of Task 17.

- [ ] **Step 7: Commit**

```bash
git add worker/migrations/ worker/src/index.ts .dev.vars.example
git commit -m "refactor: squash D1 migrations to 0001 with sender_retry, swap Env to SENDER_*"
```

---

## Task 13: Migrate `handlers/subscribe.ts`

**Files:**
- Modify: `worker/src/handlers/subscribe.ts`
- Reference: current handler for the exact integration shape (already studied)

- [ ] **Step 1: Apply rename diffs to imports**

In `worker/src/handlers/subscribe.ts`, replace:

```ts
import { createMailerLiteClient } from '../lib/mailerlite/client.js';
import { MailerLiteError } from '../lib/mailerlite/errors.js';
import {
  ALL_GROUP_NAME,
  assignBbqGroups,
  regionToGroupName,
  resolveGroupId,
} from '../lib/mailerlite/groups.js';
import { enqueue } from '../lib/mailerlite/retry.js';
import { toBbqSubscriberFields, type BbqSubscriberFields } from '../lib/mailerlite/tags.js';
```

with:

```ts
import { createSenderClient } from '../lib/sender/client.js';
import { SenderError } from '../lib/sender/errors.js';
import {
  ALL_GROUP_NAME,
  assignBbqGroups,
  regionToGroupName,
  resolveGroupId,
} from '../lib/sender/groups.js';
import { enqueue } from '../lib/sender/retry.js';
import { toBbqSubscriberFields, type BbqSubscriberFields } from '../lib/sender/tags.js';
```

- [ ] **Step 2: Apply rename diffs to call sites**

Find and replace within `worker/src/handlers/subscribe.ts`:

| Old | New |
|---|---|
| `createMailerLiteClient` | `createSenderClient` |
| `MailerLiteError` | `SenderError` |
| `rc.env.MAILERLITE_API_KEY` | `rc.env.SENDER_API_TOKEN` |
| `{ apiKey: ... }` (in the factory call) | `{ apiToken: ... }` |
| `'mailerlite_rejected'` (error string) | `'sender_rejected'` |
| `'MailerLite rejected the subscription request'` | `'Sender rejected the subscription request'` |

- [ ] **Step 3: Typecheck the file**

Run: `npm run typecheck 2>&1 | grep -i 'subscribe.ts'`
Expected: zero errors from this file.

- [ ] **Step 4: Run unit tests as a sanity check**

Run: `npx vitest run --root worker tests/unit/sender/`
Expected: still green.

- [ ] **Step 5: Commit**

```bash
git add worker/src/handlers/subscribe.ts
git commit -m "refactor(subscribe): point handler at sender/* client"
```

---

## Task 14: Migrate `handlers/unsubscribe.ts`

**Files:**
- Modify: `worker/src/handlers/unsubscribe.ts`

- [ ] **Step 1: Update imports**

Replace:

```ts
import { createMailerLiteClient } from '../lib/mailerlite/client.js';
import { MailerLiteError } from '../lib/mailerlite/errors.js';
import { removeBbqGroups } from '../lib/mailerlite/groups.js';
import { enqueue } from '../lib/mailerlite/retry.js';
```

with:

```ts
import { createSenderClient } from '../lib/sender/client.js';
import { SenderError } from '../lib/sender/errors.js';
import { removeBbqGroups } from '../lib/sender/groups.js';
import { enqueue } from '../lib/sender/retry.js';
```

- [ ] **Step 2: Update call sites**

Find and replace within `worker/src/handlers/unsubscribe.ts`:

| Old | New |
|---|---|
| `createMailerLiteClient` | `createSenderClient` |
| `MailerLiteError` | `SenderError` |
| `rc.env.MAILERLITE_API_KEY` | `rc.env.SENDER_API_TOKEN` |
| `{ apiKey: ... }` (in the factory call) | `{ apiToken: ... }` |

No business logic changes. The `client.getSubscriberByEmail(email)` and `removeBbqGroups(client, kv, subscriberId)` call shapes are identical between MailerLite and Sender.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -i 'unsubscribe.ts'`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/handlers/unsubscribe.ts
git commit -m "refactor(unsubscribe): point handler at sender/* client"
```

---

## Task 15: Migrate `handlers/preferences.ts`

**Files:**
- Modify: `worker/src/handlers/preferences.ts`

- [ ] **Step 1: Update imports**

Replace:

```ts
import { createMailerLiteClient } from '../lib/mailerlite/client.js';
import { MailerLiteError } from '../lib/mailerlite/errors.js';
import { enqueue } from '../lib/mailerlite/retry.js';
```

with:

```ts
import { createSenderClient } from '../lib/sender/client.js';
import { SenderError } from '../lib/sender/errors.js';
import { enqueue } from '../lib/sender/retry.js';
```

- [ ] **Step 2: Update call sites**

Find and replace within `worker/src/handlers/preferences.ts`:

| Old | New |
|---|---|
| `createMailerLiteClient` | `createSenderClient` |
| `MailerLiteError` | `SenderError` |
| `rc.env.MAILERLITE_API_KEY` | `rc.env.SENDER_API_TOKEN` |
| `{ apiKey: ... }` (in the factory call) | `{ apiToken: ... }` |

The `client.updateSubscriberFields(email, fields)` call signature is identical between MailerLite and Sender — no change to the call shape. The `idempotencyKey` value `preferences:<email>` and the enqueue `kind: 'subscribe'` (or whichever kind the current handler uses) stay unchanged.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -i 'preferences.ts'`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/handlers/preferences.ts
git commit -m "refactor(preferences): point handler at sender/* client"
```

---

## Task 16: Migrate `handlers/status.ts`

**Files:**
- Modify: `worker/src/handlers/status.ts`

The status handler doesn't call any ESP client; it just reads the retry table and surfaces counts. Two diffs: table name in SQL and JSON field names in the response (per spec §6, response is renamed to vendor-neutral `esp_retry_*`).

- [ ] **Step 1: SQL rename**

Replace every `FROM mailerlite_retry` (and any `mailerlite_retry` reference in WHERE clauses or counts) with `FROM sender_retry`.

- [ ] **Step 2: Response field rename**

Find the JSON response construction. Rename:
- `mailerlite_retry_pending` → `esp_retry_pending`
- `mailerlite_retry_parked` → `esp_retry_parked`

(Use whatever exact key names the current handler emits — read the file to confirm before editing; the canonical form in spec §6 is `esp_retry_*`.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck 2>&1 | grep -i 'status.ts'`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add worker/src/handlers/status.ts
git commit -m "refactor(status): rename sender_retry + vendor-neutral esp_retry_* JSON"
```

---

## Task 17: Migrate `crons/fridayEmail.ts`

**Files:**
- Modify: `worker/src/crons/fridayEmail.ts`

This is the only non-mechanical handler change. The cron's region→env map changes from automation IDs to trigger URLs, and the trigger call changes from `client.triggerCampaign({ automationId, idempotencyTag })` to `client.triggerWeeklyDigest({ triggerUrl, idempotencyTag })`.

- [ ] **Step 1: Read the current cron**

Run: `cat worker/src/crons/fridayEmail.ts`. Note specifically:
- The `REGION_TO_AUTOMATION_ENV` const (region → env var name).
- The `FridayCronOutcome` union (specifically the `'skipped'` branch reasons).
- Where the env lookup happens for the per-region id.
- Where `client.triggerCampaign(...)` is called.

- [ ] **Step 2: Update imports**

```ts
import { createSenderClient, type SenderClient } from '../lib/sender/client.js';
import { SenderError } from '../lib/sender/errors.js';
```

(Keep the existing `regions/index.js`, `redact.js` imports.)

- [ ] **Step 3: Update region→env map**

Replace `REGION_TO_AUTOMATION_ENV` with:

```ts
const REGION_TO_TRIGGER_URL_ENV: Readonly<Record<Region, string>> = {
  northeast:     'SENDER_DIGEST_TRIGGER_URL_NORTHEAST',
  southeast:     'SENDER_DIGEST_TRIGGER_URL_SOUTHEAST',
  midwest:       'SENDER_DIGEST_TRIGGER_URL_MIDWEST',
  south_central: 'SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL',
  mountain:      'SENDER_DIGEST_TRIGGER_URL_MOUNTAIN',
  pacific:       'SENDER_DIGEST_TRIGGER_URL_PACIFIC',
};
```

- [ ] **Step 4: Update the env lookup site**

Find the line that pulls the per-region id from env (something like `const automationId = env[REGION_TO_AUTOMATION_ENV[region]];`). Change to:

```ts
const triggerUrl = env[REGION_TO_TRIGGER_URL_ENV[region]] as string | undefined;
```

Rename the local variable from `automationId` to `triggerUrl` everywhere it appears in this function. The "missing id → skip with reason `'no-automation-id'`" branch keeps the same control flow; rename the skip-reason string to `'no-trigger-url'` and update the `FridayCronOutcome` union accordingly:

```ts
export type FridayCronOutcome =
  | { region: Region; status: 'skipped'; reason: 'already-sent' | 'previously-failed' | 'no-trigger-url' | 'not-local-friday-6' }
  | { region: Region; status: 'sent'; sendDate: string }
  | { region: Region; status: 'failed'; sendDate: string; error: string; retryable: boolean };
```

- [ ] **Step 5: Update the client factory + call site**

- `createMailerLiteClient({ apiKey: env.MAILERLITE_API_KEY })` → `createSenderClient({ apiToken: env.SENDER_API_TOKEN })`
- `client.triggerCampaign({ automationId, idempotencyTag })` → `client.triggerWeeklyDigest({ triggerUrl, idempotencyTag })`
- All `MailerLiteError` references → `SenderError`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: zero errors anywhere in the worker.

- [ ] **Step 7: Commit**

```bash
git add worker/src/crons/fridayEmail.ts
git commit -m "refactor(fridayEmail): trigger Sender automation by URL not automation id"
```

---

## Task 18: Migrate test helpers

**Files:**
- Modify: `worker/tests/helpers/routeContext.ts`
- Modify: `worker/tests/helpers/fetchStub.ts` (only if it has MailerLite-specific canned responses; usually generic)

- [ ] **Step 1: Update `routeContext.ts`**

Replace:

```ts
export interface TestEnvOverrides {
  MAILERLITE_API_KEY?: string;
  SUBSCRIBER_TOKEN_SECRET?: string;
}
```

with:

```ts
export interface TestEnvOverrides {
  SENDER_API_TOKEN?: string;
  SUBSCRIBER_TOKEN_SECRET?: string;
}
```

And inside `buildContext`, replace:

```ts
MAILERLITE_API_KEY: overrides.MAILERLITE_API_KEY ?? 'ml_test_secret_key',
```

with:

```ts
SENDER_API_TOKEN: overrides.SENDER_API_TOKEN ?? 'sender_test_token',
```

- [ ] **Step 2: Audit `fetchStub.ts`**

Run: `grep -n -i 'mailerlite\|sender' worker/tests/helpers/fetchStub.ts`. If there are no hits, no edits needed (the stub is generic). If there are hardcoded host references (`connect.mailerlite.com`), update them to `api.sender.net`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add worker/tests/helpers/routeContext.ts worker/tests/helpers/fetchStub.ts
git commit -m "test: helpers expose SENDER_API_TOKEN instead of MAILERLITE_API_KEY"
```

---

## Task 19: Migrate integration tests (subscribe/unsubscribe/preferences/status)

**Files:**
- Modify: `worker/tests/integration/subscribe.test.ts`
- Modify: `worker/tests/integration/unsubscribe.test.ts`
- Modify: `worker/tests/integration/preferences.test.ts`
- Modify: `worker/tests/integration/status.test.ts`

The integration tests stub HTTP calls with `installFetchStub`. They need to swap MailerLite URL matchers for Sender ones, and update canned response shapes.

- [ ] **Step 1: Update each file's URL matchers**

For each integration test, find `installFetchStub` script entries with `match: 'mailerlite.com/...'` and replace with the corresponding `'api.sender.net/v2/...'` pattern:

| MailerLite URL fragment | Sender URL fragment |
|---|---|
| `connect.mailerlite.com/api/subscribers` | `api.sender.net/v2/subscribers` |
| `connect.mailerlite.com/api/subscribers/{email}` | `api.sender.net/v2/subscribers/{email}` (PATCH for unsubscribe + preferences) |
| `connect.mailerlite.com/api/groups` | `api.sender.net/v2/groups` |
| `connect.mailerlite.com/api/subscribers/{id}/groups/{gid}` | `api.sender.net/v2/subscribers/groups/{gid}` |
| `connect.mailerlite.com/api/automations/{id}/run` | trigger URL pattern from env var |

- [ ] **Step 2: Update response payload shapes**

Sender response shapes:
- Single-subscriber response: `{ data: { id, email, status, ... } }` (status enum: `active|unsubscribed|bounced|reported_spam|non_subscribed`).
- Groups list: `{ data: [{ id, name }, ...], links: { next: null }, meta: {...} }`.
- Group add/remove: `{ data: {} }` (or empty body — test for HTTP success only).

Update each canned `jsonResponse(...)` accordingly. If a test asserts the exact request body, update the assertion to match Sender's `fields` shape with `{$bbq_*}` wrapped keys.

- [ ] **Step 3: Update `status.test.ts`'s response field assertions**

Wherever the test asserts the JSON response includes `mailerlite_retry_pending` / `mailerlite_retry_parked`, change to `esp_retry_pending` / `esp_retry_parked`.

- [ ] **Step 4: Run integration tests**

Run: `npx vitest run --root worker tests/integration/`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/tests/integration/
git commit -m "test(integration): rewrite fetch stubs against Sender shapes"
```

---

## Task 20: Migrate cron + remaining unit tests

**Files:**
- Modify: `worker/tests/unit/crons/fridayEmail.test.ts`
- Modify: `worker/tests/unit/crons/weeklyArticle.test.ts` (only if it has MailerLite references)

- [ ] **Step 1: Update `fridayEmail.test.ts`**

Find the env var setup that supplies `MAILERLITE_AUTOMATION_*_ID` values. Replace each with `SENDER_DIGEST_TRIGGER_URL_*` set to a test URL like `'https://api.sender.net/v2/automations/trigger/{region}-test'`.

Update fetch stub URL matchers from `connect.mailerlite.com/api/automations/...` to `api.sender.net/v2/automations/trigger/...`.

Update any reference to `'no-automation-id'` skip reason → `'no-trigger-url'`.

Update body assertion: from `{ automationId: ... }` to `{ tag: '<region>:<sendDate>' }`.

- [ ] **Step 2: Audit `weeklyArticle.test.ts`**

Run: `grep -n -i 'mailerlite' worker/tests/unit/crons/weeklyArticle.test.ts`. If hits exist, rename to Sender equivalents. Likely just env-var setup that needs renaming.

- [ ] **Step 3: Run cron tests**

Run: `npx vitest run --root worker tests/unit/crons/`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add worker/tests/unit/crons/
git commit -m "test(crons): rewrite Friday cron test for sender trigger URL flow"
```

---

## Task 21: Update `migrations.test.ts`

**Files:**
- Modify: `worker/tests/unit/migrations.test.ts`

- [ ] **Step 1: Read current test**

Run: `cat worker/tests/unit/migrations.test.ts`. The test likely walks each migration file in order and asserts a final schema snapshot, OR asserts presence of specific tables/columns.

- [ ] **Step 2: Update for single-migration schema**

If the test enumerates migration files (`['0001_init.sql', '0002_metros_seed.sql', '0003_articles.sql', '0004_add_region.sql']`), narrow to `['0001_init.sql']`.

If the test asserts the presence of `mailerlite_retry` table, change to `sender_retry`.

If the test asserts column counts/CHECK constraints, update to match the new schema (see Task 12).

- [ ] **Step 3: Run migrations test**

Run: `npx vitest run --root worker tests/unit/migrations.test.ts`
Expected: pass.

- [ ] **Step 4: Now commit the deferred retry files from Task 11**

The `sender_retry` table now exists in the migration. The Task 11 staged files should pass tests.

Run: `npx vitest run --root worker tests/unit/sender/retry.test.ts`
Expected: pass.

If retry test still fails, debug the test file (likely a SQL string that still says `mailerlite_retry` somewhere) before committing.

- [ ] **Step 5: Commit (combined)**

```bash
git add worker/tests/unit/migrations.test.ts worker/src/lib/sender/retry.ts worker/tests/unit/sender/retry.test.ts
git commit -m "feat(sender): port retry.ts + migrations test for squashed 0001_init"
```

---

## Task 22: Delete old MailerLite tree

**Files:**
- Delete: `worker/src/lib/mailerlite/` (entire directory)
- Delete: `worker/tests/unit/mailerlite/` (entire directory)

- [ ] **Step 1: Confirm no remaining imports**

Run: `grep -rn 'mailerlite' worker/src worker/tests`
Expected: zero hits.

If hits remain, fix them before deleting (likely a stray import in a test helper, a comment, or an `Env` reference you missed). Re-run grep until clean.

- [ ] **Step 2: Delete the directories**

```bash
git rm -r worker/src/lib/mailerlite worker/tests/unit/mailerlite
```

- [ ] **Step 3: Run the full worker test suite**

Run: `npx vitest run --root worker`
Expected: all tests pass.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: remove worker/src/lib/mailerlite and its tests"
```

---

## Task 23: Stage 1 verification gate

**Files:** none — verification only.

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: pass (worker vitest + script node tests).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean build (the worker bundle compiles).

- [ ] **Step 4: Audit the repo for MailerLite leakage in code**

Run: `grep -rn -i 'mailerlite' worker/ wrangler.jsonc | grep -v '.wrangler/' | grep -v 'dist/'`
Expected: zero hits in `worker/` and `wrangler.jsonc`. (Docs, `.codesight/**`, top-level `.md`s, and HTML files are Stage 2.)

If hits remain, address them before moving on.

- [ ] **Step 5: No commit needed** — this is a verification step.

---

## Task 24: Write `docs/sender-setup.md`

**Files:**
- Create: `docs/sender-setup.md`

- [ ] **Step 1: Author the setup guide**

Create `docs/sender-setup.md` with this exact content:

````markdown
# Sender.net setup

Operator-side configuration the worker assumes exists. Run through this checklist after first issuing the `SENDER_API_TOKEN`.

## 1. API token

1. Sender dashboard → **Settings → API access tokens → Create**.
2. Name it (e.g. `pitmaster-prod` / `pitmaster-staging`). Scope: full.
3. Copy the token into the worker secret `SENDER_API_TOKEN` via `wrangler secret put SENDER_API_TOKEN`.

## 2. Custom subscriber fields

Subscribers → **Fields** → create the following eight fields. The `Key` column must match exactly — the worker emits `{$bbq_*}` payload tokens that resolve by key.

| Key | Type |
|---|---|
| `bbq_zip` | Text |
| `bbq_city` | Text |
| `bbq_state` | Text |
| `bbq_region` | Text |
| `bbq_cut_pref` | Text |
| `bbq_cooker_pref` | Text |
| `bbq_timezone` | Text |
| `bbq_signup_date` | Date |

## 3. Groups

Create seven groups by name. IDs are auto-assigned and cached in Cloudflare KV on first lookup (prefix `sender_group_id:`). The worker resolves group IDs by name.

- `pitmaster_all`
- `pitmaster_northeast`
- `pitmaster_southeast`
- `pitmaster_midwest`
- `pitmaster_south_central`
- `pitmaster_mountain`
- `pitmaster_pacific`

If a group is renamed or deleted/recreated, invalidate the KV cache:

```bash
wrangler kv:key delete --binding WEATHER_KV "sender_group_id:<old-name>"
```

## 4. Per-region automations

Six automations, one per region. For each:

1. **Start trigger:** "API Call Is Made".
2. **Audience filter:** subscriber is in group `pitmaster_<region>`.
3. **Content:** the weekly digest template.
4. Copy the automation's trigger URL into the matching worker secret:

| Region | Secret name |
|---|---|
| northeast | `SENDER_DIGEST_TRIGGER_URL_NORTHEAST` |
| southeast | `SENDER_DIGEST_TRIGGER_URL_SOUTHEAST` |
| midwest | `SENDER_DIGEST_TRIGGER_URL_MIDWEST` |
| south_central | `SENDER_DIGEST_TRIGGER_URL_SOUTH_CENTRAL` |
| mountain | `SENDER_DIGEST_TRIGGER_URL_MOUNTAIN` |
| pacific | `SENDER_DIGEST_TRIGGER_URL_PACIFIC` |

A missing secret dark-disables that region in the Friday cron — useful when staging onboarding for one region first.

## 5. Sending domain

`mail.pitmaster.tools` via CNAME + SPF/DKIM/DMARC on Cloudflare. The optional `SENDER_FROM_EMAIL`, `SENDER_FROM_NAME`, `SENDER_REPLY_TO` secrets are reserved for the day a handler wires `POST /v2/message/send` (none does today).

## 6. Webhooks (optional)

Sender's webhooks require the Standard plan or above. If/when wired, the worker handler verifies HMAC-SHA256 of the raw body against the per-webhook signing secret. Topics of interest: subscriber unsubscribed, bounced, reported spam.

## 7. Rate limits

Sender returns `429` with a `Retry-After: <seconds>` header on rate-limit. The worker treats 429 as retryable and the retry queue's exponential backoff handles it. Free-tier limits are not publicly published — read `X-RateLimit-Remaining` on responses to monitor headroom.
````

- [ ] **Step 2: Commit**

```bash
git add docs/sender-setup.md
git commit -m "docs: add Sender.net setup checklist"
```

---

## Task 25: Delete `docs/mailerlite-setup.md` + sweep architecture/refactor docs

**Files:**
- Delete: `docs/mailerlite-setup.md`
- Modify: `docs/portfolio-email-architecture.md`
- Modify: `docs/best-smoke-days-plan.md`
- Modify: `docs/refactor.md`

- [ ] **Step 1: Delete the old setup doc**

```bash
git rm docs/mailerlite-setup.md
```

- [ ] **Step 2: Sweep each architecture doc**

For each of `docs/portfolio-email-architecture.md`, `docs/best-smoke-days-plan.md`, `docs/refactor.md`:

Run: `grep -n -i 'mailerlite\|MAILERLITE' <file>`. For each hit, decide:
- Prose mention of MailerLite → replace with "Sender" or "Sender.net" as fits.
- Env var name → replace per Task 12 mapping.
- Code snippet → replace per the actual code change (e.g. `triggerCampaign` → `triggerWeeklyDigest`).
- Reference to `docs/mailerlite-setup.md` → `docs/sender-setup.md`.
- Reference to `mailerlite_retry` table → `sender_retry`.
- API endpoint mention → swap MailerLite endpoint for Sender equivalent.

Additionally in `docs/portfolio-email-architecture.md`: add a short note (1–2 paragraphs) explaining the "API Call Is Made" trigger URL pattern as the per-region send mechanic, replacing the old "automation run by ID" pattern. Place it near the existing description of the Friday cron flow.

- [ ] **Step 3: Re-grep**

Run: `grep -rn -i 'mailerlite' docs/`
Expected: zero hits.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: sweep architecture + refactor docs to Sender.net"
```

---

## Task 26: Sweep top-level prose files

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `codex.md`
- Modify: `.cursorrules`
- Modify: `.github/copilot-instructions.md`

- [ ] **Step 1: Sweep each file**

For each file:

Run: `grep -n -i 'mailerlite\|MAILERLITE' <file>`. For each hit:
- Replace prose mention with "Sender" / "Sender.net".
- Replace env var names per the Task 12 mapping.
- Replace any reference to `docs/mailerlite-setup.md` with `docs/sender-setup.md`.

- [ ] **Step 2: Re-grep at repo root**

Run: `grep -rn -i 'mailerlite' --include='*.md' --include='.cursorrules' --include='.github/copilot-instructions.md' .`
Expected: zero hits outside `.codesight/**` (regenerated by tooling).

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md codex.md .cursorrules .github/copilot-instructions.md
git commit -m "docs: sweep top-level prose files to Sender.net"
```

---

## Task 27: Update `.env.example` and `scripts/validate-schema.test.js`

**Files:**
- Modify: `.env.example`
- Modify: `scripts/validate-schema.test.js`

- [ ] **Step 1: Rewrite `.env.example`**

Mirror the content of `.dev.vars.example` (written in Task 12). They serve different audiences but reference the same secrets.

- [ ] **Step 2: Audit `scripts/validate-schema.test.js`**

Run: `grep -n -i 'mailerlite' scripts/validate-schema.test.js`. For each hit, replace with the Sender equivalent — likely a table name string (`mailerlite_retry` → `sender_retry`) or an asserted column in the schema validator.

- [ ] **Step 3: Run the script test**

Run: `npm run test:scripts`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add .env.example scripts/validate-schema.test.js
git commit -m "chore: align .env.example + schema validator with sender_retry"
```

---

## Task 28: Sweep smoke-weather HTML prose

**Files:**
- Modify: `_src/smoke-weather/faq.html`
- Modify: `_src/smoke-weather/status.html`

Note: `dist/smoke-weather/*.html` is build output. Don't edit `dist/` by hand — it regenerates on `npm run build`.

- [ ] **Step 1: Audit each `_src/` file**

For `_src/smoke-weather/faq.html` and `_src/smoke-weather/status.html`:

Run: `grep -n -i 'mailerlite' <file>`. For each hit, decide:
- User-visible prose ("delivered by MailerLite" / "we use MailerLite to send the weekly digest") → replace with "Sender" / "Sender.net".
- Hidden metadata (schema.org markup, comments) → replace identically.

Do NOT touch markup structure, classes, or styles.

- [ ] **Step 2: Rebuild and verify**

Run: `npm run build`
Then: `grep -rn -i 'mailerlite' dist/smoke-weather/`
Expected: zero hits (the build copies from `_src/`).

- [ ] **Step 3: Run validator**

Run: `powershell -ExecutionPolicy Bypass -File .\validate.ps1` (Windows) or whatever the repo's validation entry point is.
Expected: pass.

- [ ] **Step 4: Final repo grep (sanity)**

Run: `grep -rn -i 'mailerlite' . --include='*.md' --include='*.ts' --include='*.js' --include='*.html' --include='*.sql' --include='*.example' --include='*.jsonc' --include='.cursorrules' --include='.github/*'`
Expected: zero hits.

If any hits remain (excluding `.codesight/**` and `worker/.wrangler/tmp/**` build artifacts), address them before committing.

- [ ] **Step 5: Commit**

```bash
git add _src/smoke-weather/ dist/smoke-weather/
git commit -m "docs(smoke-weather): replace user-visible MailerLite mentions"
```

---

## Task 29: Final verification + PR

**Files:** none — verification + remote.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Repo-wide grep**

Run: `grep -rn -i 'mailerlite' . --exclude-dir=.codesight --exclude-dir=node_modules --exclude-dir=.wrangler --exclude-dir=dist 2>&1`

(Allow `dist/` hits if and only if they're inside generated build artifacts that get regenerated; if `_src/` is clean, `dist/` should be clean after a fresh build.)

Expected: zero hits.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin feat/sender-net-migration
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "Migrate MailerLite -> Sender.net" --body "$(cat <<'EOF'
## Summary
- Greenfield reset of email integration to Sender.net (no data preservation).
- New `worker/src/lib/sender/` mirrors the old `mailerlite/` surface; handlers + cron change by import path + factory only.
- D1 migrations 0001–0004 squashed into a single `0001_init.sql` with `sender_retry` table.
- Friday cron now triggers per-region "API Call Is Made" automations by URL (Sender has no run-by-id endpoint).
- Custom field payload keys wrapped as `{$bbq_*}` tokens inside the client.
- `Idempotency-Key` HTTP header dropped — client-side `idempotency_key UNIQUE` carries the load.

Spec: `docs/superpowers/specs/2026-05-16-mailerlite-to-sender-net-migration-design.md`
Operator setup: `docs/sender-setup.md`

## Test plan
- [ ] `npm test` green locally
- [ ] `npm run typecheck` green
- [ ] `npm run build` clean
- [ ] Repo grep `mailerlite` returns no hits outside `.codesight/**`
- [ ] Operator pre-flight: confirm `SENDER_API_TOKEN` secret set; confirm six `SENDER_DIGEST_TRIGGER_URL_*` secrets set (or accept dark-disable for staging); confirm 7 groups + 8 custom fields + 6 automations exist in Sender dashboard

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Run the two-gate review per global instructions**

Per `~/.claude/CLAUDE.md` PR review workflow:
1. **Codex review** first — run, fix all findings, re-run until clean.
2. **Claude review** only after Codex is clean — run, fix, re-run until clean.
3. Merge only when both reviewers return clean on the latest commit.

---

## Spec coverage map (self-review)

| Spec section | Tasks |
|---|---|
| §3.1 client.ts module surface | 3–9 |
| §3.2 groups.ts | 10 |
| §3.3 tags.ts | 2 |
| §3.4 retry.ts | 11, 21 |
| §3.5 errors.ts | 1 |
| §4 Env / wrangler / .dev.vars.example | 12 |
| §5 D1 schema reset (3a squash) | 12 |
| §6 Handler diffs | 13–16 |
| §7 Friday cron rebuild | 17 |
| §8 Tests | 1–11, 19–21 |
| §9 Docs sweep | 24–28 |
| §10 sender-setup.md outline | 24 |
| §11 Open calls baked in | reflected in code + tests across all tasks |
| §12 Stage of delivery | Stage 1: tasks 0–23; Stage 2: tasks 24–28; verification: 29 |
| §13 Non-goals | confirmed nothing pulls them back in |
| §14 Risks | mitigations land in §10 doc (task 24) + §6 status JSON rename (task 16) |
