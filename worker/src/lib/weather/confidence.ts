// Forecast confidence falls off with horizon. F3 (Step 3) may refine this
// using source-specific signals, but the day-index baseline is universal.

import type { Confidence } from '@shared/types';

export function confidenceByDayIndex(idx: number): Confidence {
  if (idx <= 2) return 'high';   // today, tomorrow, day after
  if (idx <= 4) return 'medium'; // 3-4 days out
  return 'low';                  // 5+ days out — directional only
}
