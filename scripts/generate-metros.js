#!/usr/bin/env node
/**
 * generate-metros.js — emit one HTML page per Best-Smoke-Days metro into
 * _src/smoke-weather/<slug>.html before build.js runs.
 *
 * The 50 metros embedded here must stay in lockstep with
 * worker/migrations/0002_metros_seed.sql. scripts/generate-metros.test.js
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

// State -> region (must match worker/migrations/0004_add_region.sql).
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

// Last-modified date emitted in og/twitter/json-ld. Bump when the template
// changes materially; metro-list changes alone don't require it.
const LAST_MODIFIED = '2026-05-15';

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

  const pageTitle = name + ', ' + metro.state + ' BBQ Forecast — Best Smoke Days | Pitmaster Tools';
  const ogTitle   = name + ', ' + metro.state + ' BBQ Forecast — Best Smoke Days';
  const desc      = 'Free 7-day weather-aware smoke forecast for ' + name + ', ' + metro.state + '. Day-by-day scores for brisket, ribs, pork, and chicken on offset, pellet, kamado, kettle, or electric cookers.';
  const canonical = 'https://pitmaster.tools/smoke-weather/' + slug;

  const note      = METRO_NOTE[slug];
  if (!note) throw new Error('generate-metros: missing METRO_NOTE for ' + slug);
  const intro     = name + ', ' + stateNm + ' sits in the ' + regLbl + ' barbecue region. ' + note + ' This page scores the next seven days for low-and-slow cooks in the ' + name + ' metro, weighing rain probability, sustained wind and gusts, daytime temperature, and the wet-bulb humidity that drives the stall — then weights the result for your cut and cooker so you can pick the day with the highest odds of a clean cook.';
  const closing   = 'Pick a day with a strong score, light the fire, and stop guessing whether Saturday in ' + name + ' will hold. The form lets you swap cut and cooker without leaving the page — your selection persists across visits via local storage. ZIP defaults to ' + zip + ' for the ' + name + ' metro; change it any time to score a different yard.';

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
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>' + escapeHtml(pageTitle) + '</title>',
    '<meta name="description" content="' + escapeHtml(desc) + '">',
    '<meta name="robots" content="index, follow">',
    '<link rel="canonical" href="' + canonical + '">',
    '<meta property="og:title" content="' + escapeHtml(ogTitle) + '">',
    '<meta property="og:description" content="' + escapeHtml(desc) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:url" content="' + canonical + '">',
    '<meta property="og:image" content="https://pitmaster.tools/og-image.png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="Pitmaster Tools - Free BBQ Calculators">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + escapeHtml(ogTitle) + '">',
    '<meta name="twitter:description" content="' + escapeHtml(desc) + '">',
    '<meta name="twitter:image" content="https://pitmaster.tools/og-image.png">',
    '<link rel="icon" href="/favicon.ico" sizes="any">',
    '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 64 64\'%3E%3Cpath fill=\'%23EF9F27\' d=\'M36 4c2 10-3 15-8 21-5 6-9 11-9 19 0 10 7 16 15 16 11 0 19-8 19-19 0-12-7-19-17-37z\'/%3E%3Cpath fill=\'%23D78108\' d=\'M33 27c1 6-2 9-5 12-3 3-5 6-5 10 0 6 4 10 9 10 7 0 12-5 12-12 0-7-4-11-11-20z\'/%3E%3C/svg%3E">',
    '<script>',
    '  window.dataLayer = window.dataLayer || [];',
    '  function gtag(){dataLayer.push(arguments);}',
    '  gtag(\'consent\', \'default\', {',
    '    \'ad_storage\': \'denied\',',
    '    \'analytics_storage\': \'denied\',',
    '    \'ad_user_data\': \'denied\',',
    '    \'ad_personalization\': \'denied\',',
    '    \'wait_for_update\': 500',
    '  });',
    '</script>',
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
    '</head>',
    '<body>',
    '',
    '<a href="#main-content" class="skip-link">Skip to main content</a>',
    '<header>',
    '  <a href="/" class="logo">Pitmaster<span> Tools</span></a>',
    '  <div class="header-right">',
    '  <nav class="header-nav" aria-label="Site navigation">',
    '    <div class="nav-dropdown">',
    '      <button class="nav-dropdown__trigger" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="tools-menu">Tools</button>',
    '      <ul class="nav-dropdown__menu" id="tools-menu" role="list">',
    '        <li><a href="/tools">All Tools</a></li>',
    '        <li><a href="/">Meat Smoking Calculator</a></li>',
    '        <li><a href="/smoke-weather/">Best Smoke Days</a></li>',
    '        <li><a href="/brisket-calculator">Brisket Calculator</a></li>',
    '        <li><a href="/pork-shoulder-calculator">Pork Shoulder Calculator</a></li>',
    '        <li><a href="/rib-calculator">Rib Calculator</a></li>',
    '        <li><a href="/turkey-smoking-calculator">Turkey Calculator</a></li>',
    '        <li><a href="/meat-per-person">Meat Per Person</a></li>',
    '        <li><a href="/cook-time-coordinator">Cook Time Coordinator</a></li>',
    '        <li><a href="/charcoal-calculator">Charcoal Calculator</a></li>',
    '        <li><a href="/brine-calculator">Brine Calculator</a></li>',
    '        <li><a href="/dry-rub-calculator">Dry Rub Calculator</a></li>',
    '        <li><a href="/bbq-cost-calculator">BBQ Cost Calculator</a></li>',
    '        <li><a href="/catering-calculator">Catering Calculator</a></li>',
    '        <li><a href="/brisket-yield-calculator">Brisket Yield Calculator</a></li>',
    '      </ul>',
    '    </div>',
    '    <a href="/about">About</a>',
    '  </nav>',
    '  </div>',
    '</header>',
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
    '      <a class="tool-link" href="/smoke-weather/">',
    '        <div>',
    '          <div class="tool-link-name">Best Smoke Days</div>',
    '          <div class="tool-link-desc">All metros and the full 7-day weather-aware forecast.</div>',
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
    '<!-- Cookie consent banner -->',
    '<div class="cookie-banner" id="cookieBanner" role="dialog" aria-live="polite" aria-label="Cookie consent">',
    '  <div class="cookie-banner__inner">',
    '    <p class="cookie-banner__text">We use cookies for analytics and advertising. See our <a href="/privacy-policy">Privacy Policy</a> for details.</p>',
    '    <div class="cookie-banner__actions">',
    '      <button class="cookie-accept" id="cookieAccept" type="button">Accept</button>',
    '      <button class="cookie-reject" id="cookieReject" type="button">Reject</button>',
    '    </div>',
    '  </div>',
    '</div>',
    '',
    '<footer>',
    '  <div>&#169; 2026 Pitmaster Tools. All rights reserved.</div>',
    '  <nav aria-label="Footer">',
    '    <a href="/">Calculator</a>',
    '    <span>|</span>',
    '    <a href="/tools">All Tools</a>',
    '    <span>|</span>',
    '    <a href="/smoke-weather/">Best Smoke Days</a>',
    '    <span>|</span>',
    '    <a href="/smoke-weather/methodology">Methodology</a>',
    '    <span>|</span>',
    '    <a href="/smoke-weather/faq">FAQ</a>',
    '    <span>|</span>',
    '    <a href="/smoke-weather/disclosures">Disclosures</a>',
    '    <span>|</span>',
    '    <a href="/privacy-policy">Privacy Policy</a>',
    '    <span>|</span>',
    '    <a href="/terms-of-service">Terms of Service</a>',
    '    <span>|</span>',
    '    <a href="mailto:contact@pitmaster.tools">contact@pitmaster.tools</a>',
    '  </nav>',
    '  <p class="footer-small">Forecasts use Open-Meteo and the US National Weather Service. Conditions can change quickly — verify before you cook.</p>',
    '  <p class="footer-small">Last updated: ' + LAST_MODIFIED + '</p>',
    '</footer>',
    '',
    '<!-- INJECT:site-utils.js:script -->',
    '<!-- INJECT:weather-score-shared.js:script -->',
    '<!-- INJECT:smoke-weather-app.js:script -->',
    '<!-- INJECT:site-header.js:script -->',
    '<script>',
    '  if (typeof initConsentBanner === \'function\') initConsentBanner();',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
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
  GENERATED_MARKER,
  LAST_MODIFIED,
  renderMetro,
  regionOf,
  heritageFor,
  escapeHtml,
  sweepGenerated,
  run,
};

if (require.main === module) {
  run();
}
