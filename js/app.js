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
    refreshShareState();
  }

  /* ---------------- clipboard + download (steps 1 & 4) ------------ */
  var SHARE_MAX_CHARS = 50000; // §4: keep share links practical (~50 KB cap)

  function groupNum(n) { return n.toLocaleString('en-US'); }

  /** execCommand fallback for file:// and other non-secure contexts,
      where navigator.clipboard may be undefined (step 4). */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      if (legacyCopy(text)) resolve(); else reject(new Error('no clipboard API'));
    });
  }

  function doCopy() {
    var text = output.textContent;
    if (!text) { setStatus('warn', 'Nothing to copy yet — run Validate, Format or Fix first.'); return; }
    copyText(text).then(function () {
      setStatus('ok', 'Copied to clipboard (' + groupNum(byteSize(text)) + ' bytes).');
    }, function () {
      setStatus('error', 'Copy failed in this browser — select the output pane and use Ctrl/Cmd+C.');
    });
  }

  function doDownload() {
    var text = output.textContent;
    if (!text) { setStatus('warn', 'Nothing to download yet — run Validate, Format or Fix first.'); return; }
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
      setStatus('ok', 'Downloaded json-formatted.json (' + groupNum(byteSize(text)) + ' bytes).');
    } catch (e) {
      setStatus('error', 'Download failed: ' + e.message);
    }
  }

  /* ---------------- share (step 4) ----------------
     The URL IS the transport: ?json=<percent-encoded text>. Base = href
     minus any query/hash, so it works from file:// without URL parsing. */
  function buildShareUrl(text) {
    return window.location.href.split(/[?#]/)[0] + '?json=' + encodeURIComponent(text);
  }

  function parseSharedJson() {
    try {
      var shared = new URLSearchParams(window.location.search).get('json');
      if (shared == null) return null;
      return decodeURIComponent(shared);
    } catch (e) {
      return null; // malformed ?json= → treat as absent, don't crash startup
    }
  }

  function doShare() {
    var t = input.value;
    if (!t.trim()) { setStatus('warn', 'Paste some JSON first — Share copies a link that opens this page with it prefilled.'); return; }
    if (t.length > SHARE_MAX_CHARS) {
      setStatus('error', 'Too big for a share link: ' + groupNum(t.length) + ' chars (limit ' + groupNum(SHARE_MAX_CHARS) + '). Copy or download the JSON instead.');
      return;
    }
    var url = buildShareUrl(t);
    function done() {
      setStatus('ok', 'Share link copied — it opens this page with your JSON prefilled. The JSON travels in the URL, so don\'t share secrets.');
    }
    function failed() {
      window.prompt('Copy this share link (it contains your JSON):', url);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () {
        if (legacyCopy(url)) done(); else failed();
      });
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