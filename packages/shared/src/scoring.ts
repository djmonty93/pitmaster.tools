// Scoring engine stub. Real implementation lands in Step 3.
// Kept here so worker/tests/unit/setup.test.ts can import the module path
// and confirm wiring works.

import type { ScoreInput, ScoreResult } from './types.js';

export function score(_input: ScoreInput): ScoreResult {
  throw new Error('scoring engine not implemented — wired in Step 3');
}
