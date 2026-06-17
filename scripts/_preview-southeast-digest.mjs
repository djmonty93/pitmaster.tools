// One-off: render the Southeast Friday digest email (faithful copy of
// worker/src/lib/render/digestEmail.ts) with the real southeast metros
// and representative Sat/Sun/Mon scores. Writes southeast-digest.html.
import { writeFileSync } from 'node:fs';

// CAN-SPAM: a valid physical postal address is REQUIRED in every commercial
// email. Replace SENDER_ADDRESS with your real business mailing address (a
// street address, a USPS-registered PO Box, or a CMRA private mailbox).
const SENDER_NAME = 'Pitmaster Tools';
const SENDER_ADDRESS = 'Aureate LLC, 3419 Virginia Beach Blvd #B32, Virginia Beach, VA 23452';

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPE_MAP[c]);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const local = new Date(y, m - 1, d);
  return `${DAY_NAMES[local.getDay()]}, ${MONTH_NAMES[m - 1]} ${d}`;
}
const FULL_DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function ordinal(n) { const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function fridayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const local = new Date(y, m - 1, d);
  return `${FULL_DAYS[local.getDay()]}, ${MONTH_NAMES[m - 1]} ${ordinal(d)}`;
}
const bandLabel = (b) => (b === 'ideal' ? 'Ideal' : b === 'green' ? 'Good' : b === 'yellow' ? 'Average' : 'Poor');
const BAND_STYLE = {
  ideal: { bg: '#1B7F3B', fg: '#FFFFFF' },
  green: { bg: '#2E9E4F', fg: '#FFFFFF' },
  yellow: { bg: '#C8881A', fg: '#FFFFFF' },
  red: { bg: '#B23B2E', fg: '#FFFFFF' },
};
const WEEKLY_TOOLS = [
  { url: 'https://pitmaster.tools/brisket-calculator', name: 'Brisket Calculator', blurb: 'Dial in cook time and pull temp for your packer or flat.' },
  { url: 'https://pitmaster.tools/pork-shoulder-calculator', name: 'Pork Shoulder Calculator', blurb: 'Time your pulled pork backward from when you want to eat.' },
  { url: 'https://pitmaster.tools/rib-calculator', name: 'Rib Calculator', blurb: 'Spare or baby back — get the 3-2-1 timing right.' },
  { url: 'https://pitmaster.tools/turkey-smoking-calculator', name: 'Turkey Calculator', blurb: 'Smoke a juicy bird without the food-safety guesswork.' },
  { url: 'https://pitmaster.tools/cook-time-coordinator', name: 'Cook Time Coordinator', blurb: 'Juggle multiple cuts so everything finishes together.' },
  { url: 'https://pitmaster.tools/meat-per-person', name: 'Meat Per Person', blurb: 'Buy the right amount of raw meat for your headcount.' },
  { url: 'https://pitmaster.tools/catering-calculator', name: 'Catering Calculator', blurb: 'Scale the cook for a crowd, with sides and buffer.' },
  { url: 'https://pitmaster.tools/brine-calculator', name: 'Brine Calculator', blurb: 'Get the salt-to-water ratio right for any cut.' },
  { url: 'https://pitmaster.tools/dry-rub-calculator', name: 'Dry Rub Calculator', blurb: 'Build a balanced rub scaled to your meat weight.' },
  { url: 'https://pitmaster.tools/charcoal-calculator', name: 'Charcoal Calculator', blurb: 'Estimate how much charcoal a long cook will burn.' },
  { url: 'https://pitmaster.tools/bbq-cost-calculator', name: 'BBQ Cost Calculator', blurb: 'Price out a cook by cut, weight, and servings.' },
  { url: 'https://pitmaster.tools/brisket-yield-calculator', name: 'Brisket Yield Calculator', blurb: 'See how much cooked brisket a raw packer really yields.' },
];
function isoWeekNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 864e5));
}
const pickWeeklyTool = (sendDate) => WEEKLY_TOOLS[isoWeekNumber(sendDate) % WEEKLY_TOOLS.length];

// Append the campaign UTMs to an internal pitmaster.tools link (mirrors
// withUtm in worker/src/lib/render/digestEmail.ts). Sender's
// {{unsubscribe_link}} merge tag is never passed through here.
function withUtm(url, slot, campaign) {
  const params =
    'utm_source=newsletter&utm_medium=email' +
    `&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${encodeURIComponent(slot)}`;
  return url + (url.includes('?') ? '&' : '?') + params;
}

function scoreChip(score) {
  const s = BAND_STYLE[score.band];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700;background:${s.bg};color:${s.fg};">${escapeHtml(bandLabel(score.band))}</span>`;
}
function weekdayShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return DAY_NAMES[new Date(y, m - 1, d).getDay()];
}
// Compact, mobile-friendly: weekday-only label + score + small band chip,
// each cell a proportional 25% so four columns scale down cleanly on a
// phone while staying one short row per metro.
function dayCell(day) {
  const s = BAND_STYLE[day.score.band];
  return '<td align="center" width="25%" style="padding:8px 3px;border:1px solid #EDE7DC;font-family:Arial,Helvetica,sans-serif;">' +
    `<div style="font-size:12px;font-weight:600;color:#6B6B6B;">${escapeHtml(weekdayShort(day.date))}</div>` +
    `<div style="font-size:19px;font-weight:700;color:#2B2B2B;line-height:1.1;margin:3px 0 5px;">${day.score.score}</div>` +
    `<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;font-weight:700;background:${s.bg};color:${s.fg};">${escapeHtml(bandLabel(day.score.band))}</span>` +
    '</td>';
}
function metroRow(metro) {
  const cells = metro.days.map(dayCell).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-collapse:collapse;"><tr><td colspan="4" style="padding:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#2B2B2B;">${escapeHtml(metro.name)}</td></tr><tr>${cells}</tr></table>`;
}
function renderDigestEmail(input) {
  const metrosHtml = input.metros.map(metroRow).join('');
  const tool = input.tool;
  const campaign = input.campaign;
  const link = (url, slot) => escapeHtml(withUtm(url, slot, campaign));
  const detailUrl = link(input.detailUrl, 'forecast-cta');
  return '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    `<title>Best Smoke Days — ${escapeHtml(input.regionLabel)}</title></head>` +
    '<body style="margin:0;padding:0;background:#FAF7F1;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F1;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #EDE7DC;border-radius:8px;">' +
    '<tr><td style="padding:22px 24px 0;">' +
    `<a href="${link('https://pitmaster.tools', 'masthead')}" style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#B5651D;text-decoration:none;letter-spacing:.3px;">Pitmaster&nbsp;Tools</a>` +
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9A9A9A;margin-top:3px;">Weather-scored BBQ forecasts</div>' +
    '<div style="height:2px;background:#EDD9AA;margin:14px 0 0;"></div></td></tr>' +
    '<tr><td style="padding:16px 24px 8px;font-family:Georgia,serif;">' +
    `<h1 style="margin:0;font-size:20px;color:#2B2B2B;">Best Smoke Days — ${escapeHtml(input.regionLabel)}</h1>` +
    `<p style="margin:6px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6B6B6B;">Your weekend smoking outlook for the weekend beginning ${escapeHtml(fridayLabel(input.sendDate))}.</p></td></tr>` +
    '<tr><td style="padding:12px 24px 4px;">' + metrosHtml + '</td></tr>' +
    '<tr><td style="padding:8px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF3E6;border:1px solid #EDD9AA;border-radius:6px;"><tr><td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#B5651D;">This week’s tool</div>' +
    `<a href="${link(tool.url, 'featured-tool')}" style="display:inline-block;margin:4px 0 2px;font-size:16px;font-weight:700;color:#B5651D;text-decoration:none;">${escapeHtml(tool.name)} →</a>` +
    `<div style="font-size:13px;color:#5B5B5B;">${escapeHtml(tool.blurb)}</div></td></tr></table></td></tr>` +
    '<tr><td align="center" style="padding:16px 24px 8px;">' +
    `<a href="${detailUrl}" style="display:inline-block;padding:12px 22px;background:#B5651D;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;text-decoration:none;border-radius:6px;">See your detailed forecast for your ZIP</a>` +
    '<p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9A9A9A;">A longer, hour-by-hour forecast scored for your exact cut and cooker.</p></td></tr>' +
    '<tr><td style="padding:16px 24px 24px;border-top:1px solid #EDE7DC;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#9A9A9A;">' +
    '<p style="margin:0 0 10px;">Scores assume pork butt on an offset smoker. Your detailed forecast scores for your own cut and cooker.</p>' +
    `<p style="margin:0 0 10px;">You’re receiving this weekly Best Smoke Days forecast because you signed up at <a href="${link('https://pitmaster.tools', 'footer-signup')}" style="color:#9A9A9A;">pitmaster.tools</a>. Not interested anymore? <a href="{{unsubscribe_link}}" style="color:#B5651D;font-weight:700;">Unsubscribe here</a> and we’ll stop sending right away.</p>` +
    `<p style="margin:0 0 4px;"><strong style="color:#6B6B6B;">${escapeHtml(SENDER_NAME)}</strong><br>${escapeHtml(SENDER_ADDRESS)}</p>` +
    `<p style="margin:0;"><a href="${link('https://pitmaster.tools', 'footer-home')}" style="color:#9A9A9A;">pitmaster.tools</a> &middot; <a href="${link('https://pitmaster.tools/tools', 'footer-tools')}" style="color:#9A9A9A;">All BBQ calculators</a> &middot; <a href="${link('https://pitmaster.tools/privacy-policy', 'footer-privacy')}" style="color:#9A9A9A;">Privacy</a> &middot; <a href="{{unsubscribe_link}}" style="color:#9A9A9A;">{{unsubscribe_text}}</a></p></td></tr>` +
    '</table></td></tr></table></body></html>';
}

// --- Southeast metros + representative Fri/Sat/Sun/Mon scores (hot, humid June) ---
const FRI = '2026-06-19', SAT = '2026-06-20', SUN = '2026-06-21', MON = '2026-06-22';
const DATES = [FRI, SAT, SUN, MON];
const mk = (band, n) => ({ weekday: '', date: '', score: { score: n, band } });
function metro(name, s) {
  return { name, days: s.map((pair, i) => ({ ...mk(pair[0], pair[1]), date: DATES[i] })) };
}
const metros = [
  metro('Atlanta, GA', [['green', 76], ['green', 74], ['yellow', 61], ['yellow', 58]]),
  metro('Baltimore, MD', [['ideal', 90], ['ideal', 88], ['green', 79], ['green', 72]]),
  metro('Birmingham, AL', [['yellow', 66], ['yellow', 63], ['yellow', 55], ['red', 47]]),
  metro('Charlotte, NC', [['green', 79], ['green', 77], ['green', 70], ['yellow', 64]]),
  metro('Detroit, MI', [['ideal', 92], ['ideal', 91], ['ideal', 86], ['green', 80]]),
  metro('Jacksonville, FL', [['yellow', 57], ['yellow', 52], ['red', 44], ['red', 41]]),
  metro('Louisville, KY', [['green', 81], ['green', 78], ['green', 73], ['yellow', 66]]),
  metro('Memphis, TN', [['green', 70], ['yellow', 60], ['yellow', 54], ['red', 48]]),
  metro('Miami, FL', [['yellow', 49], ['red', 43], ['red', 39], ['yellow', 51]]),
  metro('Nashville, TN', [['green', 75], ['green', 72], ['yellow', 64], ['yellow', 59]]),
  metro('New Orleans, LA', [['red', 46], ['red', 40], ['red', 38], ['red', 45]]),
  metro('Orlando, FL', [['yellow', 54], ['yellow', 50], ['red', 46], ['yellow', 53]]),
  metro('Raleigh, NC', [['ideal', 85], ['green', 80], ['green', 74], ['green', 71]]),
  metro('Richmond, VA', [['ideal', 89], ['ideal', 86], ['green', 78], ['green', 70]]),
  metro('Tampa, FL', [['yellow', 53], ['yellow', 49], ['red', 43], ['yellow', 50]]),
  metro('Virginia Beach, VA', [['ideal', 86], ['green', 81], ['green', 75], ['ideal', 85]]),
];
const sendDate = '2026-06-19';
const html = renderDigestEmail({
  regionLabel: 'Southeast',
  sendDate,
  metros,
  tool: pickWeeklyTool(sendDate),
  detailUrl: 'https://pitmaster.tools/smoke-weather/',
  campaign: `smoke-days-southeast-${sendDate}`,
});
writeFileSync('southeast-digest.html', html);
console.log('wrote southeast-digest.html (' + html.length + ' bytes); tool=' + pickWeeklyTool(sendDate).name);
