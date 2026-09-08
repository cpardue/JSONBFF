#!/usr/bin/env node
/* ============================================================
   JSON BFF — test runner (plain Node, zero dependencies)

   JSONBFF-PLAN.md §5.4: reads every file in fixtures/; each fixture is
   { "name", "input", "expected"?, "expectOk"?, "expectNoChanges"? }.
   `input` may contain invalid JSON — it's just a string field.

   Run: node js/tests/run-tests.js   (exit 0 = all green)

   Checks per fixture:
     expectOk false (default true) → fix() must fail cleanly (ok:false,
       real message, no throw).
     expectOk true → fix() ok; JSON.parse(output) isDeepStrictEqual to
       `expected`; re-fixing the output must report 0 changes (§4 — Fix
       is idempotent); expectNoChanges additionally requires the first
       fix to report 0 changes (valid input, §5.3 hard rule).

   The runner loads js/fixer.js with fs + vm exactly like a browser
   classic <script> would execute it (JSONBFF-PLAN.md §2) — no
   packaging layer, ever.
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var util = require('util');

function loadFixer() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'fixer.js'), 'utf8');
  var sandbox = { console: console };
  sandbox.window = sandbox; // classic-script global target
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'fixer.js' });
  if (!sandbox.JSONBFFFix || typeof sandbox.JSONBFFFix.fix !== 'function') {
    throw new Error('fixer.js did not expose JSONBFFFix.fix');
  }
  return sandbox.JSONBFFFix;
}

function sumEdits(r) {
  var n = 0;
  var changes = (r && r.changes) || [];
  for (var i = 0; i < changes.length; i++) n += changes[i].count;
  return n;
}

var fixer = loadFixer();
var dir = path.join(__dirname, 'fixtures');
var files = fs.readdirSync(dir).filter(function (f) { return /\.json$/.test(f); }).sort();
if (!files.length) { console.error('no fixtures found in ' + dir); process.exit(1); }

var total = 0;
var failed = 0;
var pending = []; // async work that must settle before the summary prints
var finished = false; // guard: finish() may be called from multiple sections

files.forEach(function (file) {
  var problems = [];
  var fx;
  try {
    fx = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    total++; failed++;
    console.log('FAIL ' + file + '\n     - fixture itself is not valid JSON: ' + err.message);
    return;
  }
  var label = fx.name || file;
  total++;

  if (typeof fx.input !== 'string') {
    problems.push('fixture has no string "input" field');
  } else if (fx.expectOk === false) {
    var r;
    try {
      r = fixer.fix(fx.input, 2);
    } catch (err) {
      problems.push('fix() threw on input expected to fail: ' + err.message);
    }
    if (r !== undefined && !(r.ok === false && typeof r.message === 'string' && r.message)) {
      problems.push('expected clean failure (ok:false + message), got ok=' + JSON.stringify(r && r.ok) +
                    ' message=' + JSON.stringify(r && r.message));
    }
  } else if (fx.expected !== undefined) {
    var ok;
    try {
      ok = fixer.fix(fx.input, 2);
    } catch (err) {
      problems.push('fix() threw: ' + err.stack);
    }
    if (ok !== undefined) {
      if (ok.ok !== true) {
        problems.push('expected ok:true, got ok:false — ' + JSON.stringify(ok.message));
      } else {
        var actual;
        try {
          actual = JSON.parse(ok.output);
        } catch (err) {
          problems.push('output is not valid JSON: ' + err.message);
        }
        if (actual !== undefined && !util.isDeepStrictEqual(actual, fx.expected)) {
          problems.push('value mismatch\n         expected: ' + JSON.stringify(fx.expected) +
                        '\n         actual:   ' + JSON.stringify(actual));
        }
        if (fx.expectNoChanges && sumEdits(ok) !== 0) {
          problems.push('expected 0 changes on valid input, got ' + sumEdits(ok) + ' edits: ' +
                        JSON.stringify(ok.changes));
        }
        var again;
        try {
          again = fixer.fix(ok.output, 2); // idempotency (§4)
        } catch (err) {
          problems.push('re-fix threw: ' + err.message);
        }
        if (again !== undefined && (again.ok !== true || sumEdits(again) !== 0)) {
          problems.push('not idempotent on its own output (ok=' + JSON.stringify(again && again.ok) +
                        ', edits=' + (again ? sumEdits(again) : '?') + ')');
        }
      }
    }
  } else {
    problems.push('ok fixture has no "expected" value to compare against');
  }

  if (problems.length) {
    failed++;
    console.log('FAIL ' + label + '\n     - ' + problems.join('\n     - '));
  } else {
    console.log('ok   ' + label);
  }
});

/* ---------------- app.js smoke checks (step 4 — UX polish) --------------
   A minimal fake DOM (getElementById stubs + location/clipboard mocks) lets
   app.js run under vm like a browser classic <script>, covering the step-4
   behaviors without a browser: broken-sample prefill, ?json= prefill with
   auto Format/Fix (§4), share-URL round-trip, ~50 KB Share disable +
   tooltip, and Ctrl+Enter = Format. */

function buildAppEnv(search) {
  var els = {};
  var docListeners = [];
  var copied = [];
  function makeEl(id, extra) {
    var el = {
      value: '', textContent: '', className: '', title: '', disabled: false, _ls: {},
      addEventListener: function (t, fn) { el._ls[t] = fn; },
      focus: function () {}
    };
    if (extra) { for (var k in extra) el[k] = extra[k]; }
    els[id] = el;
  }
  makeEl('json-input');
  makeEl('json-output');
  makeEl('status-bar');
  makeEl('indent-select', { value: '2' });
  ['btn-validate', 'btn-format', 'btn-fix', 'btn-compact', 'btn-clear', 'btn-copy', 'btn-download', 'btn-share'].forEach(makeEl);

  var sandbox = { console: console };
  sandbox.window = sandbox;
  sandbox.location = { href: 'https://example.com/JSONBFF/index.html' + search, search: search };
  sandbox.navigator = { clipboard: { writeText: function (t) { copied.push(t); return Promise.resolve(); } } };
  sandbox.URLSearchParams = URLSearchParams; // not a vm-context builtin under Node
  sandbox.document = {
    getElementById: function (id) { return els[id] || null; },
    addEventListener: function (t, fn) { docListeners.push([t, fn]); }
  };
  vm.createContext(sandbox);
  ['formatter.js', 'fixer.js', 'app.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  });
  return { els: els, docListeners: docListeners, copied: copied };
}

function click(env, id) { var h = env.els[id]._ls.click; if (h) h(); }

(function appChecks() {
  var check = function (label, cond, detail) {
    total++;
    if (cond) console.log('ok   ' + label);
    else { failed++; console.log('FAIL ' + label + (detail ? '\n     - ' + detail : '')); }
  };

  // A. No ?json= → broken sample prefilled; one click of Fix repairs it.
  var envA;
  try { envA = buildAppEnv(''); }
  catch (err) { check('app: loads without ?json=', false, err.message); finish(); return; }
  if (typeof envA.els['json-input']._ls.input !== 'function') {
    check('app: Share state wired to input events', false, 'no input listener on #json-input');
    finish();
    return;
  }
  check('app: broken sample prefilled with Fix nudge',
    envA.els['json-input'].value.length > 0 && /NaN/.test(envA.els['json-input'].value) &&
    /Press Fix to repair it\./.test(envA.els['status-bar'].textContent || ''),
    JSON.stringify(envA.els['status-bar'].textContent));
  click(envA, 'btn-fix');
  var fixedA = null;
  try { fixedA = JSON.parse(envA.els['json-output'].textContent || 'null'); } catch (e) { /* counted below */ }
  check('app: Fix on the sample produces valid output',
    !!fixedA && fixedA.name === 'orders-batch' && fixedA.count === 3 &&
    Array.isArray(fixedA.items) && fixedA.items.length === 3 &&
    fixedA.items[0].status === 'ok' && fixedA.items[1].status === null &&
    /status--ok/.test(envA.els['status-bar'].className || '') && /Fixed/.test(envA.els['status-bar'].textContent || ''),
    JSON.stringify(envA.els['status-bar'].textContent));
  check('app: Share enabled for small input',
    envA.els['btn-share'].disabled === false && /prefilled/.test(envA.els['btn-share'].title || ''),
    JSON.stringify(envA.els['btn-share'].title));
  // B. ?json= with valid JSON → prefilled + auto-formatted on load (§4).
  var validJson = '{"a":1,"b":[2,3]}';
  var envB;
  try { envB = buildAppEnv('?json=' + encodeURIComponent(validJson)); }
  catch (err) { check('app: loads with ?json=', false, err.message); finish(); return; }
  check('app: share param prefills input',
    envB.els['json-input'].value === validJson, JSON.stringify(envB.els['json-input'].value));
  check('app: shared valid JSON auto-formatted on load',
    envB.els['json-output'].textContent === JSON.stringify(JSON.parse(validJson), null, 2) &&
    /share link/i.test(envB.els['status-bar'].textContent || ''),
    JSON.stringify(envB.els['status-bar'].textContent));

  // C. ?json= with broken JSON → auto-runs Fix on load (§4).
  var envC;
  try { envC = buildAppEnv('?json=' + encodeURIComponent("{'a': 1,}")); }
  catch (err) { check('app: loads with broken ?json=', false, err.message); finish(); return; }
  var fixedC = null;
  try { fixedC = JSON.parse(envC.els['json-output'].textContent || 'null'); } catch (e) { /* counted below */ }
  check('app: shared broken JSON auto-fixed on load',
    !!fixedC && fixedC.a === 1 && /Fixed/.test(envC.els['status-bar'].textContent || ''),
    JSON.stringify(envC.els['status-bar'].textContent));

  // D. Ctrl/Cmd+Enter = Format on the current input (§4).
  var kd = null;
  envB.docListeners.forEach(function (p) { if (p[0] === 'keydown') kd = p[1]; });
  if (typeof kd === 'function') {
    envB.els['json-input'].value = '{ "x" : 5 }';
    kd({ key: 'Enter', ctrlKey: true, metaKey: false, preventDefault: function () {} });
    check('app: Ctrl+Enter runs Format',
      envB.els['json-output'].textContent === JSON.stringify({ x: 5 }, null, 2),
      JSON.stringify(envB.els['json-output'].textContent));
  } else {
    check('app: Ctrl+Enter wired to a keydown handler', false, 'no keydown listener registered');
  }

  // E. ~50 KB share cap: disabled + tooltip above the limit; empty → disabled.
  envB.els['json-input'].value = 'x'.repeat(50001);
  envB.els['json-input']._ls.input();
  check('app: Share disabled above ~50 KB with tooltip',
    envB.els['btn-share'].disabled === true && /limit/.test(envB.els['btn-share'].title || ''),
    JSON.stringify(envB.els['btn-share'].title));
  envB.els['json-input'].value = '';
  envB.els['json-input']._ls.input();
  check('app: Share disabled while input empty (tooltip explains)',
    envB.els['btn-share'].disabled === true && /first/i.test(envB.els['btn-share'].title || ''),
    JSON.stringify(envB.els['btn-share'].title));

  // F. Share round-trip: click → clipboard gets the ?json= URL → the param
  //    decodes back to the exact input (async clipboard stub → pending).
  envB.els['json-input'].value = validJson;
  envB.els['json-input']._ls.input();
  click(envB, 'btn-share');
  pending.push(new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
    var url = envB.copied[0] || '';
    var decoded = null;
    try { decoded = new URLSearchParams(url.split('?')[1] || '').get('json'); } catch (e) { /* counted below */ }
    check('app: share URL round-trips through the clipboard',
      url.indexOf('https://example.com/JSONBFF/index.html?json=') === 0 && decoded === validJson &&
      /Share link copied/i.test(envB.els['status-bar'].textContent || ''),
      JSON.stringify({ urlHead: url.slice(0, 60), status: envB.els['status-bar'].textContent }));
  }));
})();

/* ---------------- static pages & links (step 5 — SEO & content) --------
   JSONBFF-PLAN.md §10 step 5 check: "no broken internal links". Every HTML
   page at the repo root must exist, every relative href/src inside them must
   resolve to a real file, robots.txt must allow all crawlers and name a
   sitemap, and every sitemap <loc> must end in a page that exists here. */

(function staticPageChecks() {
  var check = function (label, cond, detail) {
    total++;
    if (cond) console.log('ok   ' + label);
    else { failed++; console.log('FAIL ' + label + (detail ? '\n     - ' + detail : '')); }
  };

  var root = path.join(__dirname, '..', '..'); // repo root (runner lives in js/tests/)
  var pages = ['index.html', 'about.html', 'privacy.html', '404.html'];
  check('static: expected pages exist at repo root',
    pages.every(function (p) { return fs.existsSync(path.join(root, p)); }),
    'missing: ' + pages.filter(function (p) { return !fs.existsSync(path.join(root, p)); }).join(', '));

  // Relative href/src refs must resolve to files on disk. Absolute http(s)/
  // mailto/data and in-page # anchors are skipped (ads, schema.org, etc.).
  var broken = [];
  pages.forEach(function (p) {
    if (!fs.existsSync(path.join(root, p))) return;
    var html = fs.readFileSync(path.join(root, p), 'utf8');
    var re = /(?:href|src)="([^"]+)"/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var ref = m[1];
      if (/^(?:https?:|mailto:|data:|#)/.test(ref)) continue;
      var clean = ref.split(/[?#]/)[0];
      if (!clean) continue;
      var target = path.normalize(path.join(root, decodeURIComponent(clean)));
      var inside = target === root || target.indexOf(root + path.sep) === 0;
      if (!inside || !fs.existsSync(target)) broken.push(p + ' → ' + ref);
    }
  });
  check('static: no broken internal links in HTML pages', broken.length === 0, broken.join('; '));

  // robots.txt: allow all + a Sitemap line (JSONBFF-PLAN.md §7).
  var robotsPath = path.join(root, 'robots.txt');
  var robots = fs.existsSync(robotsPath) ? fs.readFileSync(robotsPath, 'utf8') : '';
  var smMatch = /Sitemap:\s*(\S+)/i.exec(robots);
  check('static: robots.txt allows all crawlers and names a sitemap',
    !!robots && /User-agent:\s*\*/.test(robots) && /Allow:\s*\//.test(robots) && !!smMatch,
    'robots.txt: ' + JSON.stringify(robots.slice(0, 160)));
  if (smMatch) {
    var smFile = smMatch[1].replace(/^https?:\/\/[^/]+\/?/, '').split('/').pop();
    check('static: robots.txt sitemap file exists',
      fs.existsSync(path.join(root, smFile)), 'sitemap ref: ' + smMatch[1]);
  }

  // sitemap.xml: every <loc> must end in a page that actually exists.
  var smPath = path.join(root, 'sitemap.xml');
  var sm = fs.existsSync(smPath) ? fs.readFileSync(smPath, 'utf8') : '';
  var locs = [];
  var locRe = /<loc>\s*(\S+?)\s*<\/loc>/g;
  var lm;
  while ((lm = locRe.exec(sm)) !== null) locs.push(lm[1]);
  var badLocs = locs.filter(function (u) {
    var base = u.split('/').pop();
    return pages.indexOf(base) === -1;
  });
  check('static: sitemap.xml lists only existing pages',
    locs.length >= 3 && badLocs.length === 0,
    'locs=' + JSON.stringify(locs) + ' unknown=' + JSON.stringify(badLocs));

  // .nojekyll → GitHub Pages serves files as-is (JSONBFF-PLAN.md §2).
  check('static: .nojekyll present for GitHub Pages', fs.existsSync(path.join(root, '.nojekyll')));

  finish();
})();

/* ---------------- webmcp.js smoke checks (JSONBFF-PLAN.md §12) --------
   Emulates a WebMCP-capable host: a fake document.modelContext captures
   registered tools, then each tool's execute() is invoked the way an
   agent would. Also verifies the module stays a silent no-op when the
   API is absent (Firefox/Safari/file:// → §11 zero-console-errors). */

function buildWebMcpEnv() {
  var registered = [];
  var sandbox = { console: console };
  sandbox.window = sandbox;
  sandbox.document = {
    modelContext: {
      registerTool: function (def) { registered.push(def); return Promise.resolve({ name: def.name }); }
    }
  };
  vm.createContext(sandbox);
  ['formatter.js', 'fixer.js', 'webmcp.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  });
  return registered;
}

function finish() {
  if (finished) return;
  finished = true;
  var settle = function () {
    console.log('\n' + (total - failed) + '/' + total + ' checks passed');
    process.exit(failed ? 1 : 0);
  };
  if (!pending.length) return settle();
  Promise.all(pending).then(settle).catch(function (err) {
    total++; failed++;
    console.log('FAIL async work settled\n     - ' + String((err && err.stack) || err));
    settle();
  });
}

(function webMcpChecks() {
  var check = function (label, cond, detail) {
    total++;
    if (cond) console.log('ok   ' + label);
    else { failed++; console.log('FAIL ' + label + (detail ? '\n     - ' + detail : '')); }
  };

  // Silent no-op when the API is absent.
  try {
    var bare = { console: console };
    bare.window = bare;
    vm.createContext(bare);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'webmcp.js'), 'utf8'), bare, { filename: 'webmcp.js' });
    check('webmcp: silent no-op without document.modelContext', true);
  } catch (err) {
    check('webmcp: silent no-op without document.modelContext', false, 'threw: ' + err.message);
  }

  var registered;
  try {
    registered = buildWebMcpEnv();
  } catch (err) {
    check('webmcp: loads with document.modelContext present', false, err.message);
    finish();
    return;
  }

  var byName = {};
  registered.forEach(function (d) { byName[d.name] = d; });
  var expectedNames = ['json_validate', 'json_format', 'json_compact', 'json_fix'];
  check('webmcp: 4 tools registered with valid definitions',
    registered.length === expectedNames.length &&
    expectedNames.every(function (n) {
      var t = byName[n];
      return !!t && typeof t.description === 'string' && t.description.length > 0 &&
        t.inputSchema && t.inputSchema.type === 'object' &&
        Array.isArray(t.inputSchema.required) &&
        typeof t.execute === 'function';
    }),
    'got: ' + JSON.stringify(registered.map(function (d) { return d.name; })));

  if (!expectedNames.every(function (n) { return !!byName[n] && typeof byName[n].execute === 'function'; })) {
    finish(); // can't exercise missing tools
  }

  var results = Promise.all([
    byName.json_validate.execute({ text: '{ "a": 1 }' }),
    byName.json_validate.execute({ text: '{ "a":' }),
    byName.json_format.execute({ text: '{"a":1,"b":[2,3]}' }),
    byName.json_format.execute({ text: '{ "a" : 1 }', indent: 'tab' }),
    byName.json_compact.execute({ text: '{ "a" : 1 , "b" : [ 2 , 3 ] }' }),
    byName.json_fix.execute({ text: "{ 'a': 1,}" }),
    byName.json_fix.execute({ text: 'hello world' }),
    byName.json_validate.execute({ text: 'x'.repeat(50001) })
  ]);

  results.then(function (res) {
    var fixedObj = null;
    try { if (res[5] && res[5].fixed) fixedObj = JSON.parse(res[5].fixed); } catch (e) { /* counted below */ }

    check('webmcp json_validate: valid input',
      !!(res[0] && res[0].valid === true) && /^✓ Valid JSON/.test((res[0] || {}).message || ''), JSON.stringify(res[0]));
    check('webmcp json_validate: broken input',
      !!(res[1] && res[1].valid === false) && /✗ Invalid/.test((res[1] || {}).message || ''), JSON.stringify(res[1]));
    check('webmcp json_format: 2-space default',
      !!(res[2] && res[2].ok === true) && (res[2] || {}).formatted === JSON.stringify({ a: 1, b: [2, 3] }, null, 2), JSON.stringify(res[2]));
    check('webmcp json_format: tab indent',
      !!(res[3] && res[3].ok === true) && ((res[3] || {}).formatted || '').indexOf('\t') !== -1, JSON.stringify(res[3]));
    check('webmcp json_compact',
      !!(res[4] && res[4].ok === true) && (res[4] || {}).compacted === '{"a":1,"b":[2,3]}', JSON.stringify(res[4]));
    check('webmcp json_fix: repairs broken input',
      !!(res[5] && res[5].ok === true) && !!fixedObj && fixedObj.a === 1, JSON.stringify(res[5]));
    check('webmcp json_fix: clean failure on garbage',
      !!(res[6] && res[6].ok === false) && /Could not fully fix/.test((res[6] || {}).message || ''), JSON.stringify(res[6]));
    check('webmcp: input size cap',
      !!(res[7] && res[7].valid === false) && /too large/i.test((res[7] || {}).message || ''), JSON.stringify(res[7]));

    finish();
  }).catch(function (err) {
    check('webmcp execute() calls resolve', false, String((err && err.stack) || err));
    finish();
  });
})();