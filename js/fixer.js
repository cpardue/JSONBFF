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
      [1, "a": 2], leading/double commas, missing value before a close
      { "a": , }); unquoted numeric keys ({ 1: 2 } — a number in key
      position is accepted, not quoted; still invalid); ambiguous pastes
      with several balanced containers surrounded by prose — the pass
      declines to edit at all there, since pass 2's leftmost-parseable
      slice would then guess which container is the payload (checklist §0
      no-guess policy).
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
      Firefox lineNumber/column, newline-count fallback (§4). */
  function errorDetail(text, err) {
    var msg = (err && err.message) ? err.message : String(err);
    var m = /at position (\d+)/.exec(msg);
    if (!m && err && typeof err.lineNumber === 'number' && typeof err.column === 'number') {
      return msg + ' (line ' + err.lineNumber + ', column ' + err.column + ')';
    }
    var pos = m ? parseInt(m[1], 10) : -1;
    if (m && !/at line \d+ column \d+/.test(msg)) {
      var line = 1, col = pos + 1;
      for (var p = 0; p < pos && p < text.length; p++) {
        if (text.charAt(p) === '\n') { line++; col = 0; }
        col++;
      }
      msg += ' (line ' + line + ', column ' + col + ')';
    }
    return msg;
  }

  /** Pass 1 — Normalize: BOM + CRLF (§5.2 pass 1). */
  function passNormalize(text) {
    var changes = [];
    var t = text;
    if (t.charCodeAt(0) === 0xFEFF) {
      t = t.slice(1);
      changes.push({ key: 'bom', count: 1 });
    }
    if (t.indexOf('\r') !== -1) {
      var crs = 0;
      t = t.replace(/\r\n?/g, function () { crs++; return '\n'; });
      if (crs) changes.push({ key: 'endings', count: crs });
    }
    return { text: t, changes: changes };
  }

  /** Top-level balanced container regions (string-aware depth walk) →
      [ [start, end), … ] left-to-right; a closer below depth 0 resets the
      current region. Shared by pass 2 (prose slicing) and pass 9 (its
      ambiguous-paste guard must mirror pass 2's slice condition exactly —
      one source of truth for both). */
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
      fence line (```lang), closed or unclosed; then, when non-blank,
      bracket-free prose surrounds the outermost balanced container(s),
      slice to it. Several containers → leftmost that already parses as
      strict JSON; none parse → no edit, clean failure. One shrink per
      call: a multi-container slice leaves fence + prose for the next
      round (pipeline re-rounds, MAX_ROUNDS capped). */
  function passWrapper(text) {
    var changes = [];
    var t = text;

    // -- fence: only when the FIRST non-empty line is a ``` line.
    var firstLineStart = -1;
    for (var f = 0; f < t.length; f++) {
      if (!isWs(t.charAt(f))) { firstLineStart = f; break; }
    }
    if (firstLineStart !== -1) {
      var lineEnd = t.indexOf('\n', firstLineStart);
      if (lineEnd === -1) lineEnd = t.length;
      var firstLine = t.slice(firstLineStart, lineEnd).replace(/\r$/, '');
      if (/^\s*```/.test(firstLine)) {
        var close = t.search(/^```/m);
        if (close > 0) {
          // drop through the closing fence to its line end
          var afterClose = t.indexOf('\n', close);
          t = t.slice(0, close) + (afterClose === -1 ? '' : t.slice(afterClose + 1));
        } else {
          // unclosed: drop just the opening line
          t = t.slice(0, firstLineStart) + t.slice(lineEnd === t.length ? lineEnd : lineEnd + 1);
        }
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
          for (var r = 0; r < regions.length; r++) {
            if (attemptParse(t.slice(regions[r][0], regions[r][1])).ok) { pick = r; break; }
          }
        }
      }
    }

    if (pick === -1) return { text: t, changes: changes };
    var region = regions[pick];
    t = t.slice(region[0], region[1]);
    changes.push({ key: 'prose', count: 1 });
    return { text: t, changes: changes };
  }

  /** Pass 3 — Comments (§5.2 pass 2): // to end-of-line, /* … *\/ blocks,
      and Python # line comments (string-aware, so "http://…" in a string
      is untouched). Line-end comment → deleted with its trailing newline;
      block comment → one space (keeps tokens separated). */
  function passComments(text) {
    var spans = mapStrings(text);
    var changes = [];
    var count = 0;

    function strip(region) {
      var out = '';
      var i = 0;
      var n = region.length;
      while (i < n) {
        var c = region.charAt(i);
        if (c === '/' && region.charAt(i + 1) === '/') {
          count++;
          while (i < n && region.charAt(i) !== '\n') i++;
        } else if (c === '#' /* Python-style, per §5.2 */) {
          // '#' only counts when at a token boundary: line start or preceded
          // by whitespace/comma/bracket — "#tag" mid-word is not a comment.
          if (i === 0 || isWs(region.charAt(i - 1)) || ',[{('.indexOf(region.charAt(i - 1)) !== -1) {
            count++;
            while (i < n && region.charAt(i) !== '\n') i++;
          } else {
            out += c; i++;
          }
        } else if (c === '/' && region.charAt(i + 1) === '*') {
          count++;
          var close = region.indexOf('*/', i + 2);
          if (close === -1) i = n;      // unterminated block: drop to end
          else i = close + 2;
          out += ' ';
        } else {
          out += c; i++;
        }
      }
      return out;
    }

    var t = transformOutsideSpans(text, spans, strip);
    if (count) changes.push({ key: 'comments', count: count });
    return { text: t, changes: changes };
  }

  /** Pass 4 — Single → double quotes (§5.2 pass 3): '…' spans whose content
      holds no unescaped ' become "…"; inner bare " become \". Nested pairs
      re-round (pipeline caps rounds). An apostrophe in prose degrades to a
      clear error report — never a silent wrong edit (see header). */
  function passSingleQuotes(text) {
    var spans = mapStrings(text);
    var count = 0;

    function convert(region) {
      // Walk '…' pairs inside this (double-quote-free-of-interest) region:
      // the shared scanner already treated ' as a string delimiter, so each
      // such span that starts here is re-serialized with " delimiters.
      return region;
    }

    // Operate on spans directly: ' spans are real spans in mapStrings.
    var out = '';
    var prev = 0;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0], e = spans[k][1];
      if (text.charAt(s) !== "'") continue;
      // unterminated apostrophe span (to end-of-text): not a string pair — skip
      if (e === text.length && s + 1 < e && text.charAt(e - 1) !== "'") continue;
      var body = text.slice(s + 1, e - 1);
      if (body.indexOf("'") !== -1) continue; // escaped ' inside → leave for re-round logic
      out += text.slice(prev, s) + '"' + body.replace(/\\?"/g, function (q) { return '\\' + q; }) + '"';
      prev = e;
      count++;
    }
    if (prev < text.length) out += text.slice(prev);
    else out = out; // nothing after last span

    if (!count) return { text: text, changes: [] };
    return { text: out, changes: [{ key: 'quotes', count: count }] };
  }

  /** Pass 5 — Unquoted keys (§5.2 pass 4): identifier-like token directly
      before ":" (after { or , and whitespace) → quoted. Only outside spans. */
  function passUnquotedKeys(text) {
    var spans = mapStrings(text);
    var count = 0;

    function quoteKeys(region) {
      return region.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, function (full, pre, key, post) {
        count++;
        return pre + '"' + key + '"' + post;
      });
    }

    var t = transformOutsideSpans(text, spans, quoteKeys);
    if (count) changes0(t, count);
    return { text: t, changes: count ? [{ key: 'keys', count: count }] : [] };

    function changes0(t2, c) { /* no-op placeholder kept for clarity */ }
  }

  /** Next non-whitespace char in the region, or '' at end. */
  function nextCodeChar(region, from) {
    for (var i = from; i < region.length; i++) {
      if (!isWs(region.charAt(i))) return region.charAt(i);
    }
    return '';
  }

  /** Pass 6 — Trailing commas (§5.2 pass 5): "," directly before } or ]
      (whitespace apart) → removed. */
  function passTrailingCommas(text) {
    var spans = mapStrings(text);
    var count = 0;

    function drop(region) {
      return region.replace(/,(\s*[}\]])/g, function (full, tail) {
        count++;
        return tail;
      });
    }

    var t = transformOutsideSpans(text, spans, drop);
    return { text: t, changes: count ? [{ key: 'trailing', count: count }] : [] };
  }

  /** Pass 7 — JS literals → null (§5.2 pass 6): undefined/NaN/Infinity/
      -Infinity as whole words outside spans. */
  function passJsLiterals(text) {
    var spans = mapStrings(text);
    var count = 0;
    var WORDS = 'undefined|NaN|Infinity|-Infinity';

    function swap(region) {
      return region.replace(new RegExp('(?<![A-Za-z0-9_$])(' + WORDS + ')(?![A-Za-z0-9_$])', 'g'), function () {
        count++;
        return 'null';
      });
    }

    var t = transformOutsideSpans(text, spans, swap);
    return { text: t, changes: count ? [{ key: 'jslit', count: count }] : [] };
  }

  /** Pass 8 — Python literals (§5.2 pass 7): True/False/None whole-word. */
  function passPyLiterals(text) {
    var spans = mapStrings(text);
    var count = 0;

    function swap(region) {
      return region.replace(/(?<![A-Za-z0-9_$])(True|False|None)(?![A-Za-z0-9_$])/g, function (w) {
        count++;
        if (w === 'True') return 'true';
        if (w === 'False') return 'false';
        return 'null';
      });
    }

    var t = transformOutsideSpans(text, spans, swap);
    return { text: t, changes: count ? [{ key: 'pylit', count: count }] : [] };
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
      leading/double comma, a second bare value at POST, a numeric key
      (accepted as-is), root-level tokens — gets no edit and is left to
      the other passes or the failure report (§1.5). It also declines to
      edit an ambiguous paste — several balanced containers surrounded by
      bracket-free prose — because pass 2's leftmost-parseable slice would
      then guess which container is the payload; checklist §0's no-guess
      policy owns those (clean failure instead). The guard mirrors pass 2's
      slice condition exactly via topLevelRegions + outsideFlags. Runs after
      quotes/literals so token classes are clean, and before balance
      (pass 10) so every container is still open while it walks. O(n); one
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
          if (!top) return; // stray closer at root — pass 10
          if ((ch === '}') !== (top[0] === OBJ)) return; // type mismatch — pass 10 owns it
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
          return; // leading/double comma → no edit (§1.5)
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

  /** Pass 10 — Balance brackets: a closer without a matching open is
      removed ("stray"); at end-of-text the still-open brackets are
      closed in reverse order. */
  function passBalanceBrackets(text) {
    var spans = mapStrings(text);
    var stack = [];
    var strayCount = 0;
    var removeAt = [];

    function handle(region, offsetBase) {
      for (var i = 0; i < region.length; i++) {
        var c = region.charAt(i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          var open = (c === '}') ? '{' : '[';
          if (stack.length && stack[stack.length - 1] === open) stack.pop();
          else { strayCount++; removeAt.push(offsetBase + i); }
        }
      }
    }

    var t = text;
    // First compute removals against the original coordinates, then apply.
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : t.length;
      handle(t.slice(gs, ge), gs);
    }

    if (strayCount) {
      var out = '';
      var prev = 0;
      for (var r = 0; r < removeAt.length; r++) {
        out += t.slice(prev, removeAt[r]);
        prev = removeAt[r] + 1;
      }
      out += t.slice(prev);
      t = out;
    }

    var closedCount = 0;
    if (stack.length) {
      for (var s = stack.length - 1; s >= 0; s--) {
        t += (stack[s] === '{') ? '}' : ']';
        closedCount++;
      }
    }

    var changes = [];
    if (strayCount) changes.push({ key: 'stray', count: strayCount });
    if (closedCount) changes.push({ key: 'closed', count: closedCount });
    return { text: t, changes: changes };
  }

  /* ---------------- passes (§5.2, fixed order) ---------------- */
  var PASSES = [
    passNormalize,       // 1
    passWrapper,         // 2 (checklist §0 — markdown fence / surrounding prose)
    passComments,        // 3
    passSingleQuotes,    // 4
    passUnquotedKeys,    // 5
    passTrailingCommas,  // 6
    passJsLiterals,      // 7
    passPyLiterals,      // 8
    passDelimiters,      // 9 (checklist §2 — insert missing commas/colons, grammar-driven)
    passBalanceBrackets  // 10
  ];

  /* ---------------- reporting (§4 status line / changes list) -------- */
  var LABELS = {
    bom: function () { return 'stripped a UTF-8 BOM'; },
    endings: function (c) { return c === 1 ? 'normalized 1 CRLF line ending' : 'normalized ' + c + ' CRLF line endings'; },
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