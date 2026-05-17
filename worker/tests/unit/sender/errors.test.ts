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
