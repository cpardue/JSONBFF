/* ============================================================
   JSON BFF — app.js (UI wiring)
   Plain <script> (no ES modules) so the site works from file://
   and from any static host (JSONBFF-PLAN.md §2).

   Every button and shortcut is wired. The core actions delegate to:
     window.JSONBFFFormat  ← js/formatter.js
     window.JSONBFFFix     ← js/fixer.js
   Expected API contract:
     JSONBFFFormat.validate(text)          → { ok, message }
     JSONBFFFormat.format(text, indent)    → { ok, output?, message }
     JSONBFFFormat.compact(text)           → { ok, output?, message }
     JSONBFFFix.fix(text, indent?)         → { ok, output?, message, changes?: [{pass, count}] }
   `message` is a ready-to-show status string; `indent` is 2 | 4 | "\t".
   If a core script fails to load, its buttons report that the file
   is missing.
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var input = $('json-input');
  var output = $('json-output');
  var statusBar = $('status-bar');
  var indentSelect = $('indent-select');

  if (!input || !output || !statusBar || !indentSelect) return; // DOM not as expected

  var DEFAULT_STATUS = 'Paste JSON on the left — it stays in your browser, nothing is uploaded.';

  /* ---------------- status bar ---------------- */
  function setStatus(kind, message) {
    statusBar.className = 'status status--' + kind;
    statusBar.textContent = message;
  }

  function byteSize(str) {
    try { return new Blob([str]).size; }
    catch (e) { return str.length; } // fallback: character count
  }

  function currentIndent() {
    var v = indentSelect.value;
    return v === 'tab' ? '\t' : parseInt(v, 10);
  }

  /* ---------------- capability checks (steps 2–3) ---------------- */
  function formatAvailable() {
    return !!(window.JSONBFFFormat && typeof window.JSONBFFFormat.format === 'function');
  }
  function fixAvailable() {
    return !!(window.JSONBFFFix && typeof window.JSONBFFFix.fix === 'function');
  }

  /* ---------------- core actions ---------------- */
  function doValidate() {
    if (!input.value.trim()) { setStatus('warn', 'Nothing to validate yet — paste JSON first.'); return; }
    if (!formatAvailable()) { setStatus('warn', 'Validate is unavailable — js/formatter.js did not load.'); return; }
    var r = window.JSONBFFFormat.validate(input.value);
    setStatus(r.ok ? 'ok' : 'error', r.message);
  }

  function doFormat() {
    if (!input.value.trim()) { setStatus('warn', 'Nothing to format yet — paste JSON first.'); return; }
    if (!formatAvailable()) { setStatus('warn', 'Format is unavailable — js/formatter.js did not load.'); return; }
    var r = window.JSONBFFFormat.format(input.value, currentIndent());
    if (r.ok && typeof r.output === 'string') output.textContent = r.output; // never clobber with garbage
    setStatus(r.ok ? 'ok' : 'error', r.ok ? r.message : r.message + ' Tip: try Fix.');
  }

  function doFix() {
    if (!input.value.trim()) { setStatus('warn', 'Nothing to fix yet — paste JSON first.'); return; }
    if (!fixAvailable()) { setStatus('warn', 'Fix is unavailable — js/fixer.js did not load.'); return; }
    var r = window.JSONBFFFix.fix(input.value, currentIndent());
    if (r && typeof r.output === 'string' && r.output) output.textContent = r.output; // best-effort kept visible
    setStatus(r.ok ? 'ok' : 'error', r.message);
  }

  function doCompact() {
    if (!input.value.trim()) { setStatus('warn', 'Nothing to compact yet — paste JSON first.'); return; }
    if (!formatAvailable()) { setStatus('warn', 'Compact is unavailable — js/formatter.js did not load.'); return; }
    var r = window.JSONBFFFormat.compact(input.value);
    if (r.ok && typeof r.output === 'string') output.textContent = r.output;
    setStatus(r.ok ? 'ok' : 'error', r.message);
  }

  function doClear() {
    input.value = '';
    output.textContent = '';
    setStatus('info', DEFAULT_STATUS);
    input.focus();
  }

  /* ---------------- output actions ---------------- */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function doCopy() {
    var text = output.textContent;
    if (!text) { setStatus('warn', 'Nothing to copy yet — run Format, Fix or Compact first.'); return; }
    var done = function () { setStatus('ok', 'Copied ' + byteSize(text) + ' bytes to the clipboard.'); };
    var failed = function () { setStatus('error', 'Copy failed — select the output text and press Ctrl+C.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (legacyCopy(text)) done(); else failed();
      });
    } else {
      if (legacyCopy(text)) done(); else failed();
    }
  }

  function doDownload() {
    var text = output.textContent;
    if (!text) { setStatus('warn', 'Nothing to download yet — run Format, Fix or Compact first.'); return; }
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'json-formatted.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      setStatus('ok', 'Downloaded json-formatted.json (' + byteSize(text) + ' bytes).');
    } catch (e) {
      setStatus('error', 'Download failed: ' + e.message);
    }
  }

  /* ---------------- share link (step 4: §4 global behaviors) ------------
     Share copies `?json=<URL-encoded input>`; on load, that param prefills
     the input and auto-runs Format (Fix if it fails). ~50 KB cap: above it
     the button disables with a tooltip saying why. Only URLs are capped —
     pasting/copying/downloading big JSON stays unlimited. */
  var SHARE_MAX_CHARS = 50000;

  function groupNum(n) { return n.toLocaleString('en-US'); }

  function parseSharedJson() {
    try {
      if (typeof URLSearchParams !== 'function' || !window.location) return null;
      var v = new URLSearchParams(window.location.search).get('json');
      return (typeof v === 'string' && v.length) ? v : null;
    } catch (e) { return null; }
  }

  function buildShareUrl(text) {
    // Current page minus any existing query/hash, plus ?json= — works from
    // file:// and https without relying on URL-parsing edge cases.
    var base = String(window.location.href).split(/[?#]/)[0];
    return base + '?json=' + encodeURIComponent(text);
  }

  function doShare() {
    var text = input.value;
    if (!text.trim()) { setStatus('warn', 'Nothing to share yet — paste JSON first.'); return; }
    if (text.length > SHARE_MAX_CHARS) {
      setStatus('warn', 'Input is ' + groupNum(text.length) + ' chars — over the ~50 KB share-link limit, so sharing is disabled. Copy the output instead.');
      return; // unreachable via the button (disabled), but keep the API honest
    }
    var url = buildShareUrl(text);
    var done = function () {
      setStatus('ok', 'Share link copied — opening it prefills this JSON and auto-formats (' + groupNum(url.length) + ' char URL).');
    };
    var failed = function () {
      // Clipboard blocked (e.g. file:// without permission): hand the link
      // over via a prompt instead of losing it.
      setStatus('warn', 'Clipboard unavailable — copy the share link from the dialog below.');
      try { window.prompt('Share link (select all, then Ctrl+C):', url); } catch (e) { /* ignore */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, failed);
    } else {
      if (legacyCopy(url)) done(); else failed();
    }
  }

  /* Live Share-button state: disabled + tooltip explains why (§10 step 4). */
  function refreshShareState() {
    var shareBtn = $('btn-share');
    if (!shareBtn) return;
    var t = input.value;
    if (!t.trim()) {
      shareBtn.disabled = true;
      shareBtn.title = 'Paste some JSON first — Share copies a link that opens this page with it prefilled.';
    } else if (t.length > SHARE_MAX_CHARS) {
      shareBtn.disabled = true;
      shareBtn.title = 'Too big for a share link: ' + groupNum(t.length) + ' chars (limit ' + groupNum(SHARE_MAX_CHARS) + '). Copy or download the JSON instead.';
    } else {
      shareBtn.disabled = false;
      shareBtn.title = 'Copy a link that opens this page with your JSON prefilled';
    }
  }

  /* ---------------- wiring ---------------- */
  function on(id, fn) {
    var el = $(id);
    if (el) el.addEventListener('click', fn);
  }
  on('btn-validate', doValidate);
  on('btn-format', doFormat);
  on('btn-fix', doFix);
  on('btn-compact', doCompact);
  on('btn-clear', doClear);
  on('btn-copy', doCopy);
  on('btn-download', doDownload);
  on('btn-share', doShare);

  /* Ctrl/Cmd+Enter = Format (JSONBFF-PLAN.md §4) */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doFormat();
    }
  });

  /* Re-run Format when the indent changes (once the formatter exists, step 2+) */
  indentSelect.addEventListener('change', function () {
    if (formatAvailable() && output.textContent && input.value.trim()) doFormat();
  });

  input.addEventListener('input', refreshShareState); // keep Share state honest as the user types

  /* Prefilled broken sample (step 4): demos the Fix pipeline on first visit
     when no ?json= param is present. Every defect here is one of the
     fixer's passes, so a single click of Fix repairs it fully. */
  var SAMPLE_BROKEN = [
    '// API response — trailing commas + a JS literal slipped in',
    '{',
    "  'name': 'orders-batch',",
    '  "count": 3,',
    '  "items": [',
    '    { "id": 1, "status": \'ok\' },',
    '    { "id": 2, "status": NaN },   // ← not valid JSON',
    '    { "id": 3, "status": null }',
    '  ],',
    '}'
  ].join('\n');

  /** Startup (step 4): ?json= param → prefill + auto Format (Fix if it
      fails, §4); no param → broken sample prefilled with a Fix nudge. */
  function startup() {
    var shared = parseSharedJson();
    if (shared != null) {
      input.value = shared;
      if (formatAvailable()) {
        var r = window.JSONBFFFormat.format(shared, currentIndent());
        if (r.ok) {
          if (typeof r.output === 'string') output.textContent = r.output;
          setStatus('ok', 'Loaded from share link — ' + r.message);
        } else if (fixAvailable()) {
          doFix();
        } else {
          setStatus('error', r.message);
        }
      } else {
        doValidate(); // formatter missing → degrade to a validation report
      }
    } else if (!input.value.trim()) {
      input.value = SAMPLE_BROKEN;
      if (formatAvailable()) {
        var v = window.JSONBFFFormat.validate(input.value);
        setStatus(v.ok ? 'ok' : 'error', v.ok ? v.message : v.message + ' Press Fix to repair it.');
      }
    }
    refreshShareState();
  }

  startup();
})();
