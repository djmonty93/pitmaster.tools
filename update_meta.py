#!/usr/bin/env python3
"""
update_meta.py — Update <title>, og:title, twitter:title,
                 <meta name="description">, og:description, twitter:description
                 in all _src/*.html files.

Titles must be < 70 rendered chars.
Descriptions must be 25–160 chars.
"""
import re, os

SRC = '_src'

# (title, description)  —  both used for all six tags
# title: shown in browser/SERP; og/twitter title omit " | Pitmaster Tools" suffix
# For pages already OK, set None to skip that field
UPDATES = {
    '404.html': (
        None,   # 32 chars — OK
        None,   # no description on noindex page — leave as-is
    ),
    'about.html': (
        None,   # 59 chars — OK
        'Learn what Pitmaster Tools is, how the BBQ calculators work, what the estimates mean, and how to use the site for smoking, serving, and catering.',
    ),
    'bbq-cost-calculator.html': (
        'BBQ Cost Calculator \u2014 Cost Per Serving | Pitmaster Tools',
        None,   # 159 chars — already OK
    ),
    'brine-calculator.html': (
        'Brine Calculator \u2014 Wet and Dry Brine Ratios | Pitmaster Tools',
        'Free brine calculator for BBQ. Enter meat weight, salt type, and strength to get exact water, salt, and sugar amounts for wet or dry brining any cut.',
    ),
    'brisket-calculator.html': (
        'Brisket Smoking Calculator \u2014 Full Cook Timeline | Pitmaster Tools',
        'Free brisket smoking calculator. Enter weight, smoker temp, and serve time to get cook times, start time, and a full smoking timeline for brisket.',
    ),
    'brisket-yield-calculator.html': (
        'Brisket Yield Calculator \u2014 Raw to Cooked Weight | Pitmaster Tools',
        'Free brisket yield calculator. Enter packer weight and grade to get flat and point weights, trimmed raw weight, and cooked yield with estimated servings.',
    ),
    'catering-calculator.html': (
        'BBQ Catering Calculator \u2014 How Much BBQ Per Person | Pitmaster Tools',
        'Free BBQ catering calculator. Enter guest count and meat choices to get raw weight, serving breakdowns, and cost estimates for up to 500 guests.',
    ),
    'charcoal-calculator.html': (
        'Charcoal Calculator \u2014 How Much for Any BBQ | Pitmaster Tools',
        'Free charcoal calculator for BBQ smoking. Enter cook method, temperature, and duration to get exact charcoal for Minion, Snake, or direct-heat cooks.',
    ),
    'cook-time-coordinator.html': (
        'Cook Time Coordinator \u2014 Stagger Multiple BBQ Meats | Pitmaster Tools',
        'Free BBQ cook time coordinator. Add up to 6 meats, set a single serve time, and get a staggered start schedule so everything finishes together.',
    ),
    'dry-rub-calculator.html': (
        'Dry Rub Calculator \u2014 Scale Any BBQ Rub Recipe | Pitmaster Tools',
        'Free BBQ dry rub calculator. Enter meat weight and recipe to get exact scaled amounts for light, standard, or heavy coverage \u2014 any cut, any crowd.',
    ),
    'index.html': (
        'Meat Smoking Calculator \u2014 Times, Temps and Timeline | Pitmaster Tools',
        'Free meat smoking calculator. Get cook times, pull temps, and wood pairings for brisket, pork, ribs, chicken, turkey, and more. Includes a buying guide.',
    ),
    'meat-per-person.html': (
        'Meat Per Person \u2014 BBQ Serving Size Calculator | Pitmaster Tools',
        'Free BBQ serving size calculator. Enter cut, headcount, and appetite to find exactly how much raw meat to buy, accounting for shrinkage on every cut.',
    ),
    'pork-shoulder-calculator.html': (
        'Pork Shoulder Smoking Calculator \u2014 Full Timeline | Pitmaster Tools',
        'Free pork shoulder smoking calculator. Enter weight, smoker temp, and serve time to get exact cook times and a full timeline for pulled or sliced pork.',
    ),
    'privacy-policy.html': (
        None,   # 32 chars — OK
        None,   # 99 chars — OK
    ),
    'rib-calculator.html': (
        None,   # 65 chars — OK
        None,   # 153 chars — OK
    ),
    'terms-of-service.html': (
        None,   # 34 chars — OK
        None,   # 110 chars — OK
    ),
    'tools.html': (
        None,   # 42 chars — OK
        'Free BBQ calculators: brisket times, rib method, pork shoulder, turkey, dry rub, brine ratios, charcoal amounts, serving math, catering, and cost per serving.',
    ),
    'turkey-smoking-calculator.html': (
        'Turkey Smoking Calculator \u2014 Cook Times and Schedule | Pitmaster Tools',
        'Free turkey smoking calculator. Enter cut, weight, and smoker temp to get exact cook times and a full schedule \u2014 whole bird, breast, legs, thighs, or wings.',
    ),
}

def og_title(full_title):
    """Strip ' | Pitmaster Tools' suffix for OG/Twitter title."""
    return re.sub(r'\s*\|\s*Pitmaster Tools$', '', full_title)

def html_attr(s):
    """Escape < > & " for use in an HTML attribute value."""
    return s.replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')

def set_title(html, new_title):
    """Replace <title>...</title>."""
    return re.sub(r'<title>.*?</title>', f'<title>{html_attr(new_title)}</title>', html, flags=re.DOTALL)

def set_meta(html, name, new_value):
    """Replace <meta name="name" content="...">  or  <meta property="name" content="...">."""
    def replacer(m):
        return m.group(0)[:m.start('val') - m.start(0)] + html_attr(new_value) + '"'
    pattern = rf'(<meta\s+(?:name|property)="{re.escape(name)}"\s+content=")([^"]*?)(")'
    return re.sub(pattern, lambda m: m.group(1) + html_attr(new_value) + m.group(3), html)

def verify(label, value, min_len, max_len):
    rendered = value.replace('&amp;', '&').replace('&quot;', '"').replace('&lt;', '<').replace('&gt;', '>')
    n = len(rendered)
    status = 'OK' if min_len <= n <= max_len else 'FAIL'
    print(f'    {status} ({n:3d}) {label}: {rendered[:80]}')

def main():
    for filename, (new_title, new_desc) in UPDATES.items():
        filepath = os.path.join(SRC, filename)
        if not os.path.exists(filepath):
            print(f'  SKIP (not found): {filename}')
            continue

        if new_title is None and new_desc is None:
            print(f'  OK (no changes): {filename}')
            continue

        with open(filepath, 'r', encoding='utf-8') as f:
            html = f.read()

        changed = []

        if new_title is not None:
            html = set_title(html, new_title)
            html = set_meta(html, 'og:title', og_title(new_title))
            html = set_meta(html, 'twitter:title', og_title(new_title))
            changed.append('title')

        if new_desc is not None:
            html = set_meta(html, 'description', new_desc)
            html = set_meta(html, 'og:description', new_desc)
            html = set_meta(html, 'twitter:description', new_desc)
            changed.append('description')

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(html)

        print(f'  Updated ({", ".join(changed)}): {filename}')
        if new_title is not None:
            verify('title', html_attr(new_title), 1, 69)
        if new_desc is not None:
            verify('desc ', new_desc, 25, 160)

if __name__ == '__main__':
    main()
