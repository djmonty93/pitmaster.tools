// Shared types for the Best Smoke Days feature.
// Imported by worker handlers and (transpiled to JS) by the browser client.

export type Cut =
  | 'brisket-flat'
  | 'brisket-packer'
  | 'pork-butt'
  | 'spare-ribs'
  | 'baby-back-ribs'
  | 'pork-loin'
  | 'whole-chicken'
  | 'spatchcock-chicken'
  | 'chicken-thighs'
  | 'whole-turkey'
  | 'turkey-breast'
  | 'fish'
  | 'lamb-shoulder';

export type Cooker = 'offset' | 'pellet' | 'kamado' | 'kettle' | 'electric';

export type Confidence = 'high' | 'medium' | 'low';

export interface WeatherHour {
  t: string;            // ISO timestamp, UTC
  tempF: number;
  rh: number;           // 0-100
  windMph: number;
  gustMph: number;
  precipProbPct: number;
  precipIn: number;
  dewPointF: number;
}

export interface WeatherDay {
  date: string;         // YYYY-MM-DD, local
  tempHighF: number;
  tempLowF: number;
  rhMean: number;
  windMphMean: number;
  gustMphMax: number;
  precipProbPct: number;
  precipIn: number;
  dewPointMeanF: number;
  hourly: WeatherHour[];
  source: 'open-meteo' | 'nws';
  confidence: Confidence;
}

export interface ScoreInput {
  cut: Cut;
  cooker: Cooker;
  day: WeatherDay;
}

export interface ScoreResult {
  score: number;          // 0-100
  band: 'red' | 'yellow' | 'green' | 'ideal';
  stallRiskPct: number;   // 0-100
  reasons: string[];
  confidence: Confidence;
}

export interface ForecastResponse {
  zip: string;
  metro?: string;
  /**
   * Friendly display name from the geocoder (e.g. "Atlanta, Georgia").
   * Always set when the geocoder resolves. The client prefers this for
   * the verdict-hero location label, falling back to `metro` (slug) and
   * finally to the raw ZIP.
   */
  locationName?: string;
  source: 'open-meteo' | 'nws';
  generatedAt: string;
  days: Array<{
    date: string;
    day: WeatherDay;
    score: ScoreResult;
  }>;
  recommendation?: AffiliateRecommendation;
}

/**
 * F15: a single product placement chosen by the rules engine for the
 * current (cut, cooker, best-day band) tuple. The renderer must show
 * the FTC disclosure on every placement — `disclosureRequired` is
 * always `true` and is included on the wire so the client doesn't
 * need to know the policy. `productUrl` may be empty when the rule
 * matches but no merchant link is configured yet; the client should
 * render the recommendation copy without a clickthrough in that case.
 */
export interface AffiliateRecommendation {
  productId: string;
  productName: string;
  productUrl: string;
  reason: string;
  category: 'thermometer' | 'fire-management' | 'rain-cover' | 'gloves' | 'wood';
  disclosureRequired: true;
}
