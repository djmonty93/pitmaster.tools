// Canonical HTML escaper for the Node build scripts (CommonJS).
// Single source for build.js and scripts/generate-metros.js, which
// previously carried byte-identical copies. Escapes the five
// HTML-significant characters for safe interpolation into markup.
'use strict';

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
};

function escapeHtml(s) {
  return String(s).replace(HTML_ESCAPE_RE, function (c) { return HTML_ESCAPE_MAP[c]; });
}

module.exports = { escapeHtml };
