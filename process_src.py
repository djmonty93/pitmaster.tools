#!/usr/bin/env python3
"""
process_src.py — Transforms _src/*.html files for the build-script refactor.

Actions per page:
  1. Replace <link rel="stylesheet" href="site-header.css?v=1"> with inject placeholders
  2. Filter shared CSS rules from <style> block (using selector-based comparison)
  3. Replace <script src="site-header.js?v=1"></script> with inject placeholder
  4. Add <!-- INJECT:site-utils.js:script --> before the main <script> block (where needed)
  5. Remove shared JS variables and function definitions from <script> block
  6. Normalize cookie banner HTML (tools.html, rib-calculator.html)

Pages skipped: 404.html (standalone, no shared CSS/JS)
"""

import re
import os

PARTIALS = '_partials'
SRC = '_src'

# Pages to skip entirely
SKIP_PAGES = {'404.html'}

# Pages that have shared JS but don't use site-utils.js (simple static pages)
# These only get link/CSS/script-src replacements, not site-utils.js inject
SIMPLE_PAGES = {'about.html', 'privacy-policy.html', 'terms-of-service.html'}

# Canonical cookie banner HTML (use exactly this in all calc/tool pages)
CANONICAL_BANNER = (
    '<div class="cookie-banner" id="cookieBanner" role="dialog" '
    'aria-live="polite" aria-label="Cookie consent">\n'
    '  <div class="cookie-banner__inner">\n'
    '    <p class="cookie-banner__text">We use cookies for analytics and personalized ads. '
    'See our <a href="privacy-policy.html">Privacy Policy</a>.</p>\n'
    '    <div class="cookie-banner__actions">\n'
    '      <button class="cookie-accept" id="acceptCookies" type="button">Accept all</button>\n'
    '      <button class="cookie-reject" id="rejectCookies" type="button">Reject non-essential</button>\n'
    '    </div>\n'
    '  </div>\n'
    '</div>'
)

# ---------------------------------------------------------------------------
# CSS helpers
# ---------------------------------------------------------------------------

def strip_css_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.DOTALL)

def norm_ws(s):
    """Collapse whitespace sequences to single space and strip."""
    return re.sub(r'\s+', ' ', s).strip()

def parse_css_top_level_blocks(css_text):
    """
    Return list of (normalized_selector, original_block_text) for each
    top-level CSS block in css_text.
    Handles nested @-rules (e.g. @media { .a { } }).
    """
    css = strip_css_comments(css_text)
    blocks = []
    depth = 0
    block_start = 0
    i = 0
    while i < len(css):
        ch = css[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                block = css[block_start:i + 1].strip()
                if block:
                    brace_idx = block.index('{')
                    selector = norm_ws(block[:brace_idx])
                    blocks.append((selector, block))
                block_start = i + 1
        i += 1
    # Any trailing non-block text (e.g. stray declarations) is ignored.
    return blocks

def load_shared_selectors():
    """Return set of normalized selectors present in site-base.css."""
    path = os.path.join(PARTIALS, 'site-base.css')
    with open(path, 'r', encoding='utf-8') as f:
        css = f.read()
    blocks = parse_css_top_level_blocks(css)
    return {sel for sel, _ in blocks}

def filter_style_block(style_content, shared_selectors):
    """
    Remove CSS rules from style_content whose normalized selector is
    in shared_selectors.  Return the filtered CSS text.
    """
    blocks = parse_css_top_level_blocks(style_content)
    kept = []
    for sel, block in blocks:
        if sel not in shared_selectors:
            kept.append(block)
    return '\n'.join(kept)

# ---------------------------------------------------------------------------
# JS helpers
# ---------------------------------------------------------------------------

def find_matching_close(text, open_pos):
    """
    Given text and the index of an opening '{', return the index of
    the matching closing '}'. Returns -1 if not found.
    """
    depth = 1
    i = open_pos + 1
    while i < len(text):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1

def remove_js_function(text, func_name):
    """
    Remove a named function definition (including any immediately
    preceding block comment or // comment lines) from JS text.
    Returns the modified text.
    """
    # Pattern: optional leading comment block/lines, then function declaration
    pattern = (
        r'(?:(?:[ \t]*/\*[^*]*\*+(?:[^/*][^*]*\*+)*/|[ \t]*//[^\n]*)\n)*'
        r'[ \t]*function\s+' + re.escape(func_name) + r'\s*\([^)]*\)\s*\{'
    )
    m = re.search(pattern, text)
    if not m:
        return text

    start = m.start()
    # The opening '{' is the last char in the match
    open_brace = m.end() - 1
    close_brace = find_matching_close(text, open_brace)
    if close_brace == -1:
        return text  # unmatched brace — leave unchanged

    end = close_brace + 1
    # Consume trailing newline(s)
    while end < len(text) and text[end] in '\n\r':
        end += 1

    return text[:start] + text[end:]

def remove_js_var(text, var_name):
    """
    Remove a var declaration for var_name from JS text.
    Handles single-line declarations only (the common case here).
    Also removes an immediately preceding // comment line if present.
    """
    pattern = (
        r'(?:[ \t]*//[^\n]*\n)?'           # optional preceding comment
        r'[ \t]*var ' + re.escape(var_name) +
        r'\s*=[^;]*;[ \t]*\n?'
    )
    return re.sub(pattern, '', text)

# Shared JS variables and functions to remove from page scripts
SHARED_VARS = [
    'SITE_URL', 'CONSENT_COOKIE_NAME', 'CONSENT_COOKIE_DAYS',
    'GA_MEASUREMENT_ID', 'ADSENSE_CLIENT', 'analyticsLoaded', 'adsLoaded',
    'copyLinkResetTimer', 'copyEmbedResetTimer', '_modalPrevFocus',
]
SHARED_FUNCS = [
    'escapeHtml', 'shouldDefaultMetric',
    'setCookie', 'getCookie',
    'updateConsentGranted', 'ensureThirdPartyHints',
    'loadAnalytics', 'loadAds', 'loadGoogleServices',
    'setConsentState', 'showCookieBanner', 'hideCookieBanner',
    'openResultsModal', 'closeResultsModal', '_trapModalFocus',
    'initConsentBanner', 'initShareButtons', 'initEmbedSection',
]

def remove_shared_js(js_content):
    """Remove all shared variables and functions from a script block's content."""
    result = js_content

    for var in SHARED_VARS:
        result = remove_js_var(result, var)

    for func in SHARED_FUNCS:
        result = remove_js_function(result, func)

    # Remove the keydown event listener registration
    result = re.sub(
        r'[ \t]*document\.addEventListener\([\'"]keydown[\'"]\s*,\s*_trapModalFocus\s*\);[ \t]*\n?',
        '',
        result,
    )

    # Collapse 3+ consecutive blank lines to 2
    result = re.sub(r'\n{3,}', '\n\n', result)

    return result

# ---------------------------------------------------------------------------
# Cookie banner helpers
# ---------------------------------------------------------------------------

def replace_cookie_banner(html):
    """
    Replace any existing cookie-banner div block with the canonical form.
    Matches from <div class="cookie-banner"... to its final </div>.
    """
    # Match the outermost cookie-banner div
    pattern = r'<div[^>]*\bid=["\']cookieBanner["\'][^>]*>.*?</div>\s*(?=\n)'
    m = re.search(pattern, html, re.DOTALL | re.IGNORECASE)
    if m:
        return html[:m.start()] + CANONICAL_BANNER + '\n' + html[m.end():]
    return html

# ---------------------------------------------------------------------------
# Main per-file processing
# ---------------------------------------------------------------------------

LINK_PATTERN = re.compile(r'<link rel="stylesheet" href="site-header\.css\?v=\d+">')
INJECT_CSS = '<!-- INJECT:site-header.css -->\n<!-- INJECT:site-base.css -->'

SCRIPT_SRC_PATTERN = re.compile(r'<script src="site-header\.js\?v=\d+"></script>')
INJECT_HEADER_JS = '<!-- INJECT:site-header.js:script -->'
INJECT_UTILS_JS = '<!-- INJECT:site-utils.js:script -->'


def find_main_script_start(html):
    """
    Return the index of the '<script>' tag that contains the main page JS
    (the one just before the site-header.js script tag).
    Returns -1 if not found.
    """
    # Look for <script> followed (eventually) by site-header.js or its inject replacement
    # Strategy: find the last <script> that is NOT an attribute-less inline <script> in <head>
    # and NOT the <script src="site-header.js">
    #
    # Reliable approach: find </script> immediately before the site-header.js tag / inject
    markers = [
        r'</script>\s*\n<script src="site-header\.js\?v=\d+">',
        r'</script>\s*\n<!-- INJECT:site-header\.js:script -->',
    ]
    for marker in markers:
        m = re.search(marker, html)
        if m:
            # The </script> is at the start of m.match
            close_tag_end = html.index('</script>', m.start()) + len('</script>')
            # Now find the matching <script> open tag before this </script>
            # Walk backwards looking for <script>
            pos = m.start()
            while pos >= 0:
                idx = html.rfind('<script>', 0, pos)
                if idx == -1:
                    break
                # Make sure this <script> tag is the one that opens the block
                # ending at the </script> we found
                # Simple check: no other </script> between idx and m.start()
                between = html[idx + len('<script>'):m.start()]
                if '</script>' not in between:
                    return idx
                pos = idx
    return -1


def find_main_script_block(html):
    """
    Return (start, end) character positions of the main page script block
    — the one that contains the page JS and comes just before the
    <!-- INJECT:site-header.js:script --> placeholder (or the old
    <script src="site-header.js"> tag).
    Returns (-1, -1) if not found.
    """
    idx = find_main_script_start(html)
    if idx == -1:
        return (-1, -1)
    # Find the </script> that closes this block
    close = html.find('</script>', idx)
    if close == -1:
        return (-1, -1)
    return (idx, close + len('</script>'))


def add_utils_inject(html):
    """Insert INJECT:site-utils.js:script before the main <script> block."""
    if INJECT_UTILS_JS in html:
        return html  # already present
    idx = find_main_script_start(html)
    if idx == -1:
        return html
    return html[:idx] + INJECT_UTILS_JS + '\n' + html[idx:]


def process_file(filepath, shared_selectors, add_utils=True, fix_banner=False, is_tools=False, is_rib=False):
    with open(filepath, 'r', encoding='utf-8') as f:
        html = f.read()

    filename = os.path.basename(filepath)
    changes = []

    # 1. Replace <link rel="stylesheet"> tag
    if LINK_PATTERN.search(html):
        html = LINK_PATTERN.sub(INJECT_CSS, html)
        changes.append('CSS link -> inject placeholders')

    # 2. Filter shared CSS from <style> block
    style_m = re.search(r'<style>(.*?)</style>', html, re.DOTALL)
    if style_m:
        original_css = style_m.group(1)
        filtered = filter_style_block(original_css, shared_selectors)
        if filtered.strip():
            new_style = '<style>\n' + filtered + '\n</style>'
        else:
            new_style = '<style></style>'
        html = html[:style_m.start()] + new_style + html[style_m.end():]
        removed = len(original_css) - len(filtered)
        changes.append(f'CSS filtered (~{removed} chars removed)')

    # 3. Replace <script src="site-header.js"> tag
    if SCRIPT_SRC_PATTERN.search(html):
        html = SCRIPT_SRC_PATTERN.sub(INJECT_HEADER_JS, html)
        changes.append('site-header.js tag -> inject placeholder')

    if not add_utils:
        # Simple pages: done after the three steps above
        _write(filepath, html)
        print(f'  {filename}: {"; ".join(changes)}')
        return

    # 4. Fix cookie banner if needed
    if fix_banner:
        old_len = len(html)
        html = replace_cookie_banner(html)
        if len(html) != old_len:
            changes.append('cookie banner normalised')

    # 5. tools.html special: replace entire main <script> block content
    if is_tools:
        # Replace the main <script>...</script> block (the one before site-header.js inject)
        s_start, s_end = find_main_script_block(html)
        if s_start != -1:
            html = html[:s_start] + '<script>\n(function(){ initConsentBanner(); })();\n</script>' + html[s_end:]
            changes.append('tools.html script block -> minimal init call')

    # 5b. rib-calculator.html special: remove custom cookie + analytics code, replace calls
    elif is_rib:
        # Fix cookie banner button variable references
        html = re.sub(r'[ \t]*var cookieAccept\s*=\s*document\.getElementById\([^\)]+\);\n', '', html)
        html = re.sub(r'[ \t]*var cookieReject\s*=\s*document\.getElementById\([^\)]+\);\n', '', html)
        # Remove custom setCookie and initCookieBanner from main script block
        s_start, s_end = find_main_script_block(html)
        if s_start != -1:
            sc = html[s_start + len('<script>'):s_end - len('</script>')]
            sc = remove_js_function(sc, 'setCookie')
            sc = remove_js_function(sc, 'initCookieBanner')
            # Remove custom event listeners for old button IDs
            sc = re.sub(
                r'[ \t]*cookieAccept\.addEventListener\b.*?\}\);\n',
                '',
                sc, flags=re.DOTALL,
            )
            sc = re.sub(
                r'[ \t]*cookieReject\.addEventListener\b.*?\}\);\n',
                '',
                sc, flags=re.DOTALL,
            )
            # Replace initCookieBanner() call with initConsentBanner()
            sc = re.sub(r'\binitCookieBanner\b\s*\(\s*\)\s*;', 'initConsentBanner();', sc)
            # Remove any standalone loadAnalytics() call (consent banner handles it)
            sc = re.sub(r'[ \t]*loadAnalytics\(\);\n', '', sc)
            # Remove inline analytics detection block if present
            sc = re.sub(
                r'\s*/\* ---- Analytics[^*]*\*/.*?window\._gtagLoaded = true;\s*\n\s*break;\s*\n\s*\}\s*\n\s*\}\s*\n',
                '\n',
                sc, flags=re.DOTALL,
            )
            sc = re.sub(r'\n{3,}', '\n\n', sc)
            html = html[:s_start] + '<script>' + sc + '</script>' + html[s_end:]
        changes.append('rib-calculator custom cookie/analytics code removed')

    # 6. Remove shared JS from main <script> block (for standard pages)
    elif not is_tools:
        s_start, s_end = find_main_script_block(html)
        if s_start != -1:
            sc = html[s_start + len('<script>'):s_end - len('</script>')]
            original_len = len(sc)
            sc = remove_shared_js(sc)
            html = html[:s_start] + '<script>' + sc + '</script>' + html[s_end:]
            removed = original_len - len(sc)
            changes.append(f'shared JS removed (~{removed} chars)')

    # 7. Add <!-- INJECT:site-utils.js:script --> before main <script> block
    html = add_utils_inject(html)
    if INJECT_UTILS_JS in html:
        changes.append('site-utils.js inject added')

    _write(filepath, html)
    print(f'  {filename}: {"; ".join(changes) if changes else "no changes"}')


def _write(filepath, html):
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(html)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    shared_selectors = load_shared_selectors()
    print(f'Loaded {len(shared_selectors)} shared CSS selectors from site-base.css')

    html_files = sorted(
        f for f in os.listdir(SRC) if f.endswith('.html')
    )

    print(f'\nProcessing {len(html_files)} HTML files in {SRC}/...\n')

    for filename in html_files:
        filepath = os.path.join(SRC, filename)

        if filename in SKIP_PAGES:
            print(f'  {filename}: SKIPPED')
            continue

        is_simple = filename in SIMPLE_PAGES
        is_tools = filename == 'tools.html'
        is_rib = filename == 'rib-calculator.html'

        # Pages that need cookie banner normalisation:
        # tools.html and rib-calculator.html
        fix_banner = is_tools or is_rib

        process_file(
            filepath,
            shared_selectors,
            add_utils=not is_simple,
            fix_banner=fix_banner,
            is_tools=is_tools,
            is_rib=is_rib,
        )

    print('\nDone.')


if __name__ == '__main__':
    main()
