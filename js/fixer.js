/* ============================================================
   JSON BFF — fixer.js (repair pipeline)

   The core feature (JSONBFF-PLAN.md §5). Pure functions, zero DOM
   access: loads as a classic <script> in the browser and runs
   unmodified under Node (tests load it via fs + vm).

   Exposes: JSONBFFFix = { fix }
   API contract consumed by js/app.js (JSONBFF-PLAN.md §4):
     fix(text, indent?) → { ok, output?, message, changes?: [{pass, count}] }
   - Valid input up front → 0 changes, reformatted output (idempotent).
   - Repair = fixed-order passes (§5.2); JSON.parse is attempted after
     each pass and the pipeline stops at the first success, so no pass
     ever runs on valid input — it cannot change its meaning (§5.3).
     Passes are monotone, so re-rounding until a round changes nothing
     (or parsing succeeds) always terminates.
   - Unrecoverable → ok:false with the remaining parse error plus the
     passes already applied; best-effort text kept in `output` (§5.3).

    Known limitations:
    - A bare apostrophe in prose/comments is treated as
      the start of a single-quoted span (mapStrings supports ' per §5.1).
      Such input degrades to a clear error report — never a silent wrong
      result, since passes only run on already-invalid input.
    - Pass 2 wrapper stripping only recognizes a markdown fence when the
      paste starts with one, and prose containing unbalanced braces/brackets
      is never sliced away (bracket-free-prose rule) — such input fails
      with the plain parse error instead.
    - Missing commas/colons between members are repaired by pass 9
      passDelimiters (JSONBFF-IMPROVEMENTS.md §1.3): one grammar-driven
      left-to-right walk with a (container, role) frame stack. The only
      edits are the three insertions the JSON grammar forces — D1 `,`
      before a next key after a complete value in an object, D2 `:`
      between a key and its value, D3 `,` between array elements; every
      edit is reported. Not repaired (they fail with the clear error
      report, by design — IMPROVEMENTS §1.5): a mid-document bracket
      TYPE mismatch ({"a": [1, 2} "b": 3}); more than one missing token
      per gap ({ 1 2 3 } — at most one insertion per token boundary);
      structural nonsense in the wrong context (colon in an array
      [1, "a": 2], leading commas, missing value before a close
      { "a": , }); unquoted numeric keys ({ 1: 2 } — a number in key
      position is accepted, not quoted; still invalid); ambiguous pastes
      with several balanced containers surrounded by prose — the pass
      declines to edit at all there, since pass 2's leftmost-parseable
      slice would then guess which container is the payload (checklist §0
      no-guess policy).
    - Duplicate separators are collapsed by pass 10
      passDuplicatePunct (checklist §2.4; IMPROVEMENTS §2.2): a `,` or
      `:` whose previous code character outside string spans is the same
      punctuation is removed — runs like `,,` / `::` collapse to one,
      including pairs separated by whitespace or by a comment (pass 3
      strips comments earlier in the round). Valid JSON never places two
      separators in a row, so the edit can only fire on already-invalid
      text (§5.3). The pass carries pass 9's ambiguous-paste no-guess
      guard. Not repaired (they fail with the clear error report): a LONE
      leading comma ([,1]) and mixed sequences ({ "a", : 1 }) — §2.2
      remainder.
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- shared string-aware scanner (§5.1) ----------------
     Spans are [start, end) including delimiters; escape-aware for both
     " and ' delimiters; an unterminated string extends to end-of-text.
     Transforms act only outside spans, so JSON content containing //,
     #, brackets or quotes is never mangled (§5.1, §5.3). */
  function mapStrings(text) {
    var spans = [];
    var i = 0;
    var n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (c === '"' || c === "'") {
        var j = i + 1;
        while (j < n) {
          if (text.charAt(j) === '\\') { j += 2; continue; }
          if (text.charAt(j) === c) break;
          j++;
        }
        var end = (j < n) ? j + 1 : n; // unterminated → to end-of-text
        spans.push([i, end]);
        i = end;
      } else {
        i++;
      }
    }
    return spans;
  }

  /** Apply fn to every non-string region; string spans are copied into
      the result byte-for-byte (§5.1). */
  function transformOutsideSpans(text, spans, fn) {
    var out = '';
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      if (ge > gs) out += fn(text.slice(gs, ge));
      if (k < spans.length) out += text.slice(spans[k][0], spans[k][1]);
    }
    return out;
  }

  function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }

  function isWordChar(c) {
    if (c == null) return false;
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || c === '_' || c === '$';
  }

  /** Parse once. → { ok, value? } or { ok:false, error? }. */
  function attemptParse(text) {
    try { return { ok: true, value: JSON.parse(text) }; }
    catch (err) { return { ok: false, error: err }; }
  }

  /** "<error message> at line L, column C" — regex V8 position/line-col,
      Firefox lineNumber/column props, newline-counting fallback (same
      approach as js/formatter.js; duplicated to keep this file
      self-contained). No duplicate location when the runtime message
      already carries one. */
  function errorDetail(text, err) {
    var msg = (err && err.message) ? String(err.message) : String(err);
    var pos = null, line = null, col = null;
    var lc = /line (\d+) column (\d+)/.exec(msg);
    if (lc) { line = parseInt(lc[1], 10); col = parseInt(lc[2], 10); }
    var p = /at position (\d+)/.exec(msg);
    if (p) pos = parseInt(p[1], 10);
    if (!line && err && Number.isInteger(err.lineNumber)) {
      line = err.lineNumber;
      if (Number.isInteger(err.column)) col = err.column;
    }
    if (pos != null && line == null && text.length) {
      var off = Math.min(pos, text.length);
      line = 1;
      var lineStart = 0;
      for (var i = 0; i < off; i++) {
        if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
      }
      col = off - lineStart + 1;
    }
    if (line != null && col != null && !/line \d+ column \d+/.test(msg)) {
      msg += ' at line ' + line + ', column ' + col;
    }
    return msg;
  }

  /* ---------------- passes (§5.2, fixed order) ----------------
     Each pass: text → { text, changes: [{key, count}] }; a pass reports
     only what it actually changed. */

  /** Pass 1 — Normalize: strip UTF-8 BOM, convert CRLF/CR → LF. */
  function passNormalize(text) {
    var count = 0;
    var t = text;
    if (t.charCodeAt(0) === 0xFEFF) { t = t.slice(1); count++; }
    t = t.replace(/\r\n?/g, function () { count++; return '\n'; });
    return count ? { text: t, changes: [{ key: 'normalize', count: count }] } : { text: text, changes: [] };
  }

  /** Top-level balanced container regions (string-aware depth walk) →
      [ [start, end), … ] left-to-right; a closer below depth 0 resets the
      current region. Shared by pass 2 (prose slicing) and passes 9–10
      (their ambiguous-paste guards must mirror pass 2's slice condition
      exactly — one source of truth for all three). */
  function topLevelRegions(text) {
    var spans = mapStrings(text);
    var regions = [];
    var depth = 0;
    var start = -1;
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var ch = text.charAt(i);
        if (ch === '{' || ch === '[') {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === '}' || ch === ']') {
          depth--;
          if (depth < 0) { depth = 0; start = -1; }
          else if (depth === 0) { regions.push([start, i + 1]); start = -1; }
        }
      }
    }
    return regions;
  }

  /** Is there non-blank text outside every region, and does it contain a
      bracket char? (prefix/gaps/suffix — regions are disjoint, left-to-right) */
  function outsideFlags(text, regions) {
    var nonBlank = false, hasBracket = false;
    var ri = 0;
    for (var p = 0; p < text.length; p++) {
      while (ri < regions.length && p >= regions[ri][1]) ri++;
      var covered = ri < regions.length && p >= regions[ri][0] && p < regions[ri][1];
      if (!covered) {
        var oc = text.charAt(p);
        if (!isWs(oc)) {
          nonBlank = true;
          if (oc === '{' || oc === '}' || oc === '[' || oc === ']') hasBracket = true;
        }
      }
    }
    return { nonBlank: nonBlank, hasBracket: hasBracket };
  }

  /** Pass 2 — Strip paste wrappers (checklist §0): a leading markdown
      code fence (```json … ```, closed or unclosed) and any surrounding
      prose outside the outermost balanced JSON container. Runs only on
      already-invalid text, so valid input is untouched (§5.3).

      Prose-slicing policy (conservative by design — no guessing):
        - slice only when non-blank text surrounds the container region(s)
          AND that outside text holds no { } [ ] characters — a bracket
          outside every balanced region is broken structure, not prose;
        - one balanced region → slice to it; several regions → slice to
          the leftmost region that already parses as strict JSON; none
          parse → no edit and the pipeline fails clean with the parse
          error;
        - a fence is recognized only when the first non-empty line is a
          ``` line (see header limitation).
      Monotone: every edit strictly shrinks the text, so re-rounds see a
      smaller or identical document — no oscillation. */
  function passWrapper(text) {
    var changes = [];
    var t = text;

    // -- fence: first non-empty line is a ``` line → payload is the block
    //    content between it and the next ``` line (or to end-of-text when
    //    the fence was left unclosed).
    var lines = t.split('\n');
    var f = -1;
    for (var li = 0; li < lines.length; li++) {
      if (lines[li].trim() !== '') { f = li; break; }
    }
    if (f !== -1 && lines[f].trim().indexOf('```') === 0) {
      var c = -1;
      for (var lj = f + 1; lj < lines.length; lj++) {
        if (lines[lj].trim().indexOf('```') === 0) { c = lj; break; }
      }
      var inner = lines.slice(f + 1, c === -1 ? lines.length : c).join('\n');
      if (inner.trim() !== '') {
        t = inner;
        changes.push({ key: 'fence', count: 1 });
      }
    }

    // -- prose: outermost balanced container regions (shared walker).
    var regions = topLevelRegions(t);

    var pick = -1;
    if (regions.length) {
      var flags = outsideFlags(t, regions);
      if (flags.nonBlank && !flags.hasBracket) {
        if (regions.length === 1) {
          pick = 0;
        } else {
          for (var r = 0; r < regions.length && pick === -1; r++) {
            try {
              JSON.parse(t.slice(regions[r][0], regions[r][1]));
              pick = r;
            } catch (err) { /* region does not parse — try the next */ }
          }
        }
      }
    }
    if (pick !== -1) {
      t = t.slice(regions[pick][0], regions[pick][1]);
      changes.push({ key: 'prose', count: 1 });
    }

    return changes.length ? { text: t, changes: changes } : { text: text, changes: [] };
  }

  /** Pass 3 — Strip // line comments and /* block comments (outside spans). */
  function passComments(text) {
    var spans = mapStrings(text);
    var count = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      var s = '';
      var i = 0;
      var n = region.length;
      while (i < n) {
        if (region.charAt(i) === '/' && region.charAt(i + 1) === '/') {
          while (i < n && region.charAt(i) !== '\n') i++;
          count++;
          continue;
        }
        if (region.charAt(i) === '/' && region.charAt(i + 1) === '*') {
          i += 2;
          var close = region.indexOf('*/', i);
          i = close === -1 ? n : close + 2;
          s += ' ';
          count++;
          continue;
        }
        s += region.charAt(i++);
      }
      return s;
    });
    return count ? { text: out, changes: [{ key: 'comments', count: count }] } : { text: text, changes: [] };
  }

  /** Pass 4 — Single-quoted spans → double: swap delimiters, escape any
      inner "; \' (escaped apostrophe) collapses to '. All other escapes
      pass through untouched. */
  function passSingleQuotes(text) {
    var spans = mapStrings(text);
    var hasSingle = false;
    for (var q = 0; q < spans.length; q++) {
      if (text.charAt(spans[q][0]) === "'") { hasSingle = true; break; }
    }
    if (!hasSingle) return { text: text, changes: [] };
    var out = '';
    var last = 0;
    var converted = 0;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0];
      var e = spans[k][1];
      if (text.charAt(s) !== "'") continue;
      var inner = text.slice(s + 1, e - 1);
      var b = '';
      for (var i = 0; i < inner.length; i++) {
        var ch = inner.charAt(i);
        if (ch === '\\' && i + 1 < inner.length) {
          var nx = inner.charAt(i + 1);
          b += (nx === "'") ? "'" : (ch + nx);
          i++;
          continue;
        }
        b += (ch === '"') ? '\\"' : ch;
      }
      out += text.slice(last, s) + '"' + b + '"';
      last = e;
      converted++;
    }
    out += text.slice(last);
    return { text: out, changes: [{ key: 'quotes', count: converted }] };
  }

  /** Pass 5 — Quote unquoted keys after { or , (§5.2 safe heuristic).
      Note: replace() callback receives (fullMatch, p1, p2, p3, …). */
  function passUnquotedKeys(text) {
    var spans = mapStrings(text);
    var count = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      return region.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, function (full, a, key, c) {
        count++;
        return a + '"' + key + '"' + c;
      });
    });
    return count ? { text: out, changes: [{ key: 'keys', count: count }] } : { text: text, changes: [] };
  }

  /** Next non-whitespace character in code after index `from`, skipping
      string spans entirely. Returns the character, or null at end. */
  function nextCodeChar(text, spans, from) {
    var i = from;
    while (i < text.length) {
      for (var k = 0; k < spans.length; k++) {
        if (i >= spans[k][0] && i < spans[k][1]) { i = spans[k][1]; break; }
      }
      var c = text.charAt(i);
      if (isWs(c)) { i++; continue; }
      return c;
    }
    return null;
  }

  /** Pass 6 — Trailing commas: drop a comma when the next code character
      outside spans is } or ]. */
  function passTrailingCommas(text) {
    var spans = mapStrings(text);
    var removeAt = [];
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        if (text.charAt(i) !== ',') continue;
        var next = nextCodeChar(text, spans, i + 1);
        if (next === '}' || next === ']') removeAt.push(i);
      }
    }
    if (!removeAt.length) return { text: text, changes: [] };
    var out = '';
    var prev = 0;
    for (var r = 0; r < removeAt.length; r++) {
      out += text.slice(prev, removeAt[r]);
      prev = removeAt[r] + 1;
    }
    out += text.slice(prev);
    return { text: out, changes: [{ key: 'trailing', count: removeAt.length }] };
  }

  /** Passes 7/8 helper — replace whole tokens outside spans; a match is
      skipped when an identifier character touches either side. */
  function wordSwapPass(text, pattern, map, key) {
    var spans = mapStrings(text);
    var count = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      return region.replace(pattern, function (tok, off) {
        var before = off > 0 ? region.charAt(off - 1) : null;
        var after = off + tok.length < region.length ? region.charAt(off + tok.length) : null;
        if (isWordChar(before) || isWordChar(after)) return tok;
        count++;
        return map[tok];
      });
    });
    return count ? { text: out, changes: [{ key: key, count: count }] } : { text: text, changes: [] };
  }

  /** Pass 7 — Invalid JS literals → null (outside spans). */
  function passJsLiterals(text) {
    return wordSwapPass(text, /NaN|-Infinity|Infinity|undefined/g,
      { 'NaN': 'null', '-Infinity': 'null', 'Infinity': 'null', 'undefined': 'null' }, 'jslit');
  }

  /** Pass 8 — Python/other literals (outside spans). */
  function passPyLiterals(text) {
    return wordSwapPass(text, /True|False|None/g,
      { 'True': 'true', 'False': 'false', 'None': 'null' }, 'pylit');
  }

  /** Pass 9 — Insert missing delimiters (checklist §2; JSONBFF-IMPROVEMENTS.md
      §1.3): one left-to-right grammar walk over the non-string regions with
      a frame stack ([container, role]). Containers: OBJECT|ARRAY. Roles:
      KEY (awaiting key or close), COLON (key seen, awaiting ":"), VALUE
      (value expected), POST (value complete, awaiting "," or close). Edits
      only where the JSON grammar forces exactly one minimal fix — three
      insertion-only edits, nothing else:
        D1  OBJECT/POST + key-start token (string|word) → insert ","
        D2  OBJECT/COLON + value-start token            → insert ":"
        D3  ARRAY/POST  + value-start token             → insert ","
      Everything else — a mismatched closer, a colon inside an array, a
      leading comma, a second bare value at POST, a numeric key
      (accepted as-is), root-level tokens — gets no edit and is left to
      the other passes or the failure report (§1.5). It also declines to
      edit an ambiguous paste — several balanced containers surrounded by
      bracket-free prose — because pass 2's leftmost-parseable slice would
      then guess which container is the payload; checklist §0's no-guess
      policy owns those (clean failure instead). The guard mirrors pass 2's
      slice condition exactly via topLevelRegions + outsideFlags. Runs after
      quotes/literals so token classes are clean, and before balance
      (pass 11) so every container is still open while it walks. O(n); one
      scan suffices (the pipeline re-rounds anyway) — insertions are
      recorded in original-text coordinates and applied only at the end,
      so offsets never shift mid-walk. */
  function passDelimiters(text) {
    // Ambiguous-paste guard (checklist §0 no-guess policy): several balanced
    // containers surrounded by bracket-free prose — pass 2 could later slice
    // to whichever one our own repairs made parseable, i.e. it would guess
    // which container is the payload. Decline to edit at all in that shape;
    // the document fails clean instead. Mirrors pass 2's condition exactly.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var OBJ = 0, ARR = 1;                                  // container types
    var R_KEY = 0, R_COLON = 1, R_VALUE = 2, R_POST = 3;   // frame roles
    var T_STRING = 0, T_NUMBER = 1, T_STRUCT = 2, T_WORD = 3;
    var stack = [];      // frames [type, role]
    var inserts = [];    // [offset, char] in original-text coordinates
    var commaCount = 0, colonCount = 0;

    function topFrame() { return stack.length ? stack[stack.length - 1] : null; }

    /** React to one token starting at `pos` (string | number | word | struct). */
    function onToken(cls, pos) {
      var ch = text.charAt(pos);
      var top = topFrame();
      if (cls === T_STRUCT) {
        if (ch === '{' || ch === '[') {
          if (top && top[0] === OBJ && top[1] === R_COLON) {
            inserts.push([pos, ':']); colonCount++; top[1] = R_VALUE; // D2 before a container value
          } else if (top && top[0] === ARR && top[1] === R_POST) {
            inserts.push([pos, ',']); commaCount++; top[1] = R_VALUE; // D3 before an element container
          }
          stack.push(ch === '{' ? [OBJ, R_KEY] : [ARR, R_VALUE]);
          return;
        }
        if (ch === '}' || ch === ']') {
          if (!top) return; // stray closer at root — pass 11
          if ((ch === '}') !== (top[0] === OBJ)) return; // type mismatch — pass 11 owns it
          stack.pop();
          var parent = topFrame();
          if (parent) parent[1] = R_POST; // a closed container was a value
          return;
        }
        if (ch === ':') {
          if (top && top[0] === OBJ && top[1] === R_COLON) top[1] = R_VALUE;
          return; // colon elsewhere → no edit (§1.5)
        }
        if (ch === ',') {
          if (top && top[1] === R_POST) top[1] = (top[0] === OBJ) ? R_KEY : R_VALUE;
          return; // leading comma → no edit (§1.5); duplicate separators → pass 10
        }
        return;
      }
      // Value tokens: string | number | word
      if (!top) return; // root level — edits are container-scoped; bare "1 2" fails clean
      if (top[0] === OBJ) {
        if (top[1] === R_KEY) top[1] = R_COLON; // string/word key; a number is accepted as-is
        else if (top[1] === R_COLON) { inserts.push([pos, ':']); colonCount++; top[1] = R_POST; } // D2
        else if (top[1] === R_VALUE) top[1] = R_POST; // value complete
        else if (top[1] === R_POST && cls !== T_NUMBER) { // D1 — key-start only
          inserts.push([pos, ',']); commaCount++; top[1] = R_COLON;
        }
      } else {
        if (top[1] === R_VALUE) top[1] = R_POST; // value complete
        else if (top[1] === R_POST) { inserts.push([pos, ',']); commaCount++; } // D3 (stays POST)
      }
    }

    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      var i = gs;
      while (i < ge) {
        var c = text.charAt(i);
        if (isWs(c)) { i++; continue; }
        if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
          onToken(T_STRUCT, i); i++; continue;
        }
        if ((c >= '0' && c <= '9') || (c === '-' && text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9')) {
          // Number — full JSON grammar (§1.3 token table): digits, a
          // fraction only when "." is followed by a digit, and an exponent
          // only when [eE][+-]? is followed by at least one digit — so
          // "1. 2" does not swallow the space and "1e5" tokenizes whole.
          var j = i + 1;
          while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') j++;
          if (text.charAt(j) === '.' && text.charAt(j + 1) >= '0' && text.charAt(j + 1) <= '9') {
            j++;
            while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') j++;
          }
          if (text.charAt(j) === 'e' || text.charAt(j) === 'E') {
            var e = j + 1;
            if (text.charAt(e) === '+' || text.charAt(e) === '-') e++;
            if (text.charAt(e) >= '0' && text.charAt(e) <= '9') {
              while (e < ge && text.charAt(e) >= '0' && text.charAt(e) <= '9') e++;
              j = e;
            }
          }
          onToken(T_NUMBER, i); i = j; continue;
        }
        if (isWordChar(c)) {
          var w = i + 1;
          while (w < ge && isWordChar(text.charAt(w))) w++;
          onToken(T_WORD, i); i = w; continue;
        }
        i++; // unrecognized punctuation — skip without edit (§1.5)
      }
      if (k < spans.length) onToken(T_STRING, spans[k][0]); // a span is one atomic token
    }

    if (!inserts.length) return { text: text, changes: [] };
    var out = '';
    var prev = 0;
    for (var r = 0; r < inserts.length; r++) {
      out += text.slice(prev, inserts[r][0]) + inserts[r][1];
      prev = inserts[r][0];
    }
    out += text.slice(prev);
    var changes = [];
    if (commaCount) changes.push({ key: 'comma', count: commaCount });
    if (colonCount) changes.push({ key: 'colon', count: colonCount });
    return { text: out, changes: changes };
  }

  /** Previous non-whitespace character in code before index `from`,
      skipping string spans entirely. Returns the character, or null at
      start. Mirror of nextCodeChar (pass 6 helper). */
  function prevCodeChar(text, spans, from) {
    var i = from - 1;
    while (i >= 0) {
      for (var k = 0; k < spans.length; k++) {
        if (i >= spans[k][0] && i < spans[k][1]) { i = spans[k][0] - 1; break; }
      }
      var c = text.charAt(i);
      if (isWs(c)) { i--; continue; }
      return c;
    }
    return null;
  }

  /** Pass 10 — Collapse duplicate delimiters (checklist §2.4;
      JSONBFF-IMPROVEMENTS.md §2.2): a `,` or `:` whose PREVIOUS code
      character outside string spans is the same punctuation is removed,
      so runs like `,,` / `::` collapse to one — including pairs separated
      by whitespace or with a comment between them (pass 3 strips comments
      earlier in the same round). Valid JSON never places
      two separators in a row, so the edit can only fire on already-
      invalid text (§5.3) — valid input is untouched. Carries pass 9's
      ambiguous-paste guard: collapsing could make one container of a
      multi-container prose paste parseable, and pass 2's leftmost-
      parseable slice would then guess which is the payload — checklist
      §0 no-guess policy; the guard mirrors pass 2's condition exactly
      via topLevelRegions + outsideFlags. Deletion-only → monotone; one
      scan marks every removable separator in original-text coordinates
      and applies the removals at the end, so decisions never see their
      own effects. A lone leading comma ([,1]) and mixed sequences
      ({ "a", : 1 }) get no edit — they fail with the clear error report
      (IMPROVEMENTS §2.2 remainder). Runs after pass 9 (insertions) and
      before balance (pass 11); either ordering with pass 9 converges
      within one round. */
  function passDuplicatePunct(text) {
    // Ambiguous-paste guard — same reasoning as pass 9.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var removeAt = [];
    var commaCount = 0;
    var colonCount = 0;
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c !== ',' && c !== ':') continue;
        if (prevCodeChar(text, spans, i) === c) {
          removeAt.push(i);
          if (c === ',') commaCount++; else colonCount++;
        }
      }
    }
    if (!removeAt.length) return { text: text, changes: [] };
    var out = '';
    var prev = 0;
    for (var r = 0; r < removeAt.length; r++) {
      out += text.slice(prev, removeAt[r]);
      prev = removeAt[r] + 1;
    }
    out += text.slice(prev);
    var changes = [];
    if (commaCount) changes.push({ key: 'dupcomma', count: commaCount });
    if (colonCount) changes.push({ key: 'dupcolon', count: colonCount });
    return { text: out, changes: changes };
  }

  /** Pass 11 — Balance brackets: a closer without a matching open is
      removed ("stray"); at end-of-text the still-open brackets are
      closed in reverse order. */
  function passBalanceBrackets(text) {
    var spans = mapStrings(text);
    var stack = [];
    var strayAt = [];
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          var want = c === '}' ? '{' : '[';
          if (stack[stack.length - 1] === want) stack.pop();
          else strayAt.push(i);
        }
      }
    }
    var changes = [];
    var out = text;
    if (strayAt.length) {
      out = '';
      var prev = 0;
      for (var r = 0; r < strayAt.length; r++) {
        out += text.slice(prev, strayAt[r]);
        prev = strayAt[r] + 1;
      }
      out += text.slice(prev);
      changes.push({ key: 'stray', count: strayAt.length });
    }
    var missing = '';
    for (var s2 = stack.length - 1; s2 >= 0; s2--) {
      missing += stack[s2] === '{' ? '}' : ']';
    }
    if (missing) {
      out += missing;
      changes.push({ key: 'closed', count: missing.length });
    }
    return changes.length ? { text: out, changes: changes } : { text: text, changes: [] };
  }

  /* ---------------- pipeline + status messages (§5.1, §4) ------------- */
  var PASSES = [
    passNormalize,       // 1
    passWrapper,         // 2 (checklist §0 — code fences + surrounding prose)
    passComments,        // 3
    passSingleQuotes,    // 4
    passUnquotedKeys,    // 5
    passTrailingCommas,  // 6
    passJsLiterals,      // 7
    passPyLiterals,      // 8
    passDelimiters,      // 9 (checklist §2 — insert missing commas/colons, grammar-driven)
    passDuplicatePunct,  // 10 (checklist §2.4 — collapse duplicate ,, / :: separators)
    passBalanceBrackets  // 11
  ];

  var LABELS = {
    normalize: function (c) { return c === 1 ? 'stripped 1 BOM/line-ending' : 'stripped ' + c + ' BOMs/line-endings'; },
    fence: function (c) { return c === 1 ? 'stripped 1 markdown code fence' : 'stripped ' + c + ' markdown code fences'; },
    prose: function (c) { return c === 1 ? 'removed 1 block of surrounding prose' : 'removed ' + c + ' blocks of surrounding prose'; },
    comments: function (c) { return c === 1 ? 'removed 1 comment' : 'removed ' + c + ' comments'; },
    quotes: function (c) { return c === 1 ? 'converted 1 single-quoted string' : 'converted ' + c + ' single-quoted strings'; },
    keys: function (c) { return c === 1 ? 'quoted 1 key' : 'quoted ' + c + ' keys'; },
    trailing: function (c) { return c === 1 ? 'removed 1 trailing comma' : 'removed ' + c + ' trailing commas'; },
    jslit: function (c) { return c === 1 ? 'replaced 1 invalid literal' : 'replaced ' + c + ' invalid literals'; },
    pylit: function (c) { return c === 1 ? 'replaced 1 Python-style literal' : 'replaced ' + c + ' Python-style literals'; },
    comma: function (c) { return c === 1 ? 'inserted 1 missing comma' : 'inserted ' + c + ' missing commas'; },
    colon: function (c) { return c === 1 ? 'inserted 1 missing colon' : 'inserted ' + c + ' missing colons'; },
    dupcomma: function (c) { return c === 1 ? 'collapsed 1 duplicate comma' : 'collapsed ' + c + ' duplicate commas'; },
    dupcolon: function (c) { return c === 1 ? 'collapsed 1 duplicate colon' : 'collapsed ' + c + ' duplicate colons'; },
    stray: function (c) { return c === 1 ? 'removed 1 stray bracket' : 'removed ' + c + ' stray brackets'; },
    closed: function (c) { return c === 1 ? 'closed 1 open bracket' : 'closed ' + c + ' open brackets'; }
  };

  function changePhrases(changes) {
    var out = [];
    for (var i = 0; i < changes.length; i++) {
      var label = LABELS[changes[i].key];
      if (label) out.push(label(changes[i].count));
    }
    return out.join(', ');
  }

  function totalEdits(changes) {
    var n = 0;
    for (var i = 0; i < changes.length; i++) n += changes[i].count;
    return n;
  }

  /** Fix (repair) per §4: repaired output formatted at `indent`; status
      lists what was fixed; idempotent on valid input (0 changes). */
  function fix(text, indent) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, message: 'Input is empty — paste JSON first.' };
    }
    var current = text;
    var parsed = attemptParse(current);
    var changes = [];
    // Rounds of the fixed-order passes. Passes are monotone, but cap the
    // rounds anyway: a logic bug must fail clean, never hang the tab.
    var MAX_ROUNDS = 10;
    var round = 0;
    while (!parsed.ok && round < MAX_ROUNDS) {
      round++;
      var progressed = false;
      for (var i = 0; i < PASSES.length && !parsed.ok; i++) {
        var r = PASSES[i](current);
        if (r.changes.length) {
          changes = changes.concat(r.changes);
          current = r.text;
          parsed = attemptParse(current);
          progressed = true;
        }
      }
      if (!progressed) break; // no pass can help — stop and report (§5.3)
    }

    if (parsed.ok) {
      var space = indent;
      if (!(typeof space === 'string' || (typeof space === 'number' && space > 0))) space = 2;
      var message;
      if (!changes.length) {
        message = '✓ Already valid JSON — no fixes needed (reformatted).';
      } else {
        var edits = totalEdits(changes);
        message = '🔧 Fixed ' + changes.length + (changes.length === 1 ? ' issue: ' : ' issues: ') +
                  changePhrases(changes) + ' (' + edits + (edits === 1 ? ' edit' : ' edits') + ').' +
                  (round > 1 ? ' Took ' + round + ' repair rounds.' : '');
      }
      return { ok: true, output: JSON.stringify(parsed.value, null, space), message: message, changes: changes };
    }

    var phrases = changePhrases(changes);
    return {
      ok: false,
      output: current,
      message: '✗ Could not fully fix — ' + errorDetail(current, parsed.error) + '.' +
               (phrases ? ' Repaired so far: ' + phrases + '.' : ' No safe repair matched.'),
      changes: changes
    };
  }

  root.JSONBFFFix = {
    fix: fix,
    // Scanner internals exposed for tests (§5.1 names them as the API):
    _internal: { mapStrings: mapStrings, transformOutsideSpans: transformOutsideSpans }
  };
})(typeof window !== 'undefined' ? window : globalThis);