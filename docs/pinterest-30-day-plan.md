# Pinterest 30-Day Launch Plan — July 10 → August 8, 2026

Purpose: drive referral traffic to the **13 calculator/tool pages** (primary) and the
smoke-weather / seasonal / guide pages (secondary). This replaces any prior Pinterest
planning; the Rich Pins infrastructure (PR #105/#106) is already live, so every pin below
gets Article Rich Pin treatment automatically once the domain is claimed.

Cadence: **1 pin per day for 30 days** (Pinterest's native scheduler allows up to 30 days
ahead, so the whole month can be queued in one sitting). Weekday pins post **8:30 PM ET**,
weekend pins **2:00 PM ET** — peak US home-cook browsing windows.

Mix: **25 calculator pins / 5 page pins** (~83/17, per the calculators-first goal).
Every calculator gets at least one pin; the highest-intent tools (brisket, ribs, pork,
meat-per-person, times & temps) get two angles with **different images** — Pinterest
treats a new image on a known URL as a "fresh pin," which is what the algorithm rewards.

---

## 1. One-time setup (before Day 1)

- [ ] Claim `pitmaster.tools` in Pinterest business settings (enables Rich Pins + analytics).
- [ ] Verify a calculator URL in the [Rich Pin validator](https://developers.pinterest.com/tools/url-debugger/) — the `og_type="article"` meta from PR #105 should light up.
- [ ] Create the 5 boards below with the exact names/descriptions (keyword-matched):

| Board | Description (board SEO) |
|---|---|
| **BBQ Calculators & Cheat Sheets** | Free smoking calculators — brisket time, rib schedules, meat per person, charcoal amounts. No guesswork, no signup. |
| **Smoked Brisket** | Brisket cook times, yield math, the stall, wrapping, and overnight cook planning. |
| **Ribs & Pulled Pork** | Rib timelines, pork butt cook times, and pulled-pork-for-a-crowd math. |
| **BBQ for a Crowd** | How much meat per person, catering math, cook scheduling, and what a cookout really costs. |
| **Smoking Weather & Seasons** | Best days and best cities to run your smoker, by real forecast data. |

- [ ] Add profile bio: "Free BBQ calculators & smoking cheat sheets. Brisket time, ribs, meat per person, charcoal — pitmaster.tools"

## 2. Link + tracking convention

Every pin's destination uses this UTM pattern (GA4 already live, `G-SJJVV37EWE`):

```
https://pitmaster.tools/<page>?utm_source=pinterest&utm_medium=pin&utm_campaign=pin30&utm_content=d<NN>-<slug>
```

Written below as `…?pin30&utm_content=dNN-slug` for brevity — expand to the full pattern
when scheduling. Canonicals on every page already point at the clean URL, so UTMs are
SEO-safe.

## 3. Image system

- **Existing creatives (Days 1–12, 14):** the committed `og/<slug>.png` files (1000×1500,
  brand style: charcoal `#1c140d`, cream `#f3ead8`, ember `#d9542e`, Anton headline).
  Upload these directly as the pin image — no new work needed.
- **Fresh creatives (17 images, Days 13, 15–30):** photo-led pins with a text overlay —
  a deliberately different look from the graphic cheat-sheet set, so each URL's second
  pin reads as new content. Each pin's entry below includes an **image prompt** (for AI
  generation or a stock/own photo brief) plus the exact overlay text. Production spec for
  all 17: **1000×1500 (2:3)**, photo top ~60%, solid `#1c140d` band bottom ~40% carrying
  the overlay headline in Anton (cream) with one ember accent line, small
  `pitmaster.tools` wordmark bottom-center. Batch-produce in Canva from one template.

---

## 4. The 30-day schedule

### Week 1 — Jul 10–16 · launch the core cheat sheets (existing images)

**Day 1 · Fri Jul 10 · 8:30 PM · Smoked Brisket**
- Link: `/brisket-calculator` `?pin30&utm_content=d01-brisket`
- Image: `og/brisket-calculator.png`
- Title: `Brisket Cook Time Calculator — Exact Hours by Weight (Free)`
- Description: `Stop guessing when the brisket goes on. Enter your weight and smoker temp and get the exact cook time, wrap point, and rest window — 8 lb to 20 lb packers, 225°F to 275°F. Free calculator, no signup. Perfect for planning an overnight cook.`

**Day 2 · Sat Jul 11 · 2:00 PM · Ribs & Pulled Pork**
- Link: `/rib-calculator` `?pin30&utm_content=d02-ribs`
- Image: `og/rib-calculator.png`
- Title: `How Long to Smoke Ribs — Baby Back, Spare & Beef Rib Timelines`
- Description: `Baby backs, St. Louis, or big beef ribs — each needs a different clock. This free rib calculator builds your full timeline at 225°F or 250°F, including wrap and sauce windows. Get ribs that bend, not fall apart.`

**Day 3 · Sun Jul 12 · 2:00 PM · Ribs & Pulled Pork**
- Link: `/pork-shoulder-calculator` `?pin30&utm_content=d03-porkbutt`
- Image: `og/pork-shoulder-calculator.png`
- Title: `Pork Butt Cook Time Calculator — Pulled Pork Without the Guessing`
- Description: `A 9 lb pork butt at 225°F is an all-day cook — but how long exactly? Enter your weight and temp and get the full schedule: cook time, stall window, wrap point, and when to start so dinner isn't at midnight. Free, no signup.`

**Day 4 · Mon Jul 13 · 8:30 PM · BBQ Calculators & Cheat Sheets**
- Link: `/smoking-times-and-temps` `?pin30&utm_content=d04-chart`
- Image: `og/smoking-times-and-temps.png`
- Title: `Smoking Times & Temps Chart — Every Cut, One Printable Cheat Sheet`
- Description: `Brisket 195–205°F. Pork butt 203°F. Chicken 165°F. One chart with smoker temps, target internal temps, and time-per-pound for every cut you'll ever smoke. Free and printable — tape it inside your smoker cabinet.`

**Day 5 · Tue Jul 14 · 8:30 PM · BBQ for a Crowd**
- Link: `/meat-per-person` `?pin30&utm_content=d05-meatpp`
- Image: `og/meat-per-person.png`
- Title: `How Much Meat Per Person? BBQ Serving Calculator`
- Description: `The rule of thumb is ½ lb cooked meat per guest — about 1 lb raw before trim and shrink. But brisket, ribs, and chicken all yield differently. This free calculator does the math for your exact headcount and menu so you buy the right amount.`

**Day 6 · Wed Jul 15 · 8:30 PM · BBQ for a Crowd**
- Link: `/cook-time-coordinator` `?pin30&utm_content=d06-coordinator`
- Image: `og/cook-time-coordinator.png`
- Title: `Make Every Meat Finish at the Same Time — Free BBQ Cook Scheduler`
- Description: `Brisket, ribs, and chicken all done at 6 PM — no cold brisket waiting on the ribs. Pick up to 6 meats and one serve time and get a start-time schedule for each. The tool every backyard cook wishes existed. Free, no signup.`

**Day 7 · Thu Jul 16 · 8:30 PM · BBQ Calculators & Cheat Sheets**
- Link: `/charcoal-calculator` `?pin30&utm_content=d07-charcoal`
- Image: `og/charcoal-calculator.png`
- Title: `How Much Charcoal Do You Actually Need? (Minion & Snake Method)`
- Description: `Running out of coals at hour 8 ruins a brisket. This free calculator gives you the exact charcoal load for Minion, Snake, or direct-heat cooks based on your temp and cook length — no more mid-cook refills or wasted briquettes.`

### Week 2 — Jul 17–23 · finish the tool set + first secondary page

**Day 8 · Fri Jul 17 · 8:30 PM · BBQ Calculators & Cheat Sheets**
- Link: `/dry-rub-calculator` `?pin30&utm_content=d08-rub`
- Image: `og/dry-rub-calculator.png`
- Title: `Dry Rub Calculator — Scale Any Rub Recipe to Any Amount of Meat`
- Description: `Your rub recipe covers 5 lb but you're cooking 14. This free calculator scales salt, sugar, and spice in perfect balance for any weight — so a bigger batch never means saltier bark. Works with any rub recipe you already love.`

**Day 9 · Sat Jul 18 · 2:00 PM · BBQ for a Crowd**
- Link: `/catering-calculator` `?pin30&utm_content=d09-catering`
- Image: `og/catering-calculator.png`
- Title: `BBQ Catering Calculator — Feed 20 to 500 People Without Overbuying`
- Description: `Family reunion, graduation party, church cookout — this free calculator turns a headcount into a shopping list: raw pounds per meat, servings, and total cost for up to 500 guests. Plan the whole menu in two minutes.`

**Day 10 · Sun Jul 19 · 2:00 PM · BBQ Calculators & Cheat Sheets**
- Link: `/brine-calculator` `?pin30&utm_content=d10-brine`
- Image: `og/brine-calculator.png`
- Title: `Brine Calculator — Exact Salt, Sugar & Water for Any Cut`
- Description: `Wet or dry brine, any cut, by weight: this free calculator gives the exact salt, sugar, and water so chicken and turkey come off the smoker juicy every single time. No more "about a cup of salt" guesswork.`

**Day 11 · Mon Jul 20 · 8:30 PM · BBQ for a Crowd**
- Link: `/bbq-cost-calculator` `?pin30&utm_content=d11-cost`
- Image: `og/bbq-cost-calculator.png`
- Title: `What Does Your BBQ Actually Cost? Free Cost-Per-Serving Calculator`
- Description: `Meat, rub, charcoal, and 12 hours of your time — what's the real number? This free calculator breaks down total cost, cost per pound, and cost per serving. Eye-opening if you're thinking about selling plates or just defending your hobby.`

**Day 12 · Tue Jul 21 · 8:30 PM · Smoked Brisket**
- Link: `/brisket-yield-calculator` `?pin30&utm_content=d12-yield`
- Image: `og/brisket-yield-calculator.png`
- Title: `Brisket Yield Calculator — How Much Cooked Meat a Packer Really Gives`
- Description: `A 14 lb packer brisket yields about 7 lb of sliced meat — roughly 50% after trim and cook loss. Buying for a party? This free calculator works backward from servings needed to the raw weight to buy. Never come up short again.`

**Day 13 · Wed Jul 22 · 8:30 PM · Smoking Weather & Seasons** *(secondary page)*
- Link: `/smoke-weather/` `?pin30&utm_content=d13-smokeweather`
- Image (fresh): **Prompt:** photo of a backyard offset smoker with thin blue smoke against a clear golden-hour sky, light breeze visible in the smoke. Overlay headline: `IS THIS WEEKEND A SMOKE DAY?` · accent line: `Wind, rain & temp — checked for you` · footer: `FREE SMOKE-DAY FORECAST`
- Title: `Is This Weekend Good Smoking Weather? Free Smoke-Day Forecast`
- Description: `Wind wrecks temps, rain kills your fire, and a cold snap adds hours. This free tool grades the next 7 days for smoking weather at your location — so you pick the right day before you trim the brisket.`

**Day 14 · Thu Jul 23 · 8:30 PM · BBQ Calculators & Cheat Sheets**
- Link: `/turkey-smoking-calculator` `?pin30&utm_content=d14-turkey`
- Image: `og/turkey-smoking-calculator.png`
- Title: `Smoked Turkey Time Calculator — Don't Wait for November to Practice`
- Description: `The best Thanksgiving turkeys get a summer practice run. This free calculator gives exact smoke time for any bird at 275°F — 12 lb in about 6 hours — plus brine and rest timing. Pin now, thank yourself in November.`

### Week 3 — Jul 24–30 · second angles, fresh photo creatives

**Day 15 · Fri Jul 24 · 8:30 PM · Smoked Brisket**
- Link: `/brisket-calculator` `?pin30&utm_content=d15-brisket2`
- Image (fresh): **Prompt:** moody night shot of a smoker glowing in a dark backyard, thermometer probe visible, stars overhead. Overlay: `OVERNIGHT BRISKET MATH` · accent: `When to light the fire so lunch is on time` · footer: `FREE BRISKET CALCULATOR`
- Title: `Overnight Brisket: When to Start So It's Done for Lunch`
- Description: `A 13 lb brisket at 225°F needs 16–19 hours plus rest — which means lighting the smoker around 6 PM the night before. This free calculator works backward from your serve time to your exact fire-up time. Sleep math, solved.`

**Day 16 · Sat Jul 25 · 2:00 PM · BBQ for a Crowd**
- Link: `/meat-per-person` `?pin30&utm_content=d16-meatpp2`
- Image (fresh): **Prompt:** overhead shot of a long picnic table loaded with platters of sliced brisket, pulled pork, and ribs, hands reaching in, summer party feel. Overlay: `BBQ FOR 20 PEOPLE` · accent: `Exactly how much meat to buy` · footer: `FREE SERVING CALCULATOR`
- Title: `Feeding 20 at a Cookout? Here's Exactly How Much Meat to Buy`
- Description: `20 guests ≈ 10 lb of cooked meat ≈ 20 lb raw — but the split changes if you're serving ribs vs pulled pork vs brisket. Free calculator: enter your headcount and menu, get a shopping list. July cookout season, handled.`

**Day 17 · Sun Jul 26 · 2:00 PM · Ribs & Pulled Pork**
- Link: `/rib-calculator` `?pin30&utm_content=d17-ribs2`
- Image (fresh): **Prompt:** close-up of glistening sauced spare ribs being lifted off a smoker grate with tongs, smoke wisps, shallow depth of field. Overlay: `THE 3-2-1 RIB CLOCK` · accent: `Your exact wrap & sauce times` · footer: `FREE RIB CALCULATOR`
- Title: `3-2-1 Ribs Explained — Get Your Exact Wrap and Sauce Times`
- Description: `3 hours of smoke, 2 wrapped, 1 sauced — but baby backs need less and beef ribs need more. This free calculator adjusts the classic 3-2-1 method to your rack and your smoker temp, with clock times for every stage.`

**Day 18 · Mon Jul 27 · 8:30 PM · Smoked Brisket** *(secondary page)*
- Link: `/guides/techniques/managing-the-stall` `?pin30&utm_content=d18-stall`
- Image (fresh): **Prompt:** digital meat thermometer reading 165°F stuck in a dark-bark brisket on a smoker grate, frustrated vibe, smoke in background. Overlay: `STUCK AT 165°F FOR 4 HOURS?` · accent: `That's the stall. Here's what to do` · footer: `PITMASTER.TOOLS/GUIDES`
- Title: `Why Your Brisket Is Stuck at 165°F — The Stall, Explained`
- Description: `Every big cut hits a wall around 150–170°F and sits there for hours. It's evaporative cooling, not a broken thermometer. This guide covers why the stall happens, when to wrap, and when to just wait it out. Don't crank the heat — read this first.`

**Day 19 · Tue Jul 28 · 8:30 PM · BBQ Calculators & Cheat Sheets**
- Link: `/dry-rub-calculator` `?pin30&utm_content=d19-rub2`
- Image (fresh): **Prompt:** overhead flat-lay of rub ingredients in small bowls — coarse salt, brown sugar, paprika, pepper — on dark slate, one hand sprinkling rub on a raw pork butt. Overlay: `THE RUB RATIO` · accent: `Salt : sugar : spice, scaled to any cut` · footer: `FREE DRY RUB CALCULATOR`
- Title: `The Dry Rub Ratio That Works on Everything (and Scales Perfectly)`
- Description: `Great rubs are a ratio, not a recipe. Keep salt, sugar, and spice in balance and you can season a 3 lb chicken or a 16 lb brisket from the same formula. This free tool scales any rub to any weight — measured in spoons, not vibes.`

**Day 20 · Wed Jul 29 · 8:30 PM · BBQ for a Crowd**
- Link: `/cook-time-coordinator` `?pin30&utm_content=d20-coordinator2`
- Image (fresh): **Prompt:** kitchen wall clock at 6:00 next to a window view of a smoker, table set for dinner in foreground, warm evening light. Overlay: `EVERYTHING DONE AT 6 PM` · accent: `Brisket, ribs & chicken — one schedule` · footer: `FREE COOK COORDINATOR`
- Title: `The Multi-Meat Schedule: Brisket, Ribs & Chicken All Done at 6`
- Description: `The brisket goes on at 4 AM, ribs at noon, chicken at 4:30 — and everything lands together. Enter up to 6 meats and one serve time; this free tool builds the full start-time schedule. Hosting season's secret weapon.`

**Day 21 · Thu Jul 30 · 8:30 PM · Smoking Weather & Seasons** *(secondary page)*
- Link: `/seasonal/summer` `?pin30&utm_content=d21-summer`
- Image (fresh): **Prompt:** bright summer backyard scene, kettle smoker with thin smoke, kids' pool blurred in background, blue sky with a few clouds. Overlay: `SUMMER SMOKING GUIDE` · accent: `Heat, humidity & your smoker` · footer: `PITMASTER.TOOLS/SEASONAL`
- Title: `Summer Smoking: What 95°F Ambient Does to Your Cook`
- Description: `Hot days mean faster starts, thirstier water pans, and afternoon thunderstorms that ambush your fire. Our summer guide covers how heat and humidity change your smoke — plus which days this week actually forecast well. It's National Grilling Month; smoke accordingly.`

### Week 4 — Jul 31–Aug 6 · second angles continued

**Day 22 · Fri Jul 31 · 8:30 PM · Ribs & Pulled Pork**
- Link: `/pork-shoulder-calculator` `?pin30&utm_content=d22-porkbutt2`
- Image (fresh): **Prompt:** two forks pulling apart a steaming smoked pork butt on a wooden board, visible smoke ring and bark, rustic table. Overlay: `PULLED PORK FOR A CROWD` · accent: `8 lb butt = 4 lb pork = 12 sandwiches` · footer: `FREE PORK CALCULATOR`
- Title: `Pulled Pork Math: One 8 lb Butt Feeds 12 — Here's the Timing`
- Description: `An 8 lb pork butt yields about 4 lb of pulled pork — a dozen good sandwiches — and needs 12–16 hours at 225°F. This free calculator gives your exact cook time and start time by weight and temp, so the buns and the butt are ready together.`

**Day 23 · Sat Aug 1 · 2:00 PM · BBQ for a Crowd**
- Link: `/catering-calculator` `?pin30&utm_content=d23-catering2`
- Image (fresh): **Prompt:** chafing dishes and foil pans of BBQ on a folding table at an outdoor family reunion, banner and string lights, golden hour. Overlay: `FEEDING THE WHOLE REUNION` · accent: `Meat, servings & cost for up to 500` · footer: `FREE CATERING CALCULATOR`
- Title: `Reunion & Party BBQ Planner — Meat, Servings and Cost in One Shot`
- Description: `August is reunion season. Enter your headcount and this free tool returns the raw pounds to buy per meat, the servings you'll get, and the total budget — for anywhere from 20 to 500 people. Print the list, hit the butcher, done.`

**Day 24 · Sun Aug 2 · 2:00 PM · BBQ Calculators & Cheat Sheets**
- Link: `/smoking-times-and-temps` `?pin30&utm_content=d24-chart2`
- Image (fresh): **Prompt:** instant-read thermometer being inserted into a sliced brisket flat showing a pink smoke ring, cutting board scattered with juices. Overlay: `PULL TEMPS THAT MATTER` · accent: `Brisket 203 · Pork 203 · Chicken 165 · Ribs bend` · footer: `FREE TIMES & TEMPS CHART`
- Title: `The Only Pull Temps You Need to Memorize (Plus a Chart for the Rest)`
- Description: `Brisket comes off probe-tender around 203°F. Pork butt too. Chicken is safe at 165°F, ribs are done when they bend. For everything else — turkey, chuck, sausage, fish — there's one free printable chart with smoker temps and times per pound.`

**Day 25 · Mon Aug 3 · 8:30 PM · Smoking Weather & Seasons** *(secondary page)*
- Link: `/smoke-weather/best-cities` `?pin30&utm_content=d25-bestcities`
- Image (fresh): **Prompt:** stylized US map graphic in brand palette (charcoal background, ember-orange markers on ~10 cities, cream typography) — this one is a graphic, not a photo. Overlay: `AMERICA'S BEST SMOKING WEATHER` · accent: `50 cities, ranked by real forecasts` · footer: `SEE THE LEADERBOARD`
- Title: `The 50 Best (and Worst) US Cities for Smoking Weather, Ranked`
- Description: `We grade the 7-day forecast for wind, rain, and temperature in 50 US metros and rank them — updated from real weather data. See where your city lands and whether this week is worth lighting the fire. Bragging rights included.`

**Day 26 · Tue Aug 4 · 8:30 PM · BBQ Calculators & Cheat Sheets**
- Link: `/charcoal-calculator` `?pin30&utm_content=d26-charcoal2`
- Image (fresh): **Prompt:** overhead view inside a kettle grill showing charcoal briquettes arranged in a snake/fuse pattern around the edge, a few lit at one end. Overlay: `THE SNAKE METHOD` · accent: `How many briquettes for 8 steady hours` · footer: `FREE CHARCOAL CALCULATOR`
- Title: `Snake Method Setup: Exactly How Many Briquettes for an 8-Hour Cook`
- Description: `The snake method turns a kettle into a set-and-forget smoker — if you build it long enough. This free calculator gives the briquette count and snake length for your temp and cook time, so the fire dies when the cook ends, not before.`

**Day 27 · Wed Aug 5 · 8:30 PM · BBQ Calculators & Cheat Sheets**
- Link: `/brine-calculator` `?pin30&utm_content=d27-brine2`
- Image (fresh): **Prompt:** whole raw chicken submerged in a clear brine in a glass bowl with peppercorns and bay leaves floating, bright clean kitchen light. Overlay: `NEVER DRY CHICKEN AGAIN` · accent: `Exact brine by weight — wet or dry` · footer: `FREE BRINE CALCULATOR`
- Title: `The Chicken Brine Formula — Exact Salt & Time by Bird Weight`
- Description: `Dry smoked chicken is a brine problem, not a smoker problem. This free calculator gives the exact salt, sugar, water, and brining time for your bird's weight — wet or dry method. Juicy every time, measured not guessed.`

**Day 28 · Thu Aug 6 · 8:30 PM · BBQ for a Crowd**
- Link: `/bbq-cost-calculator` `?pin30&utm_content=d28-cost2`
- Image (fresh): **Prompt:** split-composition image — left: a BBQ restaurant tray of brisket with a receipt; right: a backyard smoker plate of the same food. Brand-palette divider. Overlay: `$28 A PLATE… OR $9 AT HOME?` · accent: `The real cost of backyard BBQ` · footer: `FREE COST CALCULATOR`
- Title: `Restaurant Brisket vs. Your Backyard: The Real Cost Per Plate`
- Description: `Brisket plates run $25–30 out. At home? This free calculator totals your meat, rub, and fuel and divides by servings — most backyard cooks land under $10 a plate. Run your own numbers before your next cook (or your next food-truck daydream).`

### Days 29–30 — Aug 7–8 · roundup + top-performer reinforcement

**Day 29 · Fri Aug 7 · 8:30 PM · BBQ Calculators & Cheat Sheets** *(secondary page)*
- Link: `/tools` `?pin30&utm_content=d29-toolshub`
- Image (fresh): **Prompt:** brand-palette graphic (not photo): 3×4 grid of small cream tool icons (flame, scale, clock, thermometer, people, dollar…) on charcoal, one highlighted in ember. Overlay: `13 FREE BBQ CALCULATORS` · accent: `Time · temps · servings · charcoal · cost` · footer: `ALL FREE · NO SIGNUP`
- Title: `13 Free BBQ Calculators Every Backyard Pitmaster Should Bookmark`
- Description: `Brisket time. Rib schedules. Meat per person. Charcoal loads. Brine ratios. Cook coordination. What it all costs. Thirteen free calculators, no signup, built for people who smoke meat. Pin this one — it's the whole toolbox.`

**Day 30 · Sat Aug 8 · 2:00 PM · Smoked Brisket**
- Link: `/brisket-calculator` `?pin30&utm_content=d30-brisket3`
- Image (fresh): **Prompt:** side-by-side of a whole packer brisket and a trimmed flat on butcher paper, labels rendered in overlay. Overlay: `FLAT vs PACKER` · accent: `Different cuts, very different clocks` · footer: `FREE BRISKET CALCULATOR`
- Title: `Flat vs. Whole Packer: Why Your Brisket Timing Is Probably Wrong`
- Description: `A 6 lb flat and a 14 lb packer don't just differ in size — thickness changes everything about the clock. This free calculator handles both cuts, any weight, any smoker temp, and tells you exactly when to start. The #1 tool on pitmaster.tools.`

---

## 5. Production checklist

- [ ] Days 1–12, 14: upload existing `og/<slug>.png` files (13 already committed — zero new work).
- [ ] Days 13, 15–30: produce the 17 photo/graphic creatives from the prompts above (one Canva template: photo top 60%, `#1c140d` band bottom 40%, Anton headline in `#f3ead8`, accent line in `#d9542e`, wordmark footer). Days 25 & 29 are pure brand graphics, not photos.
- [ ] Queue all 30 pins in Pinterest's native scheduler with the exact dates/times/boards above.
- [ ] Expand each shorthand link to the full UTM pattern from §2.

## 6. Measurement & what happens on Day 31

Check GA4 (`utm_campaign=pin30`) and Pinterest Analytics weekly. Decision rules for month 2:

- **Outbound-click rate ≥ 0.5%** on a pin → make 2 more image variants of that URL next month.
- Calculator pins should out-click page pins; if a page pin outperforms (likely candidates: the stall guide, best-cities), promote its section to a weekly slot.
- Seasonal pipeline for month 2 (Aug 9+): tailgate/football prep (cook-time coordinator, catering), Labor Day (Sep 7) countdown pins for brisket + meat-per-person, and the turkey calculator ramp starting late September.
- New guides go live on their `published` dates — add a pin for each guide within 3 days of it going live (next up: *How to Wrap a Brisket*, Sep 1).
