#!/usr/bin/env node
/**
 * generate-metros.js — emit one HTML page per Best-Smoke-Days metro into
 * _src/smoke-weather/<slug>.html before build.js runs.
 *
 * The 50 metros embedded here must stay in lockstep with
 * worker/migrations/0001_init.sql (metros table). scripts/generate-metros.test.js
 * parses both and asserts parity.
 *
 * Stale-page guard: every emitted file carries GENERATED_MARKER as the first
 * line. Before re-emitting we delete any file in OUT_DIR containing the
 * marker, so removing a metro from METROS also removes its dist page.
 * Hand-authored pages (index.html, methodology.html, disclosures.html, …)
 * lack the marker and are left untouched.
 *
 * Usage: node scripts/generate-metros.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const OUT_DIR = path.join('_src', 'smoke-weather');
const GENERATED_MARKER = '<!-- generated:best-smoke-days-metro -->';
// Build-time partial consumed by _src/smoke-weather/metros/index.html.
// Contains one <a class="metro-tile"> per metro with data-* hooks the
// client-side chooser script (_partials/metros-chooser.js) fills in
// from /api/metros. Emitted alongside the per-metro pages so the source
// of truth for both stays the same METROS array.
const LIST_PARTIAL_OUT = path.join('_partials', 'metros-list.html');

const METROS = [
  { slug: 'new-york-ny',          name: 'New York',          state: 'NY', zip: '10001', latitude: 40.7506, longitude: -73.9971,  timezone: 'America/New_York',    population: 19867000 },
  { slug: 'los-angeles-ca',       name: 'Los Angeles',       state: 'CA', zip: '90001', latitude: 33.9731, longitude: -118.2479, timezone: 'America/Los_Angeles', population: 13201000 },
  { slug: 'chicago-il',           name: 'Chicago',           state: 'IL', zip: '60601', latitude: 41.8857, longitude: -87.6228,  timezone: 'America/Chicago',      population: 9509000 },
  { slug: 'dallas-fort-worth-tx', name: 'Dallas–Fort Worth', state: 'TX', zip: '75201', latitude: 32.7831, longitude: -96.8067,  timezone: 'America/Chicago',      population: 7637000 },
  { slug: 'houston-tx',           name: 'Houston',           state: 'TX', zip: '77001', latitude: 29.7621, longitude: -95.3831,  timezone: 'America/Chicago',      population: 7122000 },
  { slug: 'washington-dc',        name: 'Washington',        state: 'DC', zip: '20001', latitude: 38.9047, longitude: -77.0163,  timezone: 'America/New_York',     population: 6385000 },
  { slug: 'miami-fl',             name: 'Miami',             state: 'FL', zip: '33101', latitude: 25.7752, longitude: -80.2086,  timezone: 'America/New_York',     population: 6166000 },
  { slug: 'philadelphia-pa',      name: 'Philadelphia',      state: 'PA', zip: '19102', latitude: 39.9523, longitude: -75.1638,  timezone: 'America/New_York',     population: 6228000 },
  { slug: 'atlanta-ga',           name: 'Atlanta',           state: 'GA', zip: '30303', latitude: 33.7525, longitude: -84.3888,  timezone: 'America/New_York',     population: 6089000 },
  { slug: 'boston-ma',            name: 'Boston',            state: 'MA', zip: '02108', latitude: 42.3581, longitude: -71.0636,  timezone: 'America/New_York',     population: 4895000 },
  { slug: 'phoenix-az',           name: 'Phoenix',           state: 'AZ', zip: '85001', latitude: 33.4502, longitude: -112.0759, timezone: 'America/Phoenix',      population: 4946000 },
  { slug: 'san-francisco-ca',     name: 'San Francisco',     state: 'CA', zip: '94102', latitude: 37.7791, longitude: -122.4194, timezone: 'America/Los_Angeles', population: 4750000 },
  { slug: 'riverside-ca',         name: 'Riverside',         state: 'CA', zip: '92501', latitude: 33.9806, longitude: -117.3755, timezone: 'America/Los_Angeles', population: 4651000 },
  { slug: 'detroit-mi',           name: 'Detroit',           state: 'MI', zip: '48226', latitude: 42.3314, longitude: -83.0457,  timezone: 'America/Detroit',      population: 4392000 },
  { slug: 'seattle-wa',           name: 'Seattle',           state: 'WA', zip: '98101', latitude: 47.6101, longitude: -122.3343, timezone: 'America/Los_Angeles', population: 4018000 },
  { slug: 'minneapolis-mn',       name: 'Minneapolis',       state: 'MN', zip: '55401', latitude: 44.9854, longitude: -93.2738,  timezone: 'America/Chicago',      population: 3690000 },
  { slug: 'san-diego-ca',         name: 'San Diego',         state: 'CA', zip: '92101', latitude: 32.7174, longitude: -117.1628, timezone: 'America/Los_Angeles', population: 3338000 },
  { slug: 'tampa-fl',             name: 'Tampa',             state: 'FL', zip: '33602', latitude: 27.9477, longitude: -82.4584,  timezone: 'America/New_York',     population: 3194000 },
  { slug: 'denver-co',            name: 'Denver',            state: 'CO', zip: '80202', latitude: 39.7506, longitude: -105.0000, timezone: 'America/Denver',       population: 2964000 },
  { slug: 'baltimore-md',         name: 'Baltimore',         state: 'MD', zip: '21202', latitude: 39.2904, longitude: -76.6122,  timezone: 'America/New_York',     population: 2848000 },
  { slug: 'st-louis-mo',          name: 'St. Louis',         state: 'MO', zip: '63101', latitude: 38.6273, longitude: -90.1979,  timezone: 'America/Chicago',      population: 2820000 },
  { slug: 'charlotte-nc',         name: 'Charlotte',         state: 'NC', zip: '28202', latitude: 35.2271, longitude: -80.8431,  timezone: 'America/New_York',     population: 2660000 },
  { slug: 'orlando-fl',           name: 'Orlando',           state: 'FL', zip: '32801', latitude: 28.5384, longitude: -81.3789,  timezone: 'America/New_York',     population: 2674000 },
  { slug: 'san-antonio-tx',       name: 'San Antonio',       state: 'TX', zip: '78205', latitude: 29.4241, longitude: -98.4936,  timezone: 'America/Chicago',      population: 2550000 },
  { slug: 'portland-or',          name: 'Portland',          state: 'OR', zip: '97204', latitude: 45.5152, longitude: -122.6784, timezone: 'America/Los_Angeles', population: 2502000 },
  { slug: 'sacramento-ca',        name: 'Sacramento',        state: 'CA', zip: '95814', latitude: 38.5816, longitude: -121.4944, timezone: 'America/Los_Angeles', population: 2363000 },
  { slug: 'pittsburgh-pa',        name: 'Pittsburgh',        state: 'PA', zip: '15222', latitude: 40.4406, longitude: -79.9959,  timezone: 'America/New_York',     population: 2370000 },
  { slug: 'las-vegas-nv',         name: 'Las Vegas',         state: 'NV', zip: '89101', latitude: 36.1716, longitude: -115.1391, timezone: 'America/Los_Angeles', population: 2266000 },
  { slug: 'cincinnati-oh',        name: 'Cincinnati',        state: 'OH', zip: '45202', latitude: 39.1031, longitude: -84.5120,  timezone: 'America/New_York',     population: 2256000 },
  { slug: 'kansas-city-mo',       name: 'Kansas City',       state: 'MO', zip: '64108', latitude: 39.0997, longitude: -94.5786,  timezone: 'America/Chicago',      population: 2192000 },
  { slug: 'columbus-oh',          name: 'Columbus',          state: 'OH', zip: '43215', latitude: 39.9612, longitude: -82.9988,  timezone: 'America/New_York',     population: 2122000 },
  { slug: 'indianapolis-in',      name: 'Indianapolis',      state: 'IN', zip: '46204', latitude: 39.7684, longitude: -86.1581,  timezone: 'America/Indianapolis', population: 2074000 },
  { slug: 'cleveland-oh',         name: 'Cleveland',         state: 'OH', zip: '44113', latitude: 41.4993, longitude: -81.6944,  timezone: 'America/New_York',     population: 2058000 },
  { slug: 'austin-tx',            name: 'Austin',            state: 'TX', zip: '78701', latitude: 30.2672, longitude: -97.7431,  timezone: 'America/Chicago',      population: 2295000 },
  { slug: 'nashville-tn',         name: 'Nashville',         state: 'TN', zip: '37203', latitude: 36.1627, longitude: -86.7816,  timezone: 'America/Chicago',      population: 2027000 },
  { slug: 'virginia-beach-va',    name: 'Virginia Beach',    state: 'VA', zip: '23451', latitude: 36.8529, longitude: -75.9780,  timezone: 'America/New_York',     population: 1799000 },
  { slug: 'providence-ri',        name: 'Providence',        state: 'RI', zip: '02903', latitude: 41.8240, longitude: -71.4128,  timezone: 'America/New_York',     population: 1676000 },
  { slug: 'milwaukee-wi',         name: 'Milwaukee',         state: 'WI', zip: '53202', latitude: 43.0389, longitude: -87.9065,  timezone: 'America/Chicago',      population: 1573000 },
  { slug: 'jacksonville-fl',      name: 'Jacksonville',      state: 'FL', zip: '32202', latitude: 30.3322, longitude: -81.6557,  timezone: 'America/New_York',     population: 1605000 },
  { slug: 'oklahoma-city-ok',     name: 'Oklahoma City',     state: 'OK', zip: '73102', latitude: 35.4676, longitude: -97.5164,  timezone: 'America/Chicago',      population: 1450000 },
  { slug: 'raleigh-nc',           name: 'Raleigh',           state: 'NC', zip: '27601', latitude: 35.7796, longitude: -78.6382,  timezone: 'America/New_York',     population: 1413000 },
  { slug: 'memphis-tn',           name: 'Memphis',           state: 'TN', zip: '38103', latitude: 35.1495, longitude: -90.0490,  timezone: 'America/Chicago',      population: 1335000 },
  { slug: 'richmond-va',          name: 'Richmond',          state: 'VA', zip: '23219', latitude: 37.5407, longitude: -77.4360,  timezone: 'America/New_York',     population: 1310000 },
  { slug: 'louisville-ky',        name: 'Louisville',        state: 'KY', zip: '40202', latitude: 38.2527, longitude: -85.7585,  timezone: 'America/New_York',     population: 1284000 },
  { slug: 'new-orleans-la',       name: 'New Orleans',       state: 'LA', zip: '70112', latitude: 29.9511, longitude: -90.0715,  timezone: 'America/Chicago',      population: 1271000 },
  { slug: 'hartford-ct',          name: 'Hartford',          state: 'CT', zip: '06103', latitude: 41.7637, longitude: -72.6851,  timezone: 'America/New_York',     population: 1213000 },
  { slug: 'salt-lake-city-ut',    name: 'Salt Lake City',    state: 'UT', zip: '84111', latitude: 40.7608, longitude: -111.8910, timezone: 'America/Denver',       population: 1257000 },
  { slug: 'birmingham-al',        name: 'Birmingham',        state: 'AL', zip: '35203', latitude: 33.5186, longitude: -86.8104,  timezone: 'America/Chicago',      population: 1115000 },
  { slug: 'buffalo-ny',           name: 'Buffalo',           state: 'NY', zip: '14202', latitude: 42.8864, longitude: -78.8784,  timezone: 'America/New_York',     population: 1130000 },
  { slug: 'tulsa-ok',             name: 'Tulsa',             state: 'OK', zip: '74103', latitude: 36.1540, longitude: -95.9928,  timezone: 'America/Chicago',      population: 1015000 },
];

// State -> region (must match REGION_BY_STATE in worker/migrations/0001_init.sql).
// MO sits in south_central on purpose: KC BBQ aligns with TX/OK/AR.
const REGION_BY_STATE = {
  CT: 'northeast', MA: 'northeast', ME: 'northeast', NH: 'northeast',
  NJ: 'northeast', NY: 'northeast', PA: 'northeast', RI: 'northeast', VT: 'northeast',
  AL: 'southeast', DC: 'southeast', DE: 'southeast', FL: 'southeast', GA: 'southeast',
  KY: 'southeast', MD: 'southeast', MS: 'southeast', NC: 'southeast', SC: 'southeast',
  TN: 'southeast', VA: 'southeast', WV: 'southeast',
  IA: 'midwest', IL: 'midwest', IN: 'midwest', KS: 'midwest', MI: 'midwest',
  MN: 'midwest', ND: 'midwest', NE: 'midwest', OH: 'midwest', SD: 'midwest', WI: 'midwest',
  AR: 'south_central', LA: 'south_central', MO: 'south_central',
  OK: 'south_central', TX: 'south_central',
  AZ: 'mountain', CO: 'mountain', ID: 'mountain', MT: 'mountain', NM: 'mountain',
  NV: 'mountain', UT: 'mountain', WY: 'mountain',
  AK: 'pacific', CA: 'pacific', HI: 'pacific', OR: 'pacific', WA: 'pacific',
};

const STATE_NAME = {
  AL: 'Alabama', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DC: 'the District of Columbia', DE: 'Delaware', FL: 'Florida',
  GA: 'Georgia', IL: 'Illinois', IN: 'Indiana', KY: 'Kentucky', LA: 'Louisiana',
  MA: 'Massachusetts', MD: 'Maryland', MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri',
  MS: 'Mississippi', NC: 'North Carolina', NV: 'Nevada', NY: 'New York', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VA: 'Virginia',
  WA: 'Washington', WI: 'Wisconsin',
};

const REGION_LABEL = {
  northeast:     'Northeast',
  southeast:     'Southeast',
  midwest:       'Midwest',
  south_central: 'South Central',
  mountain:      'Mountain',
  pacific:       'Pacific',
};

// Per-state BBQ heritage. States without entries fall back to the regional default.
const BBQ_HERITAGE_BY_STATE = {
  TX: 'Texas barbecue is brisket country first. The post-oak fires of Central Texas built a salt-and-pepper, low-and-slow tradition where the cooker is almost always an offset stick burner and the cook is judged by bark, smoke ring, and the way the slice pulls apart. The brisket’s stall is the dominant clock — long, flat, frustrating — and the only enemy worse than a four-hour plateau is a windy Saturday that drags pit temperature off target. Pellet cookers have gained ground but the regional benchmark is still wood in a firebox.',
  TN: 'Tennessee barbecue runs in two directions. Memphis is dry-rubbed ribs and pulled pork over hickory — competition pitmasters here built half the country’s BBQ vocabulary. Nashville leans toward smoked chicken, hot-chicken cousins, and a growing brisket scene over the last decade. Either city sits in the humid Mid-South, where summer dew points punish long stalls and afternoon storms are a recurring Saturday hazard. Cookers run the spectrum — offsets, kamados, pellet grills — and the regional preference is heavy fruit-wood smoke.',
  NC: 'North Carolina barbecue is pork. Eastern Carolina cooks the whole hog over coals and dresses chopped meat with thin vinegar-and-pepper sauce; Lexington-style adds tomato and the shoulder cut. Either way the cuts run long — overnight pits or 12-plus-hour shoulders — and the wet, mild climate east of the Blue Ridge keeps stalls hot and stubborn. A good Carolina cook tracks rain and wind closely because the typical pit is open or barely enclosed, and a storm rolling through during the stall can wreck the cook.',
  KY: 'Western Kentucky owns one of the country’s most unusual barbecue traditions — slow-smoked mutton, often with a thin black “dip” sauce that uses Worcestershire as a backbone. Louisville and Lexington blend that with the broader Southern pulled-pork and rib catalog, and the regional climate stays humid year-round. Mutton’s long, fatty cook is unforgiving of wind on a stick burner, so kamados and pellet cookers do well in the spring and fall shoulder seasons.',
  AL: 'Alabama runs on smoked chicken finished with white sauce — a mayonnaise-based dressing pioneered in north Alabama that became the regional signature. Pulled pork and ribs round out the menu, and the cooker of choice is whatever holds steady heat under the state’s humid, hot climate. Long cooks battle high dew points all summer; the score’s stall-risk weighting matters here even more than in drier states.',
  GA: 'Georgia barbecue lives in the gap between Carolina-style chopped pork and Memphis-style ribs, and most pits in the state run both. Brunswick stew is the regional side dish that ties the cook together. Atlanta and Savannah both sit in the humid Southeast, so the long-stall cuts spend long hours in the wet-bulb zone where evaporative cooling stalls internal temperature for hours. A pellet cooker handles that comfortably; an offset needs an attentive fire and a wind read.',
  VA: 'Virginia barbecue is chopped pork shoulder, often with a sweeter tomato-vinegar blend that bridges Carolina and the broader Mid-Atlantic. Richmond and the Tidewater region see frequent summer humidity and the occasional coastal storm; the piedmont and Blue Ridge run drier in the fall. Brisket, ribs, and smoked turkey are all common alongside the regional pork tradition, and a wind-sheltered backyard buys back a lot of accuracy on an offset cook.',
  OK: 'Oklahoma barbecue takes Texas brisket and Memphis ribs and adds a third pillar — smoked bologna, sliced thick and treated like a real cut. Pit cookers in the state lean toward stick burners and the long, low fires that go with them. Wind is the big variable: open prairie south and west of Tulsa can punish an offset, and the score’s wind weighting reflects that. Pellet and kamado cooks tolerate it better, at the cost of some bark and smoke depth.',
  LA: 'Louisiana adds Creole and Cajun influence to the broader Southern barbecue catalog — andouille and smoked sausages share the pit with brisket, ribs, and pulled pork. New Orleans and Baton Rouge both sit on the Gulf, so summer humidity and afternoon thunderstorms are constant variables. A well-insulated kamado or kettle does well here; the long stall on a packer brisket in Louisiana summer is the textbook case the score’s wet-bulb model was built for.',
  FL: 'Florida barbecue is a regional fusion — Carolina pork shoulder, Texas brisket, Caribbean influences in the south, and a heavy slate of smoked seafood and chicken. The climate runs from humid subtropical in Jacksonville and Orlando to genuinely tropical south of Lake Okeechobee. Summer afternoons are storm-prone everywhere; the score factors rain and wet-bulb temperature aggressively because both move the smoke day’s verdict in Florida more than most states.',
  MO: 'Missouri carries two distinct barbecue traditions in one state. Kansas City is the home of burnt ends — caramelized cubes off the point of a packer brisket — paired with sweet tomato-and-molasses sauce and heavy hickory smoke. St. Louis built its own style around spareribs cut St. Louis-style and finished with a tomato-based sauce that’s sharper than Kansas City’s. Either city cooks low and slow; the regional climate runs humid in summer and windy through spring and fall, and the score’s wind and stall-risk weights both come into play.',
  AZ: 'Arizona barbecue is a transplant tradition that pulls hard from Texas and California. Phoenix and Tucson pitmasters run brisket, ribs, and pulled pork through the long, dry desert summers, and the regional climate gift is short stalls — low dew points mean evaporative cooling doesn’t hold internal temperature flat the way it does in the Southeast. The trade is moisture loss; long cooks here favor butcher paper over foil to keep the bark intact while protecting against the dry air.',
  CO: 'Colorado barbecue is a high-altitude cook. Denver pitmasters run the full Texas brisket and Memphis rib menu, and the regional climate offers dry summers with big day-night temperature swings. Altitude is the variable that catches first-time mountain cooks off guard: a pit at 5,000 feet runs differently than one at sea level, water boils lower, and the wrap-and-rest window changes. Butcher paper wins over foil in the dry air.',
  NV: 'Nevada barbecue is a Las Vegas import scene that runs every regional style on the same week’s menu. The desert climate is hot and dry through summer, mild in winter, and the day-night temperature swing is significant. Long cooks face short stalls and aggressive bark formation; moisture loss is the variable that needs management. Insulated kamados and pellet cookers handle Vegas summers well; an open offset works best in the spring and fall shoulder seasons.',
  UT: 'Utah barbecue centers on Salt Lake City’s growing pitmaster scene — brisket, ribs, and pulled pork drawn from Texas and Memphis traditions. The high-altitude climate gives short stalls, low dew points, and big day-night swings, and the Wasatch Front sees genuinely cold winters that close down open-firebox cookers. Insulated kamados and pellet rigs hold their cook through the cold months when offsets struggle.',
  CA: 'California has built its own modern barbecue mostly in the last twenty years. Santa Maria tri-tip is the long-standing tradition, but pitmasters across Los Angeles, San Francisco, San Diego and Sacramento now run full Texas and Carolina menus on offsets, pellets, kamados and kettles. The climate is the gift: mild marine air, low summer humidity along the coast, and a calendar that stays open year-round. The stall is shorter than in the humid Southeast.',
  OR: 'Oregon barbecue is a Pacific Northwest synthesis — Portland pitmasters cook Texas brisket, Memphis ribs, Carolina pulled pork and Pacific Northwest smoked salmon out of the same pits. The regional climate is mild and wet most of the year; summer is the dry window and the strongest smoke season. Winters are cold and rainy but rarely cold enough to shut down an insulated kamado or pellet cooker.',
  WA: 'Washington barbecue runs the Seattle-style smoked salmon tradition alongside a growing brisket and rib scene. The marine climate is mild and damp most of the year, with summer offering the longest dry window for offset cooks. Winters are cold and persistently wet; insulated kamados and pellet rigs hold their cook better than open-firebox offsets through the dark months.',
};

// Regional default heritage (used when no state-level entry matches).
const BBQ_HERITAGE_BY_REGION = {
  northeast:     'The Northeast doesn’t have a single barbecue tradition — it has a long-running embrace of every other region’s style. Pitmasters here cook brisket from Texas, ribs from Memphis, pulled pork from Carolina, and burnt ends from Kansas City, all in the same yard. Climate is the dominant factor: hot, humid summers with thunderstorms and cold, windy winters that close the smoke season for any uninsulated cooker. Spring and fall are the strongest windows.',
  southeast:     'The Southeast carries the deepest barbecue traditions in the country — Carolina pork, Memphis ribs, Alabama smoked chicken, and Georgia and Florida hybrids all share the same hot, humid summer climate. Long stalls are the regional norm because dew points stay high from May through September. A well-insulated kamado or pellet cooker handles the humidity comfortably; offsets reward an attentive fire-tender and a careful read on afternoon storm cells.',
  midwest:       'Midwest barbecue runs strong regional scenes in Chicago, Cleveland, Cincinnati, Minneapolis, Milwaukee, Indianapolis and Detroit. The cook calendar shifts hard with the seasons: humid Saturdays in July, windy Saturdays in March, cold Saturdays in January that close down everything except an insulated kamado or pellet cooker. Brisket, ribs, pulled pork and smoked chicken are all common, and the score’s wind weighting matters more here than in calmer regions.',
  south_central: 'South-Central barbecue is the country’s deepest brisket tradition — Texas, Oklahoma and Arkansas built the playbook, and Missouri’s Kansas City crowd added burnt ends and sweet sauce to the regional vocabulary. Pit cookers lean heavily toward offset stick burners running post oak or hickory. The climate is hot, humid in summer, and windy almost year-round on the plains; the score’s wind weighting reflects how often a Saturday cook here is decided by gust speed.',
  mountain:      'Mountain-state barbecue is a dry-climate cook. Phoenix, Las Vegas, Denver and Salt Lake City all run hot, dry summers — low dew points mean shorter stalls and faster bark formation, but the same dryness pulls moisture out of the cook quickly. Altitude is the second factor: a pit at 5,000 feet runs differently than one at sea level. Long cooks here favor butcher paper over foil to preserve bark.',
  pacific:       'The West Coast built its own barbecue mostly in the last twenty years. Modern pitmasters across the Pacific run full Texas and Carolina menus on offsets, pellets, kamados and kettles. The climate is the gift: mild marine air, low summer humidity along the coast, and predictable seasonal patterns. The stall is shorter than in the humid Southeast and East, and wind off the Pacific is the variable to watch on an offset cook.',
};

const REGION_CLIMATE = {
  northeast:     'The Northeast’s smoke calendar shifts dramatically with the season. Summers run warm and humid with frequent afternoon thunderstorms; winters bring cold, snow, and steady gradient winds that pull an offset fire hard. Spring and fall — when daytime highs sit between 50 and 75 °F and dew points drop — are the strongest windows for long cooks. A well-insulated kamado or pellet cooker buys back winter Saturdays the offset crowd has to skip. Watch the gust forecast in spring, when frontal passages can swing wind speeds 25 mph in a single afternoon.',
  southeast:     'The Southeast’s defining variable is humidity. Summer dew points routinely sit in the 70s, which translates directly into the wet-bulb temperature that drives evaporative cooling on a brisket or pork-butt cook. Long stalls are the norm from May through September. Winters are mild but increasingly damp and storm-prone, and tropical systems through autumn can erase a planned Saturday cook with no warning. The score weighs stall risk heavily for this region — a humid day on an offset asks a lot of the fire-tender.',
  midwest:       'The Midwest swings hard between seasons. Winter brings clear, cold, often very windy days that punish open-firebox cookers; summer brings heat, humidity, and the occasional severe afternoon storm. Spring and fall — generally May into June and September into October — are the strongest windows for low-and-slow cooks, with stable daytime temperatures in the 60s and 70s and lower dew points than the Southeast. Wind is the variable to track regardless of season; gust spikes punish offsets and reward kamados and pellet cookers.',
  south_central: 'South-Central weather sits at the intersection of Gulf moisture and continental dry air. Summer afternoons run hot and either humid (Louisiana, east Texas, eastern Oklahoma) or dry (west Texas, west Oklahoma). Spring brings strong frontal-line storms and very high wind. Winter is mild compared to the Midwest but the wind almost never quits, and an offset stick burner here lives by the gust forecast. Long stalls in summer humidity are the textbook condition the wet-bulb weighting was built for.',
  mountain:      'Mountain-state weather is dry, sunny, and big-swinging. Daytime highs in summer can reach the high 90s with dew points in the 30s, which means very short stalls and aggressive bark formation. Nights cool 30 to 40 °F off the daytime high, and that swing affects overnight cooks more than most regions. Altitude lowers boiling point and changes wrap-and-rest behavior. Winter is cold but sunny; a sun-warmed insulated cooker holds temp better than the air-temperature reading would suggest.',
  pacific:       'The Pacific climate is mild and marine-influenced. Summer along the coast rarely climbs above 80 °F, dew points stay moderate, and the only persistent variable is afternoon wind off the water. Inland from the coast — eastern Oregon, central California — the picture shifts toward the dry, hot pattern of the Mountain region. Winters are wet, especially north of San Francisco, but rarely cold enough to shut down a well-insulated cooker. The cook calendar is the longest of any region; weekend windows survive year-round.',
};

const REGION_COOKER_TIP = {
  northeast:     'For Northeast backyards, a pellet cooker or insulated kamado gives the widest weekend window — both shrug off the gradient winds that hit between November and April, and both hold steady temps when an open offset would fight back. An offset stick burner is still the standard for serious brisket cooks here, but plan it for May-October Saturdays and watch the gust forecast on the day.',
  southeast:     'For Southeast cooks, the priority is humidity tolerance. A well-insulated kamado runs efficient stalls and conserves fuel through the long, hot summer. Pellet cookers handle the same conditions cleanly. An offset is rewarding when the weather behaves but the regional climate stacks the deck against it — high dew points and pop-up storms are constant variables.',
  midwest:       'For Midwest cooks, plan around the wind first and temperature second. A pellet or insulated kamado gives the most reliable weekend cook from March through November. Offsets work well during the calm windows of late spring and early fall; winter cooks are practical on insulated kamado or pellet rigs only.',
  south_central: 'South-Central pitmasters live with wind, and the offset stick burner remains the regional standard despite it. Build a wind break, watch the gust forecast, and lean toward heavier woods (post oak, hickory) that can hold smoke through long stalls. A pellet or kamado is a practical second cooker for the windiest weekends.',
  mountain:      'Mountain cooks benefit from cooker choices that hold moisture. Butcher paper over foil for the wrap, water pans for offsets, and shorter rest windows reduce the dry-out risk that comes with low dew points. Insulated kamados perform best in this climate; an offset works well if you build the cook around the moisture loss the dry air imposes.',
  pacific:       'Pacific cooks have the easiest climate in the country and the widest cooker latitude. Offsets, pellets, kamados, kettles and electrics all work well most of the year. The variable to plan around is coastal wind in the afternoons; an inland yard a few miles back from the water sees less of it.',
};

// Per-metro 1-2 sentence note woven into the intro paragraph. Keeps every
// page editorially distinct from its same-state siblings (TX has 4 metros,
// FL has 4, OH has 3, NC/CA/TN/VA/OK/PA/MO/NY all have 2+) so Google
// doesn't see near-duplicate landing pages. Required for every slug in
// METROS; the test enforces parity.
const METRO_NOTE = {
  'new-york-ny':          'New York’s restaurant-grade pit scene runs out of Brooklyn and the outer boroughs, where Texas-trained pitmasters built brisket-first menus on industrial wood-burning offsets in the 2010s.',
  'los-angeles-ca':       'Los Angeles is the West Coast’s largest Texas-style brisket scene, with smokehouses in the Arts District and Inglewood that built their reputations on the same post-oak fires Austin runs.',
  'chicago-il':           'Chicago barbecue is rib-tip and hot-link country — the city’s South Side pit shops kept their own tradition alive long before brisket showed up, and aquarium smokers behind plexiglass remain a Chicago signature.',
  'dallas-fort-worth-tx': 'Dallas-Fort Worth runs a competition-heavy pit scene, and the Metroplex’s modern smokehouses adopted Austin’s Central Texas brisket playbook in the 2010s.',
  'houston-tx':           'Houston blends Central Texas brisket with Gulf Coast seafood smoke and a strong Mexican-influenced barbacoa tradition that runs through the city’s east and south sides.',
  'washington-dc':        'DC’s barbecue scene runs Carolina pulled pork alongside Texas brisket, with a small but steady set of restaurant pits in the Shaw and H Street corridors.',
  'miami-fl':             'Miami barbecue draws hard from Caribbean and Cuban influences — citrus marinades, slow-smoked pork, and tropical-fruit woods sit alongside the regional Carolina and Texas styles.',
  'philadelphia-pa':      'Philadelphia’s pit scene is restaurant-driven and Texas-leaning, with brisket-and-rib-tip menus that built a following in Fishtown and North Philly in the last decade.',
  'atlanta-ga':           'Atlanta is the South’s pit-restaurant hub, with multiple legacy pulled-pork rooms in the city plus a wave of newer Texas-style brisket houses across the metro area.',
  'boston-ma':            'Boston’s pit scene runs Carolina-style pulled pork and Memphis-style ribs in equal measure, and the regional climate makes May through October the strongest backyard cook window.',
  'phoenix-az':           'Phoenix’s pit scene runs Texas brisket and Memphis ribs through the long, dry summers — the regional benefit is short stalls; the trade is heavy moisture loss across the cook.',
  'san-francisco-ca':     'San Francisco’s barbecue scene is small but precise — Texas-trained pitmasters operate compact restaurants in the East Bay and South Bay using offsets that benefit from the city’s mild marine climate.',
  'riverside-ca':         'Riverside and the Inland Empire run a backyard-heavy pit scene with hot, dry summers — the desert climate gives short stalls and aggressive bark formation versus the coastal half of California.',
  'detroit-mi':           'Detroit barbecue is a mix of Memphis-style ribs and Carolina pulled pork, with neighborhood pit spots that survived the city’s downturn and a newer wave of brisket houses adding to the menu.',
  'seattle-wa':           'Seattle’s pit scene runs alder-smoked salmon alongside a growing brisket-and-rib tradition — Pacific Northwest woods and the marine climate’s mild summers favor longer, cooler cooks.',
  'minneapolis-mn':       'Minneapolis-St. Paul is a winter-tested pit scene where insulated kamados and pellet rigs dominate from November through March, and offset brisket cooks own the summer Saturdays.',
  'san-diego-ca':         'San Diego’s coastal climate gives the easiest barbecue weather in the contiguous US — mild marine air, low humidity, and a calendar that genuinely stays open year-round for offset cooks.',
  'tampa-fl':             'Tampa’s pit scene combines Carolina pulled pork with Latin and Caribbean influence — Cuban-pork roots run deep, and the regional climate’s afternoon storm pattern decides most Saturdays.',
  'denver-co':            'Denver runs the Mile High City’s barbecue at altitude — a pit at 5,280 feet behaves differently than one at sea level, water boils lower, and wrap-and-rest timing shifts accordingly.',
  'baltimore-md':         'Baltimore’s pit scene runs pit beef as a regional signature alongside the broader pulled-pork and brisket traditions — the Chesapeake region adds smoked seafood to the standard menu.',
  'st-louis-mo':          'St. Louis built its own rib style — cut St. Louis-style from the spare rack, finished with a tomato-based sauce that’s sharper than Kansas City’s — and the city’s pit shops keep the tradition alive.',
  'charlotte-nc':         'Charlotte sits between Eastern Carolina’s whole-hog tradition and Lexington’s shoulder-and-tomato style — both menus appear across the metro, often in the same pit house.',
  'orlando-fl':           'Orlando’s pit scene draws on both Carolina pulled-pork and Texas-brisket traditions — the Central Florida climate’s summer-storm pattern is the variable that decides most weekends.',
  'san-antonio-tx':       'San Antonio’s pit scene blends Central Texas brisket with a strong barbacoa tradition — pit-cooked cabeza and beef cheek have a longer history in the city than the brisket that put Texas on the BBQ map.',
  'portland-or':          'Portland’s barbecue scene is small but inventive — Pacific Northwest pitmasters run Texas brisket and Carolina pork alongside alder-smoked salmon and locally-foraged wood blends.',
  'sacramento-ca':        'Sacramento’s pit scene runs a Central Valley take on Texas brisket — hot, dry summers give short stalls, and the regional pellet-cooker culture is among the strongest in California.',
  'pittsburgh-pa':        'Pittsburgh’s pit scene runs neighborhood-driven Carolina pulled pork and Memphis ribs, and the city’s three-river microclimate adds a wind-and-humidity variable that the regional default doesn’t capture.',
  'las-vegas-nv':         'Las Vegas brings every regional barbecue style under one roof in resort-and-restaurant menus, but the city’s backyard pit scene is real too — desert summers reward insulated cookers and shorter rest windows.',
  'cincinnati-oh':        'Cincinnati barbecue blends Memphis-style ribs and Carolina pulled pork — the city’s German-immigrant heritage also threads smoked sausage and brats into the regional pit menu.',
  'kansas-city-mo':       'Kansas City is the home of burnt ends — caramelized cubes off the point of a packer brisket — and the regional sweet tomato-and-molasses sauce that defines KC barbecue worldwide.',
  'columbus-oh':          'Columbus is a Midwest college-town pit scene with a strong restaurant-pit presence in Short North and German Village — Carolina pork, Memphis ribs, and Texas brisket all share menu space.',
  'indianapolis-in':      'Indianapolis runs a contest-heavy Midwest pit scene — the city’s Memorial Day weekend doubles as one of the country’s largest barbecue holidays, and pit shops calibrate their menus around it.',
  'cleveland-oh':         'Cleveland’s pit scene leans Eastern European in its sausage tradition — kielbasa and brats share pit space with the regional Carolina pulled pork and Memphis rib menu.',
  'austin-tx':            'Austin is the modern center of Central Texas barbecue — Franklin Barbecue, Terry Black’s, La Barbecue and the post-oak smokehouses around the city set the standard for brisket worldwide.',
  'nashville-tn':         'Nashville’s pit scene runs hot chicken alongside the regional pulled-pork and rib tradition — the city’s growing brisket scene over the last decade adds a Texas layer to the Mid-South playbook.',
  'virginia-beach-va':    'Virginia Beach sits in the Tidewater region — pit shops here run Carolina-bridged pulled pork alongside smoked seafood, and coastal storms decide more Saturdays than humidity does.',
  'providence-ri':        'Providence’s pit scene is small and restaurant-driven — Rhode Island’s coastal climate makes May through October the strongest cook window, and offsets rule the regional benchmark.',
  'milwaukee-wi':         'Milwaukee’s pit scene runs sausage-heavy German and Polish traditions alongside Carolina pulled pork — the regional Friday-fish-fry calendar coexists with summer Saturday smokes.',
  'jacksonville-fl':      'Jacksonville sits north of Florida’s tropical zone in genuinely humid subtropical climate — Carolina pulled pork and Texas brisket dominate the regional pit menu, and afternoon storms decide most Saturday cooks.',
  'oklahoma-city-ok':     'Oklahoma City runs the state’s blend of Texas brisket, Memphis ribs, and smoked bologna — wind is the regional variable, and OKC’s central-plains position keeps the gust forecast in play almost year-round.',
  'raleigh-nc':           'Raleigh-Durham’s pit scene runs both Eastern Carolina whole-hog and Lexington shoulder traditions — the Research Triangle’s wave of newer Texas-style brisket houses adds a third layer to the regional menu.',
  'memphis-tn':           'Memphis is the world capital of dry-rubbed ribs and pulled pork — the city’s Memphis-in-May contest is one of the country’s three largest BBQ competitions, and local pit shops set the standard for the style.',
  'richmond-va':          'Richmond’s pit scene runs Virginia chopped pork as its regional backbone, with newer Texas-style brisket houses adding to the menu — the James River corridor sees frequent summer humidity.',
  'louisville-ky':        'Louisville barbecue runs western Kentucky’s mutton tradition alongside the regional pulled-pork and rib menu — black-dip mutton sauce remains a Louisville signature.',
  'new-orleans-la':       'New Orleans threads Creole and Cajun smoke into the regional barbecue catalog — andouille and tasso ham share pit space with brisket and ribs, and Gulf humidity decides most summer Saturdays.',
  'hartford-ct':          'Hartford’s pit scene runs a New England take on Memphis ribs and Carolina pulled pork — the regional climate gives strong May-October cook windows and tough November-March ones.',
  'salt-lake-city-ut':    'Salt Lake City barbecue runs Texas brisket and Memphis ribs at altitude — the Wasatch Front’s dry summer climate gives short stalls; the trade is aggressive moisture loss across the cook.',
  'birmingham-al':        'Birmingham runs Alabama white-sauce smoked chicken as the regional signature — Big Bob Gibson’s white sauce defined the style, and pit shops across the metro keep the tradition alive.',
  'buffalo-ny':           'Buffalo’s pit scene is small but local — beef-on-weck and chicken-wing traditions coexist with Carolina-style pulled pork and brisket, and lake-effect winters close most backyard cooks December-March.',
  'tulsa-ok':             'Tulsa’s pit scene shares Oklahoma City’s Texas-brisket-and-smoked-bologna playbook — the Arkansas River corridor and northeast Oklahoma woods give the regional cook a distinct hickory-and-pecan flavor.',
};

// Per-metro local guide (Milestone 6). A 150-200 word, metro-SPECIFIC section
// (distinct climate calendar + practical home-pitmaster advice) that gives each
// page genuine unique content beyond the region-shared heritage/climate
// editorial above. Stored as an array of plain-text paragraphs; renderMetro
// escapes and wraps each in <p>. Rolled out in batches — a metro renders the
// local-guide section only once it has an entry here, and the test enforces a
// 150-word floor plus cross-metro uniqueness on the entries that exist.
const METRO_LOCAL = {
  'new-york-ny': [
    'New York City’s smoke calendar is a four-season negotiation. The strongest backyard windows are late spring and early fall — May, June, September, and October — when daytime highs sit in the 60s and 70s and dew points drop off the muggy July-and-August peak. Midsummer cooks are doable, but the humidity stretches the stall and pop-up thunderstorms roll through often enough that you should check the radar before committing a 12-hour brisket. Winter is the real constraint: December through February bring cold, snow, and gusty winter wind that can shut an open offset down for weeks.',
    'If you’re cooking on a Brooklyn rooftop or a Queens backyard, wind is the quiet enemy — gradient flow between buildings can swing an offset’s pit temperature 30 degrees. An insulated kamado or pellet cooker buys back most winter and shoulder-season Saturdays, holding temperature when an open firebox would fight you. Save the stick-burner brisket cooks for the calm, dry days the score flags green, build a wind break if your space allows, and start any long cook before dawn so the stall lands in daylight while you can still manage the fire.',
  ],
  'los-angeles-ca': [
    'Los Angeles has some of the friendliest smoking weather in the country, and the calendar barely closes. Coastal and basin neighborhoods stay mild most of the year — dew points are low, rain is rare outside the winter wet spells, and even January often delivers cookable Saturdays. The main seasonal variable is heat: the inland San Fernando and San Gabriel valleys push into the 90s and beyond from July through September, and a Santa Ana wind event can spike both temperature and fire risk, so check conditions before lighting on a red-flag day.',
    'The low humidity is a gift and a tax. Stalls run shorter here than in the humid Southeast, so a packer brisket moves faster — but the dry air also pulls moisture out of the cook, so lean toward butcher paper over foil to protect the bark and keep a water pan in the offset. LA’s mild marine layer lets an open stick burner run comfortably most weekends; the day to watch is a gusty, bone-dry Santa Ana afternoon, when wind drags pit temperature and the fire wants to run hot. Pick a low-wind day off the score and you can cook almost any weekend.',
  ],
  'chicago-il': [
    'Chicago’s smoke season swings as hard as any city on this list. The best backyard windows are late spring and early fall — May into June, then September into October — when highs settle in the 60s and 70s and the lake breeze stays mild. Summer brings heat, humidity, and severe afternoon storm cells that can erase a planned Saturday with little warning, so watch the radar in July and August. Winter is the wall: December through February deliver brutal cold and persistent wind off the lake, closing an open-firebox cook down for weeks at a stretch.',
    'Wind is the year-round variable here, and an offset in an exposed yard pays for it in fuel and temperature swings. An insulated kamado or pellet cooker is the practical choice for shoulder-season and winter Saturdays — both hold their cook when a stick burner would be chasing the gauge. If you run an offset, build a wind break, save the long brisket cooks for the calm green days the score flags, and start before dawn so the stall clears while you still have daylight to work the fire.',
  ],
  'dallas-fort-worth-tx': [
    'Dallas–Fort Worth gives a long smoke season bracketed by two hazards: spring storms and summer heat. The strongest windows are the shoulder months — March into May before the worst storms, then October and November once the heat breaks. Late spring brings the Metroplex’s signature severe weather, with frontal lines that drop wind, hail, and rain fast, so a long weekend cook in April or May needs a close read on the gust and storm forecast. July through September runs hot and humid, which is workable but asks a lot of an exposed pit.',
    'Wind is the constant on the North Texas prairie, and the region’s offset-stick-burner tradition lives by the gust forecast. Build a wind break, run heavier woods like post oak that hold smoke through a long stall, and watch pit temperature closely when a front is moving through. Summer’s lower humidity shortens the stall compared with the Gulf Coast, but the dry heat pulls moisture, so favor butcher paper on the wrap. For the windiest Saturdays, an insulated kamado or pellet cooker is the reliable backup when an open firebox would spend the day fighting gusts.',
  ],
  'houston-tx': [
    'Houston’s defining smoke variable is Gulf humidity. Dew points climb into the 70s through the long summer, which drives a high wet-bulb temperature and the long, stubborn stalls that define a Houston brisket cook. The most comfortable windows are late fall through early spring — November into March — when the air dries out and cools off. Summer is hot, sticky, and storm-prone, and Gulf hurricane season runs June through November with peak risk from late summer into early fall, so any long-range weekend plan in that stretch should carry a weather contingency.',
    'This humidity is exactly the condition the score’s wet-bulb weighting was built for, and it is why an attentive fire matters here. An insulated kamado runs efficient stalls and sips fuel through the muggy months; a pellet cooker handles the same conditions cleanly. The city’s Central Texas brisket and Gulf Coast barbacoa traditions both reward patience — give a packer brisket more time than you would budget in a dry climate, and do not panic when the stall holds flat for hours. Start before dawn so the long stall lands in daylight, and keep the wrap handy to push through it.',
  ],
  'washington-dc': [
    'Washington’s smoke calendar runs warm and humid in summer and mild but damp in winter. The strongest backyard windows are spring and fall — April into June, then September into October — when highs sit in the 60s and 70s and the worst of the Mid-Atlantic humidity backs off. July and August are hot and sticky, with afternoon thunderstorms common enough that a long Saturday cook needs a radar check. Winter rarely shuts the season down entirely, but the damp cold and gusty days between December and February favor an insulated cooker over an open firebox.',
    'DC’s blend of Carolina pulled pork and Texas brisket both reward planning around the humidity. Summer dew points push the wet-bulb temperature up and stretch the stall, so budget extra time for long cuts from June through September. A pellet cooker or insulated kamado handles the muggy stretch comfortably and keeps shoulder-season and winter Saturdays in play; an offset is rewarding on the calm, dry days the score flags green. Watch for pop-up storms on summer afternoons, and start early so the stall clears before evening.',
  ],
  'miami-fl': [
    'Miami runs on a two-season calendar that shapes every cook. The dry season — roughly November through April — is the prime smoking window: warm, breezy, lower humidity, and reliably cookable weekends. The wet season flips that from May through October, with near-daily afternoon downpours, oppressive dew points, and the peak of hurricane season layered on top. A long weekend cook in summer is doable, but you are cooking around the three-to-five p.m. storm clock, so start early and keep the radar open.',
    'The subtropical humidity drives a high wet-bulb temperature, which means long, slow stalls on brisket and pork butt for much of the year. An insulated kamado is ideal here — it runs efficient stalls and conserves fuel through the muggy stretch — and a pellet cooker handles the same conditions cleanly. Miami’s Caribbean and Cuban smoke traditions lean on citrus marinades and tropical fruit woods that pair well with pork and poultry. Give long cuts more time than a drier climate would need, keep a wrap ready to push through the stall, and treat the afternoon sea-breeze storms as the variable that decides most summer Saturdays.',
  ],
  'philadelphia-pa': [
    'Philadelphia’s smoke season tracks the classic Northeast pattern: strong spring and fall, hot-and-humid summer, cold winter. The best backyard windows are May into June and September into October, when highs sit in the comfortable 60s and 70s and dew points ease off the midsummer peak. July and August bring heat, humidity, and afternoon storms; winter brings cold and gusty days from December through February that close an open offset for stretches at a time.',
    'Gusty winters and big seasonal swings make an insulated kamado or pellet cooker the practical year-round choice — both hold their cook through cold and gusts that would have a stick burner chasing the gauge. The city’s Texas-leaning pit scene still treats the offset as the brisket benchmark; save those cooks for the calm, dry green-flagged Saturdays and build a wind break if your row-home yard is exposed. Summer humidity stretches the stall, so budget extra time for long cuts and start any brisket before dawn to keep the fire-tending in daylight.',
  ],
  'atlanta-ga': [
    'Atlanta’s smoke calendar is generous on the shoulders and humid in the middle. Spring and fall — March into May, then September into November — are the prime windows, with mild highs and lower dew points than the swampy summer peak. June through August is hot and humid, with afternoon thunderstorms a near-daily feature, so summer weekend cooks live by the radar. The metro’s higher elevation in the north Georgia piedmont takes a little edge off the heat compared with the coastal Southeast, but humidity is still the dominant variable.',
    'Those summer dew points push the wet-bulb temperature up and stretch the stall, exactly the condition the score weights heavily. An insulated kamado runs efficient stalls through the humid months and a pellet cooker handles them cleanly; an offset rewards an attentive fire-tender on the calm, dry days. Atlanta’s pits run both Carolina-style chopped pork and Texas brisket, and both long cuts want patience in this climate — give them more time than you would budget out West, keep a wrap ready, and start early so the stall clears before the afternoon storm cells build.',
  ],
  'boston-ma': [
    'Boston has one of the shorter smoke seasons on this list, bracketed by hard New England winters. The reliable backyard window runs May through October; inside that, late spring and early fall are the sweet spots, with mild highs, lower humidity, and steadier air than the gusty cold months. Summer is pleasant, but coastal storms and humid stretches show up, and nor’easters and raw, windy days from November through March close an open offset for long runs.',
    'Coastal wind is the variable to plan around — an exposed yard near the harbor sees gusts that drag an offset’s pit temperature, and gradient flow can swing 20-plus mph through a single afternoon. An insulated kamado or pellet cooker extends the season at both ends and holds temperature through the wind far better than an open firebox. Save the stick-burner brisket cooks for the calm, dry days the score flags green, build a wind break if you can, and treat the May-to-October stretch as your real cooking calendar — the rest of the year belongs to the insulated rigs.',
  ],
  'phoenix-az': [
    'Phoenix smoking is all about the heat and the monsoon. From late spring through early fall the desert runs brutally hot, with highs well into the 100s in June and July that are hard on both the cook and the pitmaster. The strongest windows are the long, mild shoulder seasons and winter: October through April delivers comfortable, dry, reliably cookable Saturdays. The summer monsoon, roughly July through September, layers sudden dust storms and downpours on top of the heat, so a long weekend cook in that stretch needs a close eye on the afternoon.',
    'The desert’s low dew points are the technical gift: stalls are short and bark forms fast because there is little evaporative cooling to hold the meat flat. The trade is moisture — the dry air pulls it out of the cook quickly, so favor butcher paper over foil to protect the bark, keep a water pan in the offset, and lean toward shorter rest windows. An insulated kamado handles the summer heat best; an open stick burner is most comfortable in the October-to-April window, when the temperature is not already doing half the cooking for you.',
  ],
  'san-francisco-ca': [
    'San Francisco has the mildest, most stable smoking weather of any major US city, and the season essentially never closes. The marine climate keeps highs moderate year-round — rarely hot, rarely freezing — with moderate dew points and a mostly rain-free stretch from spring through fall. The wettest months are November through March, but even then cookable weekends are common. The one constant is the afternoon wind and fog off the Pacific, which is the real variable a Bay Area pitmaster plans around rather than heat or storms.',
    'That marine wind drags an open offset’s pit temperature and can swing 15-to-20 mph as the fog rolls in, so a wind break earns its keep here. An inland yard a few miles back from the water — in the East Bay or South Bay — sees less of it and runs an offset comfortably most of the year. The moderate dew points mean shorter stalls than the humid East, so a brisket moves a touch faster, but the breezy marine air still pulls moisture, so favor butcher paper on the wrap. Pick a low-wind day off the score and the Bay Area calendar will give you a cook nearly any weekend.',
  ],
  'riverside-ca': [
    'Riverside and the Inland Empire sit far enough back from the coast to trade San Francisco’s fog for real desert heat. Summers are hot and dry, with highs in the 90s and 100s from June through September, while the coastal marine layer that cools Los Angeles mostly burns off before it reaches the valley. The strongest smoking windows are the long, mild shoulder seasons and winter: October through May delivers comfortable, dry, reliably cookable Saturdays, and rain is scarce outside a few winter weeks.',
    'The dry inland air behaves more like the Mountain region than the coast: low dew points mean short stalls and fast bark, but moisture loss is the variable to manage. Favor butcher paper over foil to protect the bark, keep a water pan in the offset, and lean toward shorter rest windows on a long cook. Santa Ana wind events are the other thing to watch — a gusty, bone-dry afternoon both drags pit temperature and raises fire risk, so check conditions before lighting on a red-flag day. Outside those, the Inland Empire’s backyard-heavy pit scene gets one of the longest cook calendars in the state.',
  ],
  'detroit-mi': [
    'Detroit sits in the heart of the Great Lakes, and the lakes drive its smoke calendar. The dependable windows are May into June and the September-into-October stretch, with highs in the 60s and 70s and humidity that has not yet peaked. July and August turn warm and sticky, with lake moisture feeding the occasional severe afternoon storm. From late November through February the cold sets in hard, snow piles up, and wind funneling off Lake Erie and Lake St. Clair makes an uncovered cook a battle.',
    'Because the lakes keep the air moving most of the year, a backyard pit in an open Detroit lot fights more temperature drift than the inland average. Cooks here lean on insulated kamados and pellet rigs to hold a steady fire through the windy shoulder weeks and the deep cold; a stick burner shines on the settled, low-wind afternoons the score marks green. The Motor City’s pits favor Memphis ribs and Carolina-style pulled pork, both forgiving cuts that suit a climate where the weather can turn on you. Lay in extra fuel for winter sessions, shelter the cooker from the lake wind, and let the fall window carry your longest brisket cooks.',
  ],
  'seattle-wa': [
    'Seattle’s smoke calendar is shaped by the wet season and the dry one. The reliable window is summer — roughly July through September — when the Pacific Northwest finally dries out and delivers mild, rain-free weekends that are some of the most pleasant cooking weather anywhere. The rest of the year is the famous damp: cool, gray, and persistently wet from October into June, with rain more often a drizzle than a downpour. It rarely gets cold enough to freeze out a cook, but the moisture is constant.',
    'The marine climate’s mild temperatures favor longer, cooler cooks, and the low summer humidity keeps stalls manageable. The variable to plan around is rain rather than heat or wind — an insulated kamado or pellet cooker shrugs off a drizzle and holds its cook through the damp shoulder seasons, while an open offset is happiest in the dry July-to-September stretch. Seattle’s pits run alder-smoked salmon alongside a growing brisket scene, and the regional woods suit the mild climate. Pick a dry day off the score, keep the cooker under cover if you can, and the summer window will reward you.',
  ],
  'minneapolis-mn': [
    'Minneapolis–St. Paul has the most extreme smoke calendar on this list. Summers are warm and humid with severe afternoon storms; winters are genuinely brutal, with subzero stretches and wind that closes any open-firebox cook down for months. The reliable backyard window is roughly May through October, and inside that, late spring and early fall are the sweet spots — mild highs, lower humidity, and steadier air than the storm-prone heart of summer.',
    'This is insulated-cooker country by necessity. From November through March, a kamado or pellet rig is the only practical way to keep cooking — both hold their temperature when the air alone would fight a stick burner all day. Even in summer, Upper Midwest wind is the variable to track; gust spikes punish offsets and reward the insulated rigs. The Twin Cities pit scene is winter-tested for exactly this reason. Save the open offset brisket cooks for the calm, dry green-flagged days from May to October, start before dawn so the stall clears in daylight, and let the insulated cookers carry the cold half of the year.',
  ],
  'san-diego-ca': [
    'San Diego has, by most measures, the easiest smoking weather in the contiguous United States. The coastal climate is mild and remarkably stable — highs rarely climb out of the 70s and 80s, lows rarely approach freezing, humidity stays moderate, and rain is scarce outside a few winter weeks. The practical result is a cook calendar that genuinely stays open year-round: there is almost always a cookable Saturday on the board, in January as much as July.',
    'With heat, cold, and storms mostly off the table, the main variable is the afternoon sea breeze, which can drag an open offset’s pit temperature as it picks up off the water. A wind break helps near the coast, and an inland yard a few miles back sees less of it. The mild marine air and moderate humidity keep stalls shorter than the humid East without the harsh moisture loss of the desert, so an offset runs comfortably most weekends and the wrap choice is forgiving. Pick a low-wind day off the score and San Diego will hand you a clean cook just about any time of year.',
  ],
  'tampa-fl': [
    'Tampa Bay sits on Florida’s Gulf Coast and runs the state’s classic two-season rhythm. The dry season — roughly November through April — is the prime smoking stretch: warm, breezy, lower humidity, and weekend after weekend of cookable weather. From late May into October the wet season takes over, and the bay area is one of the most lightning-prone corners of the country, with thunderstorms firing nearly every afternoon through the June-to-September peak. Gulf hurricane season overlaps that stretch from June into November, so a long-range summer cook needs a backup plan.',
    'The summer humidity drives a high wet-bulb temperature, which means brisket and pork-butt stalls run long and stubborn through the wet months. A sealed kamado earns its keep here, holding an efficient stall and sipping fuel in the mugginess; a pellet cooker manages it without fuss. Tampa’s pits blend Carolina pork with strong Latin and Cuban influence, and citrus-and-mojo pork suits the climate. Cook early to beat the afternoon storm clock, give long cuts extra time in the humidity, and treat the November-to-April dry season as your main event.',
  ],
  'denver-co': [
    'Denver cooks a mile above sea level, and the altitude shapes everything. The air is dry and thin, dew points stay low, and the day-to-night temperature swing can top 30 degrees — a warm afternoon cook can turn cold overnight in a hurry. Summer afternoons bring fast-building thunderstorms and the occasional hailstorm off the Front Range, so a long Saturday cook wants an eye on the early-afternoon sky. Winters are cold but often sunny, and a sun-warmed cooker holds heat better than the air temperature suggests.',
    'Thin, dry air is a double-edged gift. Low dew points mean short stalls and fast bark, but water boils near 202°F up here and the dry air pulls moisture quickly, so wrap-and-rest timing shifts and butcher paper beats foil for protecting the bark. Keep a water pan in the offset and lean on internal temperature rather than the clock, which reads a little differently at altitude. The wide-open Front Range calendar stays cookable most of the year; line up the long cooks for calm mornings before the afternoon storms build.',
  ],
  'baltimore-md': [
    'Baltimore’s smoke calendar runs the Mid-Atlantic pattern: humid, storm-prone summers and damp, gusty winters bracketing two strong shoulder seasons. April into June and September into October are the sweet spots, with mild highs and dew points off the July peak. Summer brings Chesapeake humidity and afternoon thunderstorms; winter rarely freezes the season solid, but raw, wet, windy stretches from December through February favor a cooker that makes its own steady heat.',
    'Those summer dew points stretch the stall on long cuts, so budget extra time from June through September and keep a wrap handy. A sealed kamado or pellet cooker carries the damp shoulder and winter weekends comfortably, while a stick burner shines on the calm, dry days the score flags green. Baltimore’s own contribution is pit beef — top round cooked hot and fast over charcoal, sliced thin and piled on a kaiser roll — which sits alongside the region’s pulled pork and brisket. Pit beef is a hotter, shorter cook than a low-and-slow brisket, so for that one, watch the wind more than the humidity.',
  ],
  'st-louis-mo': [
    'St. Louis sits where the humid East meets the open Midwest, and its weather pulls from both. Summers are hot and sticky, with dew points climbing through July and August and pop-up storms common; winters bring real cold and the occasional ice storm. Spring is the volatile season — strong frontal lines and severe-weather setups roll through the Mississippi and Missouri river corridors, so an April or May cook needs a close read on the storm and wind forecast. Late spring and early fall are the most settled windows.',
    'River-valley humidity means long, patient stalls on brisket and pork through midsummer, while spring and fall reward an offset with calmer, drier air. St. Louis built its own rib style — spares trimmed St. Louis-cut and finished with a sharper tomato sauce — and ribs are forgiving when the weather is unsettled, cooking in a far shorter window than a packer brisket. Plan the all-day cooks for stable green-flagged days, keep an insulated cooker ready for cold snaps, and let ribs carry the iffy-weather Saturdays.',
  ],
  'charlotte-nc': [
    'Charlotte sits in the Carolina Piedmont, where humid subtropical summers meet mild, workable winters. The long shoulder seasons are the prize — March into May and September into November bring comfortable highs and dew points well below the swampy midsummer peak. June through August is hot and humid with frequent afternoon thunderstorms, so summer cooks live by the radar. Winters stay mild enough that cookable weekends show up all year, and hard freezes are brief.',
    'Summer humidity pushes the wet-bulb temperature up and lengthens the stall, which actually suits the region’s long pork cooks — whole hog and shoulder both reward patience over speed. For the muggy stretch, a sealed kamado holds a tight, fuel-efficient fire and a pellet rig rides it out hands-off; save the open stick burner for the settled, low-humidity days. Charlotte straddles two Carolina traditions — Eastern whole-hog dressed in thin vinegar sauce and Lexington-style shoulder with a tomato edge — and both are forgiving cuts. Get the meat on before sunrise so the stall breaks ahead of the afternoon storms.',
  ],
  'orlando-fl': [
    'Orlando sits inland in Central Florida, in the stretch nicknamed Lightning Alley for good reason. From June through September, sea breezes off both coasts collide over the peninsula’s middle and fire daily afternoon thunderstorms — often violent, usually between two and six o’clock. The flip side is the drier season, roughly November through April, which is warm, lower-humidity, and reliably cookable weekend to weekend, with May and October as transition months. Hurricane season runs June into November, and even an inland metro feels the bigger systems, so summer plans need flexibility.',
    'The subtropical humidity keeps the wet-bulb temperature high and the stall long through much of the warm season. A sealed kamado is the easy answer — efficient stalls, low fuel burn in the mugginess — and a pellet cooker manages the same conditions without babysitting. Orlando’s pits pull from both Carolina pork and Texas brisket, both long cooks that want extra time in this humidity. The play is simple: fire the cook at dawn so the meat is wrapped and coasting before the afternoon storms build, leave yourself a buffer, and save your most ambitious briskets for the dry season.',
  ],
  'san-antonio-tx': [
    'San Antonio anchors South Texas, where hot summers and mild winters make for a long cook calendar. July and August run genuinely hot — highs in the 90s and beyond — with enough Gulf moisture to keep the air humid without the relentless saturation of the coast. Spring brings the region’s strongest storms and gusty frontal passages, while fall and winter settle into some of the best smoking weather in the state: mild, often dry, and rarely cold enough to stop a cook.',
    'Moderate humidity means stalls that run longer than the desert but shorter than Houston’s Gulf air, so a brisket here lands somewhere in between on the clock. Wind is less punishing than out on the open plains, which keeps the region’s offset stick-burner tradition comfortable most of the year — a modest wind break covers the spring fronts. San Antonio’s pit history runs deeper into barbacoa than brisket: pit-steamed beef head and cheek, cooked overnight, predate the modern brisket boom. For barbacoa or brisket alike, the long fall and winter windows are prime, so save the all-day cooks for the calm stretches the score marks green.',
  ],
  'portland-or': [
    'Portland’s smoke season is a tale of two halves. The dry window — July and August, often stretching into September — is glorious: warm, low-humidity weekends that rank among the best cooking weather in the country. The wettest stretch runs roughly November through March, and the broader gray, drizzly Pacific Northwest damp lingers from October into June. It rarely freezes hard, but the persistent moisture — not cold or wind — is the variable that shapes a Portland cook.',
    'Mild temperatures and modest summer humidity keep stalls manageable and favor long, patient cooks. Since moisture is the defining challenge rather than gusts, the practical rig is one you can run under a roof: a sealed kamado or pellet cooker handles the gray, damp months without complaint, while a stick burner really wants that rainless midsummer stretch. Portland pitmasters lean on alder and local fruit woods that flatter a cooler, longer cook. Tuck the firebox under cover, pick a rain-free day off the score, and load your most ambitious briskets into the short but dependable late-summer window.',
  ],
  'sacramento-ca': [
    'Sacramento sits in California’s Central Valley, and its climate is Mediterranean with a valley twist. Summers are hot and bone-dry — long stretches in the 90s and 100s — but the evening Delta breeze off the bay reliably drops temperatures after sundown, which makes overnight and early-morning cooks pleasant even in July. Winters are mild and wet, and the valley’s famous tule fog can settle thick on cold mornings. Rain is scarce outside the winter months, so the cook calendar runs long.',
    'The dry summer air is the technical story: low dew points mean short stalls and fast, hard bark, but the same dryness pulls moisture from the meat, so butcher paper beats foil and a water pan helps an offset. Sacramento has one of the strongest pellet-cooker cultures in California, and a pellet rig or kamado handles the valley heat with less fuss than an open firebox baking in the afternoon sun. Lean into the Delta breeze — start before dawn or cook into the cooler evening — mind the wrap for moisture, and you will find cookable weekends nearly year-round outside the foggiest winter mornings.',
  ],
  'pittsburgh-pa': [
    'Pittsburgh’s weather is cloudier and more changeable than the rest of the Northeast, shaped by the Appalachian foothills and the three rivers that meet downtown. Summers are warm and humid with frequent afternoon showers; winters are cold, gray, and snowy, with long overcast stretches. The hilly terrain and river valleys create pockets of wind and humidity the metro forecast can miss, so a Pittsburgh backyard often cooks a little differently than the airport reading suggests. Late spring and early fall are the steadiest windows.',
    'Summer humidity in the river valleys lengthens the stall, so give brisket and pork-butt cooks extra time from June through September. Through the cloudy shoulder months and the cold winters, a pellet cooker or sealed kamado is the dependable pick, holding a steady fire when an open pit would struggle in the damp chill. Pittsburgh’s scene leans on neighborhood pulled pork and ribs more than competition brisket, both manageable cooks for changeable weather. Read your own yard rather than just the metro number — a spot sheltered near the rivers behaves differently — and save the long cooks for the calm, clear days the score flags.',
  ],
  'las-vegas-nv': [
    'Las Vegas cooks in the Mojave Desert, where summer heat is the headline. June through August routinely tops 100°F and can push past 110, punishing for both the cook and anyone tending a fire, so the prime windows are the long, mild shoulder seasons and winter — roughly October through April, when the desert delivers dry, sunny, dependable Saturdays. A brief summer monsoon can stir up dust and a stray thunderstorm in July and August, but most days the variable is heat, not rain.',
    'Bone-dry air keeps dew points low, so stalls are short and bark sets quickly — but that same dryness wicks moisture from the meat, the standard desert tax. Wrapping in butcher paper guards the bark, and a foil pan of water steadies a stick burner against the arid heat. Vegas also swings hard from day to night, and a pit can bleed heat fast after sundown, so overnight cooks want extra fuel and a closer watch. Insulated cookers — kamados and pellet rigs — shrug off the summer extremes that bake an exposed offset; reserve the open-fire brisket sessions for the temperate October-through-April calendar.',
  ],
  'cincinnati-oh': [
    'Cincinnati sits in the Ohio River Valley, and the river shapes its summers — warm, humid air pools in the valley and feeds frequent afternoon storms from June through August. Winters are cold and often gray, with snow and stretches that close down an open firebox. The transition seasons are the payoff: May into June and September into October bring mild highs, lower humidity, and the steadiest air of the year for a long cook.',
    'Valley humidity through the summer keeps the wet-bulb temperature up and the stall long, so plan extra time for brisket and pork from June onward and keep a wrap within reach. Through the cold, damp winter and the unsettled shoulder weeks, a sealed kamado or pellet cooker holds a far steadier fire than an exposed offset. Cincinnati’s German heritage shows up at the pit: bratwurst and mettwurst get cooked here with as much care as the brisket and pork, and a rack of sausage is a short, low-stakes option when the forecast won’t commit. Save the all-day briskets for the calm, dry windows the score flags green.',
  ],
  'kansas-city-mo': [
    'Kansas City sits at the edge of the Great Plains, and wind is its signature variable. Spring drives strong frontal systems and severe-weather setups across Kansas and Missouri, often with gusts that pull a pit off temperature; summer turns hot and humid; winter is cold and, again, frequently windy. The calmest, most dependable cooking comes in the late-spring and early-fall lulls between the storm seasons, when the air settles and the humidity eases.',
    'Gust speed decides more KC Saturdays than rain or cold, so the wind forecast is the first thing to check before a long cook. The offset stick burner — still the regional standard — wants a solid wind break and heavier woods like hickory and oak that carry smoke through a long, humid-summer stall; a pellet rig or kamado is the steadier choice on blustery days. Kansas City is where burnt ends got their start — the caramelized cubes off a brisket point — which means cooking the packer well past the stall and rewarding patience. Time those long cooks for the low-wind windows the score flags, and let the insulated cooker handle the gusty ones.',
  ],
  'columbus-oh': [
    'Columbus sits on the flat central-Ohio plain, with a humid continental climate of hot, sticky summers and cold, snowy winters. Lacking Cincinnati’s river valley or Cleveland’s lake, its weather is the straightforward Midwest template: pleasant, storm-dotted summers and a hard winter that benches open-fire cooking for weeks. The reliable windows are the transitions — roughly May to mid-June and September into October — when highs sit in the 60s and 70s and the air is at its calmest.',
    'Midsummer humidity stretches the stall on long cuts, so build in extra time and a wrap from July through August. For the cold months and the gustier shoulder weeks, a pellet cooker or sealed kamado keeps a steady fire where an open offset would fight the chill and wind. Columbus runs a broad, restaurant-driven pit scene with no single dominant style — Carolina pork, Memphis ribs, and Texas brisket all share menus — so match the cut to the weather: ribs and pork for an unsettled Saturday, brisket for the clear, calm days the score flags green. Start long cooks early to keep the fire-tending in daylight.',
  ],
  'indianapolis-in': [
    'Indianapolis has a classic humid-continental climate: warm, humid summers with afternoon thunderstorms, cold and sometimes harsh winters, and volatile springs that can swing from mild to severe in an afternoon. The flat central-Indiana terrain offers little shelter from wind, which spikes hardest with spring fronts. Late spring and early fall — once the storm risk eases and before the deep cold sets in — give the steadiest, most comfortable cooking of the year.',
    'Summer dew points lengthen the stall, so long cuts need extra time and a wrap from June into September. Wind is the year-round wildcard on the open plain; an insulated kamado or pellet cooker keeps temperature through the gusts and winter cold far better than an exposed firebox. Indianapolis takes its barbecue seriously around Memorial Day, when the racing crowd turns the holiday into one of the city’s biggest cook weekends, with pork, ribs, and brisket all in heavy rotation. Put up a wind break, time the all-day briskets for the calm windows the score flags, and let ribs and pork cover the breezier Saturdays.',
  ],
  'cleveland-oh': [
    'Cleveland’s weather is written by Lake Erie. The lake moderates summer heat and feeds humidity, but its real signature is winter: lake-effect snow can bury the east side under bands that miss the airport entirely, and the season is long, gray, and overcast. Summers are warm, humid, and storm-dotted, with the lake breeze keeping the worst heat in check. The dependable cooking stretch runs late spring through early fall, with the shoulder months calmest.',
    'Lake-driven humidity keeps summer stalls long, so give brisket and pork the extra hours and keep a wrap ready. The long, snowy winter is the real limiter — a sealed kamado or pellet rig is the most practical way to keep smoking from December through February, holding heat the lake wind would strip from an open pit. Cleveland’s Eastern European roots put kielbasa and smoked sausage on the pit beside the regional pulled pork and ribs, and sausage is a fast, forgiving cook for a marginal day. Track the lake-effect bands in winter, lean on the insulated cooker through the cold, and save the long cooks for calm summer and shoulder Saturdays.',
  ],
  'austin-tx': [
    'Austin sits on the eastern edge of the Texas Hill Country, and its summers are long and intense — July and August routinely reach the 100s, and multi-week heat waves are normal. Spring brings the region’s strongest storms and the occasional flood-grade downpour, while fall and winter are mild and among the best smoking weather anywhere, rarely cold enough to stop a cook. Humidity is moderate — more than the West Texas plains, less than the Gulf Coast — so summer air is warm and sticky without Houston’s saturation.',
    'Austin is the modern capital of Central Texas brisket, and the post-oak offset cook is the local benchmark: long, low, and patient, judged on bark and smoke ring. Moderate humidity puts the stall between desert-fast and Gulf-slow, so budget a full day for a packer and resist chasing the clock. Summer’s brutal heat is the main planning hazard — an open firebox bakes in the afternoon sun, so start before dawn, work the cool morning hours, and keep water in the cook. The long, mild fall and winter are prime; line up your most ambitious briskets for the settled stretches the score flags green.',
  ],
  'nashville-tn': [
    'Nashville sits in the humid Mid-South, where long, sticky summers meet short, mild winters. June through August is hot and humid with regular afternoon and evening thunderstorms; spring is the volatile season, with strong frontal systems and the occasional tornado watch sweeping the Cumberland Basin. The prime windows are the shoulders — April into May and September into October — when highs ease into the 70s and the dew point backs off the summer peak. Winters rarely shut the season down for long.',
    'Summer humidity lengthens the stall on brisket and pork, so plan extra hours and keep a wrap close from June through September. A sealed kamado or pellet cooker rides out the muggy stretch and the damp winter weeks efficiently, while an offset rewards the calm, dry days. Nashville made its name on hot chicken, but the pit scene runs the full Mid-South catalog — pulled pork, dry-and-wet ribs, and a fast-growing brisket following. Smoked chicken is a forgiving, shorter cook for an unsettled Saturday; save the all-day briskets for the settled windows the score flags.',
  ],
  'virginia-beach-va': [
    'Virginia Beach sits on the Tidewater coast, where the Atlantic shapes the cooking calendar more than raw heat. Summers are warm and humid with sea-breeze thunderstorms; the bigger hazard is the storm track — nor’easters in the cooler months and the tail end of tropical systems from late summer into fall can wash out a planned weekend. Spring and early fall are the steadiest, most pleasant windows, and winters run milder than inland Virginia but raw and windy when a coastal low spins up.',
    'Coastal wind, not extreme heat or cold, is the variable to plan around — an exposed oceanfront yard catches gusts that drag an offset’s temperature, so a wind break earns its keep. Humidity holds the stall on the longer side through summer, so budget extra time and watch the tropical forecast in hurricane season. The region’s pits lean on Carolina-bridged pulled pork alongside plenty of smoked seafood, a nod to the working waterfront. Pick a low-wind, storm-free day off the score, and the Tidewater’s long shoulder seasons will hand you a clean cook.',
  ],
  'providence-ri': [
    'Providence packs a full New England climate into a small coastal footprint. The cooking year is genuinely seasonal: hot, humid days in July and August, crisp and near-ideal stretches in late spring and early fall, and a cold, wind-driven winter that benches open-fire cooking from December into March. Narragansett Bay moderates the extremes a little, but it also funnels a steady sea wind that an offset feels much of the year. The back half of spring and the first half of fall are the reliably pleasant cooking weeks.',
    'Wind, more than cold, is what a Rhode Island pitmaster fights — bay gusts pull an open pit off temperature, so a sheltered spot and a wind break matter here. Through the cold months and the blustery shoulders, a kamado or pellet cooker keeps its fire where a stick burner would lose the battle. The local scene is small and restaurant-driven, leaning on ribs and pulled pork that suit a shorter calendar. Read the day’s wind off the score, tuck the firebox out of the gusts, and concentrate the long cooks in the calm late-spring and early-fall stretches.',
  ],
  'milwaukee-wi': [
    'Milwaukee’s weather is a Lake Michigan story. The lake keeps spring cool and lingering, moderates summer heat while feeding humidity, and shapes long, gray, cold winters — though on the lake’s western shore, Milwaukee’s heavier snow comes mostly from broad Midwest systems, not the lake-effect bands that bury the eastern side. Summers are warm and pleasant, with occasional severe storms off the western plains and a lake breeze that can swing a shoreline afternoon fast. The most dependable cooking runs late spring through early fall, with the shoulder weeks calmest and deep winter best left to insulated rigs.',
    'Lake humidity keeps summer stalls on the longer side, so give the long cuts their time and keep a wrap ready. Winter is the real limiter — from December through February, a kamado or pellet cooker is what keeps a Milwaukee cook going when an open pit would bleed heat into the lake wind. The city’s German and Polish roots put bratwurst and Polish sausage on the grill as a regional staple, right beside the Friday fish fry and the newer pulled-pork and rib scene. Sausage and fish are quick cooks for an iffy day; save the brisket for calm summer Saturdays.',
  ],
  'jacksonville-fl': [
    'Jacksonville sits in northeast Florida, in genuinely humid subtropical climate rather than the tropical far south of the state. Summers are hot and sticky, with high dew points and near-daily afternoon thunderstorms from June through September, and the metro sits squarely in the Atlantic hurricane track through the season. The payoff comes on the other end: October through April runs warm, drier, and reliably cookable, with winter rarely cold enough to stop a cook.',
    'Summer humidity pushes the wet-bulb temperature high and the stall long — the textbook condition for a patient brisket. A sealed kamado runs a tight, fuel-efficient stall through the muggy months and a pellet rig handles it without drama; the open offset is happiest on the drier days. Jacksonville’s pits run Carolina pork and Texas brisket as the backbone, both long cuts that want extra time in this air. Fire the cook at first light so the meat is wrapped and coasting before the afternoon storms build, leave a buffer, and aim the biggest cooks at the October-to-April dry stretch.',
  ],
  'oklahoma-city-ok': [
    'Oklahoma City sits in the heart of Tornado Alley, and wind is the defining cook variable. Spring is the volatile season — supercells, hail, and powerful straight-line winds sweep the central plains, and an April or May weekend cook can be undone by a single afternoon. Summers are hot, swinging from humid to dry with the wind’s direction off the Gulf or the high plains, and winters are short and mild but seldom calm. The settled lulls of late spring and early fall are the most dependable windows.',
    'With wind a near-constant, the local tradition still runs offset stick burners — pitmasters here just build for it, siting the cooker behind a barrier and burning denser woods that won’t blow thin during a gusty stall. On the rougher days, a sealed pellet rig or kamado simply holds temperature better. Oklahoma’s signature is smoked bologna, a thick chub treated like a real cut, served beside the expected Texas beef and Memphis pork. Save the all-day cooks for the calm stretches the score marks green, and let the insulated cooker take the many blustery Saturdays the plains hand you.',
  ],
  'raleigh-nc': [
    'The Research Triangle — Raleigh, Durham, and Chapel Hill — sits in North Carolina’s eastern Piedmont, close enough to the coastal plain to run a touch muggier than the Carolina foothills. Summer is the hot, sticky season, with high humidity and pop-up storms from June well into September; winter is short and forgiving, with only brief cold snaps. The cooking peaks in the transitional weeks of spring and autumn, when the heat eases and the air dries, though a mild Saturday is reachable in nearly any month.',
    'Because the summer air stays heavy, long cuts stall hard — no problem for the Eastern Carolina whole-hog tradition that drives local menus, a cook measured in overnight hours. Heat-and-humidity-tolerant cookers shine in that stretch: a ceramic kamado sips charcoal through a long stall and a pellet smoker rides it hands-off, leaving the open pit for crisp, dry days. Local menus span Eastern Carolina whole-hog, Lexington-style shoulder, and an arriving brisket scene. Light the fire well before dawn so the worst of the stall passes ahead of the afternoon storms, and book the marathon cooks into the gentle shoulder seasons.',
  ],
  'memphis-tn': [
    'Memphis sits on the Mississippi River in the humid Mid-South, and summer is a long, sweltering affair — high dew points, hot nights, and frequent afternoon and evening storms from June through September. Spring carries the strongest severe weather as systems track up the Mississippi Valley, while winters are short and mild with only occasional hard freezes. The most comfortable cooking lands in the spring and fall shoulders, once the river-valley humidity relents.',
    'That thick summer air drives long, patient stalls, which suits the city’s devotion to low-and-slow pork better than almost anywhere. A sealed kamado holds an efficient stall through the worst of the mugginess and a pellet cooker manages it cleanly; the offset is happiest on the dry, calm days. Memphis is the capital of dry-rubbed ribs and pulled pork — ribs especially are a forgiving half-day cook for an unsettled forecast. Start the briskets and shoulders before dawn so the stall clears ahead of the afternoon storms, and aim the longest cooks at the settled shoulder-season weekends.',
  ],
  'richmond-va': [
    'Richmond sits at Virginia’s fall line, where the Piedmont meets the coastal plain along the James River. Summers are hot and humid with afternoon thunderstorms, and the river corridor holds moisture that can make July and August feel heavier than the inland average. Winters are mild with brief cold snaps and the rare ice storm. As across the Mid-Atlantic, the spring and fall shoulders — roughly April–May and September–October — are the most reliable and pleasant cooking weeks.',
    'Summer humidity stretches the stall, so the long cuts want extra time and a wrap from June onward. An insulated cooker — kamado or pellet — carries the humid summer and the damp, gusty winter weeks with less fuss than an open firebox. Richmond’s tradition centers on Virginia-style chopped pork, a vinegar-forward take with a tomato edge that bridges Carolina and the Mid-Atlantic, with brisket houses now adding to the menu. Run the long sessions on the calm, clear days the score flags, and let pork and ribs cover the unsettled summer Saturdays.',
  ],
  'louisville-ky': [
    'Louisville sits on the Ohio River at the seam between the humid South and the Midwest, and its weather borrows from both. Summers are hot and humid with regular thunderstorms; winters get cold enough for snow and ice but rarely lock down for long. Spring can turn severe as systems roll through the Ohio Valley, and the river holds humidity that lengthens a summer cook. The shoulder seasons — late spring and early fall — give the steadiest, most comfortable smoking weather.',
    'Through the muggy months, an insulated kamado or pellet cooker holds a steadier, more fuel-efficient fire than an open pit fighting the valley humidity; the offset comes into its own on the dry, calm days. Louisville sits within reach of western Kentucky’s unusual mutton tradition — centered in Owensboro, slow-smoked and mopped with a thin black, Worcestershire-based dip — and folds it into the regional pulled pork and ribs. Mutton is a long, fatty cook that, like brisket, rewards patience and a steady fire, so save it for the settled days the score flags green and lean on the insulated cooker when the weather won’t cooperate.',
  ],
  'new-orleans-la': [
    'New Orleans cooks in some of the most humid air in the country. Sitting on the Gulf Coast near sea level, the city runs hot and saturated from late spring through early fall, with daily afternoon thunderstorms and a hurricane season that peaks from August into October. Dew points stay high well into the night, so even an evening cook fights the moisture. The mild, drier winter — roughly November through March — is the prime smoking stretch, with comfortable temperatures and far calmer skies.',
    'This saturated air is the textbook case for the score’s wet-bulb weighting: a packer brisket can stall for hours in a Louisiana summer. A well-insulated kamado is the natural answer, running tight stalls and sipping fuel; a kettle or pellet cooker copes with the heat well too. New Orleans threads Creole and Cajun flavor through its smoke — andouille and tasso share the pit with brisket and ribs. Cook in the cool of the morning, give the long cuts generous time in the humidity, and treat the dry winter months as the season for your most ambitious briskets.',
  ],
  'hartford-ct': [
    'Hartford sits in the Connecticut River valley, with a four-season New England climate. Summers are warm and humid with afternoon storms, and the valley can trap heat and moisture, making July feel heavier than the nearby coast. Winters are cold and snowy, with long stretches that shut down an open firebox. The strong cooking windows are the May–June and September–October shoulders, when the air is mild and settled; the deep winter belongs to insulated cookers.',
    'Valley humidity lengthens the summer stall, so budget the extra hours for brisket and pork. From late fall through early spring, a kamado or pellet rig is what keeps a Hartford cook running when cold and damp would defeat an open pit. The local scene is modest and restaurant-led, running a New England take on Memphis ribs and Carolina pork — both manageable cooks for a shorter season. Concentrate the long sessions in the mild shoulder weeks the score flags, and treat the insulated cooker as your cold-weather workhorse.',
  ],
  'salt-lake-city-ut': [
    'Salt Lake City sits high and dry against the Wasatch Front, around 4,300 feet, and the altitude and aridity shape every cook. Summers are hot but dry, with low dew points and a big day-to-night temperature swing; afternoon thunderstorms are brief and scattered rather than the daily soakings of the Southeast. Winters are genuinely cold and snowy, and valley inversions can trap haze for days. The long spring and fall shoulders, plus dry summer mornings, are the most comfortable cooking windows.',
    'Dry, thin air means short stalls and fast bark, but it pulls moisture from the meat quickly — so butcher paper beats foil, a water pan helps an offset, and rest windows run shorter. Water boils a few degrees low at this elevation, which nudges wrap-and-rest timing. Through the cold, snowy winter, an insulated kamado or pellet rig holds heat the dry mountain air would otherwise strip from an open pit. Salt Lake’s scene runs Texas brisket and Memphis ribs; trust internal temperature over the clock at altitude, and book the long cooks for the calm, clear days the score flags.',
  ],
  'birmingham-al': [
    'Birmingham sits in the humid Deep South, ringed by the southern Appalachian foothills. Summers are hot and sticky, with high dew points and frequent afternoon thunderstorms from June through September; spring brings some of the most dangerous severe weather in the country as systems sweep across Alabama. Winters are short and mild. The most comfortable smoking lands in the spring and fall shoulders, when the humidity backs off and the severe-weather risk settles.',
    'The heavy summer air drives long stalls, so the low-and-slow cuts need patience and a wrap from June on. A sealed kamado runs an efficient stall through the mugginess and a pellet cooker rides it cleanly; the open offset is best on the dry, settled days. Alabama’s signature is smoked chicken finished with tangy white sauce — a mayonnaise-and-vinegar dressing born in the north of the state — sitting alongside the regional pork and ribs. Chicken is a short, forgiving cook for an unsettled Saturday; reserve the long briskets for the calm windows the score flags, and keep an eye on the spring storm forecast.',
  ],
  'buffalo-ny': [
    'Buffalo’s winters are legendary, and they define the cooking calendar. Lake-effect snow off Lake Erie can bury the city under feet of snow in a single storm, and the cold, gray season runs long — December through March is no-go territory for an open firebox. The flip side is a genuinely pleasant summer: warm, not overly humid, with the lake breeze keeping the worst heat down. Late spring through early fall is the reliable window, and the summer months are the heart of it.',
    'Because the cookable season is short, Buffalo pitmasters make the most of it, and an insulated kamado or pellet cooker stretches the margins, holding fire through the raw, windy shoulder weeks an open pit can’t. Summer humidity runs milder than the Southeast, so stalls are a touch shorter and the offset is comfortable on calm days. Buffalo’s own foods — beef on weck and chicken wings — share the backyard with Carolina-style pulled pork and brisket. Pack the long cooks into the dependable summer Saturdays, and don’t fight the lake-effect winter; that stretch belongs to the insulated cooker, if you cook at all.',
  ],
  'tulsa-ok': [
    'Tulsa sits in northeast Oklahoma’s Green Country, where the open plains give way to wooded hills along the Arkansas River. It shares the state’s constant wind — spring storms and gusty fronts are a real hazard — but the eastern half of Oklahoma runs greener and a touch more humid than the dry western plains. Summers are hot and often muggy; winters are short and mild but seldom calm. The settled weeks of late spring and early fall are the most dependable cooking windows.',
    'Wind still drives the planning here, though less relentlessly than out west — a wind break and a watch on the gust forecast keep an offset honest, while a pellet rig or kamado is the easy call on blustery days. The region’s woods lean toward hickory and pecan, giving Tulsa smoke a distinct nutty depth, and the local menu pairs Texas brisket and Memphis ribs with Oklahoma’s thick-cut smoked bologna. Save the all-day cooks for the calm stretches the score flags green, and let the insulated cooker carry the windy Saturdays the plains will inevitably send.',
  ],
};

// Last-modified date emitted in og/twitter/json-ld. Bump when the template
// changes materially; metro-list changes alone don't require it.
const LAST_MODIFIED = '2026-06-14';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function regionOf(state) {
  const r = REGION_BY_STATE[state];
  if (!r) throw new Error('generate-metros: no region mapping for state ' + state);
  return r;
}

function heritageFor(state) {
  return BBQ_HERITAGE_BY_STATE[state] || BBQ_HERITAGE_BY_REGION[regionOf(state)];
}

function renderMetro(metro) {
  const region   = regionOf(metro.state);
  const stateNm  = STATE_NAME[metro.state] || metro.state;
  const regLbl   = REGION_LABEL[region];
  const heritage = heritageFor(metro.state);
  const climate  = REGION_CLIMATE[region];
  const cooker   = REGION_COOKER_TIP[region];
  const name     = metro.name;
  const slug     = metro.slug;
  const zip      = metro.zip;

  const pageTitle = name + ', ' + metro.state + ' BBQ Forecast | Pitmaster Tools';
  const ogTitle   = name + ', ' + metro.state + ' BBQ Forecast — Best Smoke Days';
  const desc      = 'Free 7-day smoke forecast for ' + name + ', ' + metro.state + '. Scores for brisket, ribs, pork, and chicken across all cooker types.';
  const canonical = 'https://pitmaster.tools/smoke-weather/' + slug;

  const note      = METRO_NOTE[slug];
  if (!note) throw new Error('generate-metros: missing METRO_NOTE for ' + slug);
  const intro     = name + ', ' + stateNm + ' sits in the ' + regLbl + ' barbecue region. ' + note + ' This page scores the next seven days for low-and-slow cooks in the ' + name + ' metro, weighing rain probability, sustained wind and gusts, daytime temperature, and the wet-bulb humidity that drives the stall — then weights the result for your cut and cooker so you can pick the day with the highest odds of a clean cook.';
  const closing   = 'Pick a day with a strong score, light the fire, and stop guessing whether Saturday in ' + name + ' will hold. The form lets you swap cut and cooker without leaving the page — your selection persists across visits via local storage. ZIP defaults to ' + zip + ' for the ' + name + ' metro; change it any time to score a different yard.';

  // Metro-specific local guide (Milestone 6), rendered only once a metro has a
  // METRO_LOCAL entry so the section can roll out in batches. Reuses the
  // editorial-section class for styling + embed-mode hiding.
  const localParas = METRO_LOCAL[slug] || null;
  const localGuideLines = localParas
    ? ['  <section class="editorial-section local-guide" aria-label="Smoking in ' + escapeHtml(name) + '">',
       '    <h2>Planning a weekend smoke in ' + escapeHtml(name) + '</h2>']
        .concat(localParas.map(function (p) { return '    <p>' + escapeHtml(p) + '</p>'; }))
        .concat(['  </section>', ''])
    : [];

  const faqJson = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'mainEntity': [
      {
        '@type': 'Question',
        'name': 'What makes a day a good smoke day in ' + name + '?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'A day in ' + name + ' scores well when rain probability is low, sustained wind and gusts are mild for your cooker, the temperature stays inside roughly 40-85 °F, and the wet-bulb temperature is low enough that long-stall cuts (brisket, pork butt, ribs) won’t get stuck for hours. Each factor reduces the score with its own weight, calibrated for the ' + regLbl + ' climate.',
        },
      },
      {
        '@type': 'Question',
        'name': 'Which cooker works best in ' + name + '?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': cooker,
        },
      },
      {
        '@type': 'Question',
        'name': 'How accurate is the ' + name + ' forecast?',
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': 'We pull from Open-Meteo as the primary source with the US National Weather Service as failover. Each day in the ' + name + ' 7-day window carries a confidence label — high for the next 24-48 hours, dropping to medium and then low further out. Treat the 5-7 day end of the window as a planning signal, not a commitment.',
        },
      },
    ],
  };

  // BreadcrumbList helps Google show the page hierarchy in the SERP and
  // sitelinks. Three levels: site root → /smoke-weather/ landing → this
  // metro. position numbering is 1-based per schema.org convention.
  const breadcrumbJson = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    'itemListElement': [
      { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': 'https://pitmaster.tools/' },
      { '@type': 'ListItem', 'position': 2, 'name': 'Best Smoke Days', 'item': 'https://pitmaster.tools/smoke-weather/' },
      { '@type': 'ListItem', 'position': 3, 'name': name + ', ' + metro.state, 'item': canonical },
    ],
  };

  const appJson = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    'name': 'Pitmaster Tools — Best Smoke Days in ' + name + ', ' + metro.state,
    'url': canonical,
    'description': desc,
    'applicationCategory': 'UtilitiesApplication',
    'operatingSystem': 'Any',
    'inLanguage': 'en',
    'isAccessibleForFree': true,
    'browserRequirements': 'Requires JavaScript enabled in a modern browser.',
    'dateModified': LAST_MODIFIED,
    'areaServed': {
      '@type': 'City',
      'name': name,
      'addressRegion': metro.state,
      'addressCountry': 'US',
    },
    'featureList': [
      '7-day smoking weather forecast scored 0-100 for ' + name,
      'Cut-aware stall-risk modeling using wet-bulb temperature',
      'Cooker-specific wind sensitivity (offset, pellet, kamado, kettle, electric)',
      'Pre-filled ZIP for the ' + name + ' metro with override input',
      'Open-Meteo primary with NWS failover',
    ],
    'offers': { '@type': 'Offer', 'price': '0', 'priceCurrency': 'USD' },
  };

  return [
    GENERATED_MARKER,
    '<!-- meta:',
    '  title="' + pageTitle.replace(/"/g, '\\"') + '"',
    '  description="' + desc.replace(/"/g, '\\"') + '"',
    '  canonical="' + canonical + '"',
    '  og_title="' + ogTitle.replace(/"/g, '\\"') + '"',
    '  og_desc="' + desc.replace(/"/g, '\\"') + '"',
    '-->',
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<!-- INJECT:head-meta.html -->',
    '<!-- INJECT:head-og.html -->',
    '<!-- INJECT:head-favicons.html -->',
    '<!-- INJECT:consent-init.html -->',
    '<script type="application/ld+json">',
    JSON.stringify(appJson, null, 2),
    '</script>',
    '<script type="application/ld+json">',
    JSON.stringify(faqJson, null, 2),
    '</script>',
    '<script type="application/ld+json">',
    JSON.stringify(breadcrumbJson, null, 2),
    '</script>',
    '<!-- INJECT:site-header.css -->',
    '<!-- INJECT:site-base.css -->',
    '<!-- INJECT:smoke-weather.css -->',
    '<!-- INJECT:subscribe-form.css -->',
    '</head>',
    '<body>',
    '',
    '<!-- INJECT:site-header-smoke.html -->',
    '',
    '<main id="main-content">',
    '  <section class="page-hero" aria-label="Page introduction">',
    '    <h1>Best Smoke Days in ' + escapeHtml(name) + ', ' + escapeHtml(metro.state) + '</h1>',
    '    <p>' + escapeHtml(intro) + '</p>',
    '  </section>',
    '',
    '  <form id="swForm" class="form-card" autocomplete="off" novalidate aria-label="Smoke forecast inputs">',
    '    <div class="smoke-controls">',
    '      <div class="form-group">',
    '        <label for="zipInput">ZIP code</label>',
    '        <input',
    '          type="text"',
    '          id="zipInput"',
    '          name="zip"',
    '          inputmode="numeric"',
    '          autocomplete="postal-code"',
    '          maxlength="5"',
    '          value="' + escapeHtml(zip) + '"',
    '          placeholder="e.g. ' + escapeHtml(zip) + '"',
    '          aria-describedby="zipHelp"',
    '        >',
    '      </div>',
    '      <div class="form-group">',
    '        <label for="cutSelect">Cut</label>',
    '        <select id="cutSelect" name="cut">',
    '          <option value="brisket-packer">Brisket (packer)</option>',
    '          <option value="brisket-flat">Brisket (flat)</option>',
    '          <option value="pork-butt">Pork butt</option>',
    '          <option value="spare-ribs">Spare ribs</option>',
    '          <option value="baby-back-ribs">Baby-back ribs</option>',
    '          <option value="pork-loin">Pork loin</option>',
    '          <option value="whole-chicken">Whole chicken</option>',
    '          <option value="spatchcock-chicken">Spatchcock chicken</option>',
    '          <option value="chicken-thighs">Chicken thighs</option>',
    '          <option value="whole-turkey">Whole turkey</option>',
    '          <option value="turkey-breast">Turkey breast</option>',
    '          <option value="lamb-shoulder">Lamb shoulder</option>',
    '          <option value="fish">Fish</option>',
    '        </select>',
    '      </div>',
    '      <div class="form-group">',
    '        <label for="cookerSelect">Cooker</label>',
    '        <select id="cookerSelect" name="cooker">',
    '          <option value="offset">Offset</option>',
    '          <option value="pellet">Pellet</option>',
    '          <option value="kamado">Kamado</option>',
    '          <option value="kettle">Kettle</option>',
    '          <option value="electric">Electric</option>',
    '        </select>',
    '      </div>',
    '      <button type="submit" class="calc-btn">Get forecast</button>',
    '      <p id="zipHelp" class="vmsg" hidden></p>',
    '    </div>',
    '  </form>',
    '',
    '  <p id="swStatus" class="sw-status" hidden role="status" aria-live="polite"></p>',
    '',
    '  <section class="verdict-hero" id="verdictHero" hidden aria-live="polite" aria-atomic="true"></section>',
    '',
    '  <section aria-label="Daily smoke scores">',
    '    <p class="section-title">7-day forecast for ' + escapeHtml(name) + '</p>',
    '    <div id="dayCards" class="day-cards"></div>',
    '  </section>',
    '',
    '  <aside id="affiliateSlot" class="affiliate-card" hidden aria-label="Recommended gear"></aside>',
    '',
    '  <aside class="score-explainer" aria-label="What the score means">',
    '    <h3>What the 0-100 score means</h3>',
    '    <ul class="score-legend">',
    '      <li><span class="score-legend__swatch band-ideal" aria-hidden="true"></span><strong>85-100 &middot; Ideal</strong> &mdash; light the fire</li>',
    '      <li><span class="score-legend__swatch band-green" aria-hidden="true"></span><strong>70-84 &middot; Green</strong> &mdash; solid smoke day</li>',
    '      <li><span class="score-legend__swatch band-yellow" aria-hidden="true"></span><strong>50-69 &middot; Yellow</strong> &mdash; workable, plan around the rough hours</li>',
    '      <li><span class="score-legend__swatch band-red" aria-hidden="true"></span><strong>0-49 &middot; Red</strong> &mdash; tough conditions</li>',
    '    </ul>',
    '    <p>Five weather signals subtract from a base of 100: rain probability + accumulation, wind &amp; gusts (weighted by your cooker), cold mornings, hot afternoons, and stall risk for long cuts. <a href="/smoke-weather/methodology">See full methodology &rarr;</a></p>',
    '  </aside>',
    '',
    '  <!-- INJECT:subscribe-form.html -->',
    '',
    ...localGuideLines,
    '  <section class="editorial-section" aria-label="' + escapeHtml(name) + ' BBQ context">',
    '    <h2>Barbecue heritage</h2>',
    '    <p>' + escapeHtml(heritage) + '</p>',
    '    <h2>' + escapeHtml(name) + ' climate</h2>',
    '    <p>' + escapeHtml(climate) + '</p>',
    '    <h2>Cooker fit for ' + escapeHtml(name) + '</h2>',
    '    <p>' + escapeHtml(cooker) + '</p>',
    '    <p>' + escapeHtml(closing) + '</p>',
    '  </section>',
    '',
    '  <p class="sw-disclaimer">',
    '    Forecasts model regional weather, not your microclimate. Trees, structures, and elevation can shift wind and temperature noticeably from the airport-grade source we pull. Always step outside before lighting the fire.',
    '  </p>',
    '',
    '  <section class="related-tools" aria-labelledby="related-title">',
    '    <h2 id="related-title">More Pitmaster Tools</h2>',
    '    <div class="tool-links">',
    '      <a class="tool-link" href="/smoke-weather/metros/">',
    '        <div>',
    '          <div class="tool-link-name">Browse 50 US metros</div>',
    '          <div class="tool-link-desc">Pick another city to see its 7-day smoke forecast scored 0-100.</div>',
    '        </div>',
    '      </a>',
    '      <a class="tool-link" href="/">',
    '        <div>',
    '          <div class="tool-link-name">Meat Smoking Calculator</div>',
    '          <div class="tool-link-desc">Cook times for 28 cuts with full timeline, wood pairings, and serving size math.</div>',
    '        </div>',
    '      </a>',
    '      <a class="tool-link" href="/cook-time-coordinator">',
    '        <div>',
    '          <div class="tool-link-name">Cook Time Coordinator</div>',
    '          <div class="tool-link-desc">Smoke multiple meats and sync all finish times to the same table.</div>',
    '        </div>',
    '      </a>',
    '      <a class="tool-link" href="/charcoal-calculator">',
    '        <div>',
    '          <div class="tool-link-name">Charcoal Calculator</div>',
    '          <div class="tool-link-desc">Exact charcoal amounts for Minion, Snake, or direct-heat cooks.</div>',
    '        </div>',
    '      </a>',
    '    </div>',
    '  </section>',
    '</main>',
    '',
    '<!-- INJECT:site-footer-smoke.html -->',
    '<!-- INJECT:weather-score-shared.js:script -->',
    '<!-- INJECT:smoke-weather-app.js:script -->',
    '<!-- INJECT:subscribe-form.js:script -->',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// Build the single _partials/metros-list.html — a flat list of tile
// anchors (no wrapping container; the chooser page provides the grid
// wrapper). Each tile carries data-* attributes the chooser JS uses to
// find the row in the /api/metros payload and fill in live score+band.
// Skeleton text in the band/score spots keeps the page legible if JS
// is disabled or /api/metros fails.
function renderMetrosListPartial(metros) {
  const lines = ['<!-- generated by scripts/generate-metros.js — do not edit by hand -->'];
  for (const m of metros) {
    lines.push(
      '<a class="metro-tile band-pending"' +
        ' href="/smoke-weather/' + escapeHtml(m.slug) + '"' +
        ' data-slug="' + escapeHtml(m.slug) + '"' +
        ' data-zip="' + escapeHtml(m.zip) + '"' +
        ' data-name="' + escapeHtml(m.name) + '"' +
        ' data-state="' + escapeHtml(m.state) + '">' +
        '<span class="metro-tile__name">' + escapeHtml(m.name) + ', ' + escapeHtml(m.state) + '</span>' +
        '<span class="metro-tile__score" data-role="today">Score loading…</span>' +
        '<span class="metro-tile__best" data-role="best">Best day this week loading…</span>' +
      '</a>'
    );
  }
  return lines.join('\n') + '\n';
}

function sweepGenerated(dir) {
  let swept = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.html')) continue;
    const full = path.join(dir, name);
    let head;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(256);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.slice(0, bytesRead).toString('utf8');
    } catch {
      continue;
    }
    if (head.includes(GENERATED_MARKER)) {
      fs.unlinkSync(full);
      swept++;
    }
  }
  return swept;
}

function run(opts) {
  const outDir = (opts && opts.outDir) || OUT_DIR;
  const metros = (opts && opts.metros) || METROS;
  fs.mkdirSync(outDir, { recursive: true });

  const swept = sweepGenerated(outDir);
  if (swept > 0) {
    console.log('generate-metros: removed ' + swept + ' stale generated page(s) from ' + outDir + '/');
  }

  if (metros.length === 0) {
    console.log('generate-metros: 0 metros configured — emission skipped.');
    return { written: 0, swept };
  }

  let written = 0;
  for (const metro of metros) {
    const out = path.join(outDir, metro.slug + '.html');
    fs.writeFileSync(out, renderMetro(metro));
    written++;
  }
  console.log('generate-metros: wrote ' + written + ' metro pages → ' + outDir + '/');

  // Emit the chooser-page tile partial. Default path is
  // _partials/metros-list.html; tests can override via opts.listPartialOut
  // or opt out entirely with opts.listPartialOut = null. We default to
  // null when the caller passed a custom outDir (the test shape) so
  // tests don't clobber the real partial; production calls run() with no
  // opts and get the default path.
  const partialOut =
    opts && Object.prototype.hasOwnProperty.call(opts, 'listPartialOut')
      ? opts.listPartialOut
      : (opts && opts.outDir ? null : LIST_PARTIAL_OUT);
  if (partialOut) {
    fs.mkdirSync(path.dirname(partialOut), { recursive: true });
    fs.writeFileSync(partialOut, renderMetrosListPartial(metros));
    console.log('generate-metros: wrote chooser tile partial → ' + partialOut);
  }
  return { written, swept };
}

module.exports = {
  METROS,
  REGION_BY_STATE,
  STATE_NAME,
  REGION_LABEL,
  BBQ_HERITAGE_BY_STATE,
  BBQ_HERITAGE_BY_REGION,
  REGION_CLIMATE,
  REGION_COOKER_TIP,
  METRO_NOTE,
  METRO_LOCAL,
  GENERATED_MARKER,
  LAST_MODIFIED,
  renderMetro,
  renderMetrosListPartial,
  regionOf,
  heritageFor,
  escapeHtml,
  sweepGenerated,
  run,
  LIST_PARTIAL_OUT,
};

if (require.main === module) {
  run();
}
