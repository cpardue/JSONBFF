/* ============================================================
   JSON BFF — fixer-b.js (fixer.js part 2/3 — repair passes 4-10)

   Part 2 of 3 of the single fixer.js module (JSONBFF-PLAN.md §5). It is
   split into three classic <script> files only because the push transport
   caps a single file at ~38 KB; together with fixer-a.js and fixer-c.js it
   is exactly one module. Part 1 (fixer-a.js) opened the IIFE and exported
   its top-level functions on root.__JBF; the alias line below restores them
   into this part's scope, so the original source below is unchanged.
   ============================================================ */
(function (root) {
  'use strict';
  var S = root.__JBF;
  var mapStrings = S.mapStrings, transformOutsideSpans = S.transformOutsideSpans,
      isWs = S.isWs, isWordChar = S.isWordChar, attemptParse = S.attemptParse,
      topLevelRegions = S.topLevelRegions, outsideFlags = S.outsideFlags,
      nextCodeChar = S.nextCodeChar, wordSwapPass = S.wordSwapPass,
      prevCodeChar = S.prevCodeChar;

  /** Pass 8 — Python/other literals (outside spans). */
  function passPyLiterals(text) {
    return wordSwapPass(text, /True|False|None/g,
      { 'True': 'true', 'False': 'false', 'None': 'null' }, 'pylit');
  }

  /** Pass 15 — Repair malformed number tokens (checklist §5): a token in
      code context that reads as exactly ONE numeric typo end-to-end is
      rewritten to the unique valid JSON number it can mean — a leading `+`
      dropped (+5 → 5), integer leading zeros stripped (007 → 7, -00.25 →
      -0.25), a trailing dot with no fraction digits dropped (5. → 5), or
      a missing integer part zeroed (.5 → 0.5); all four may combine in
      one token (+007. → 7). Exponent material is copied verbatim — signs
      inside 1e+5 and leading zeros there (1e007 is valid JSON) — so a
      token that already matches the JSON number grammar is skipped: valid
      input can never change (§5.3). A token is edited only when both raw
      neighbors are clean boundaries (text start/end, or on the left
      whitespace / { [ , : and on the right whitespace / , } ] :), so
      identifier-looking runs (007x, 1..2, --5) fail clean instead of
      being guessed (pass 9's no-guess policy). Carries the standard
      ambiguous-paste guard (checklist §0). One scan records every fix in
      original-text coordinates and applies them at the end — a fix only
      ever canonicalizes a token to a shape the scanner then reads as
      valid, so re-rounds never re-fire on their own output (monotone). */
  function passNumbers(text) {
    // Ambiguous-paste guard — same reasoning as pass 9.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var edits = []; // [start, end, replacement] — disjoint, in text order
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      var i = gs;
      while (i < ge) {
        var c = text.charAt(i);
        var starts = (c >= '0' && c <= '9') ||
          (c === '.' && text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9') ||
          ((c === '+' || c === '-') &&
            (text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9' ||
             (text.charAt(i + 1) === '.' && text.charAt(i + 2) >= '0' && text.charAt(i + 2) <= '9')));
        if (!starts) { i++; continue; }
        var s0 = i;
        var t = scanNumberToken(text, s0, ge);
        i = t.end; // walk past the whole token — valid or not, never rescan inside it
        if (t.ok || t.fixed === text.slice(s0, t.end)) continue; // already canonical
        var before = s0 > 0 ? text.charAt(s0 - 1) : null;
        if (before !== null && !isWs(before) &&
            before !== '{' && before !== '[' && before !== ',' && before !== ':') continue;
        var after = t.end < text.length ? text.charAt(t.end) : null;
        if (after !== null && !isWs(after) &&
            after !== ',' && after !== '}' && after !== ']' && after !== ':') continue;
        edits.push([s0, t.end, t.fixed]);
      }
    }
    if (!edits.length) return { text: text, changes: [] };
    var out = '';
    var prev = 0;
    for (var r = 0; r < edits.length; r++) {
      out += text.slice(prev, edits[r][0]) + edits[r][2];
      prev = edits[r][1];
    }
    out += text.slice(prev);
    return { text: out, changes: [{ key: 'number', count: edits.length }] };
  }

  /** Scan one number-ish token starting at index i (region end ge caps the
      walk) → { end, ok, fixed }. `ok` is true when the token already
      matches the JSON number grammar — -?(0|[1-9]digits)(.digits)?
      ([eE][+-]?digits)? — and it is then never edited (a leading + is the
      one sign the grammar rejects). Otherwise `fixed` is the unique
      rewrite from the four allowed typos (leading +, integer leading
      zeros, trailing dot without fraction digits, missing integer part).
      A trailing dot is read INTO the token only when followed by a clean
      right boundary; otherwise the token ends before it, so 1..2 stays
      unfixable garbage for the clean error report. */
  function scanNumberToken(text, i, ge) {
    var j = i;
    var sign = '';
    if (text.charAt(j) === '+' || text.charAt(j) === '-') { sign = text.charAt(j); j++; }
    var intStart = j, intLen = 0;
    while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') { intLen++; j++; }
    var dotAt = -1, fracStart = -1, fracLen = 0;
    if (j < ge && text.charAt(j) === '.') {
      if (text.charAt(j + 1) >= '0' && text.charAt(j + 1) <= '9') {
        dotAt = j;
        fracStart = j + 1;
        j++;
        while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') { fracLen++; j++; }
      } else if (isNumberEndAfter(text, j + 1)) {
        dotAt = j; // trailing dot — part of the token so it can be dropped
        j++;
      }
    }
    var expStart = -1, expEnd = -1;
    if (j < ge && (text.charAt(j) === 'e' || text.charAt(j) === 'E')) {
      var e = j + 1;
      if (e < ge && (text.charAt(e) === '+' || text.charAt(e) === '-')) e++;
      if (e < ge && text.charAt(e) >= '0' && text.charAt(e) <= '9') {
        while (e < ge && text.charAt(e) >= '0' && text.charAt(e) <= '9') e++;
        expStart = j;
        expEnd = e;
        j = e;
      }
    }
    var canonicalInt = intLen > 0 &&
      (intLen === 1 || text.charAt(intStart) !== '0');
    var ok = sign !== '+' && canonicalInt && (dotAt === -1 || fracLen > 0);
    var fixed = '';
    if (!ok) {
      if (sign === '-') fixed += '-';
      if (intLen > 0) {
        var m = 0;
        while (m < intLen - 1 && text.charAt(intStart + m) === '0') m++;
        fixed += text.slice(intStart + m, intStart + intLen);
      } else {
        fixed += '0';
      }
      if (dotAt !== -1 && fracLen > 0) fixed += '.' + text.slice(fracStart, fracStart + fracLen);
      if (expStart !== -1) fixed += text.slice(expStart, expEnd);
    }
    return { end: j, ok: ok, fixed: fixed };
  }

  /** Clean right boundary for a number token ending before index i: text
      end, or whitespace / , } ] : — the same set pass 15's caller checks. */
  function isNumberEndAfter(text, i) {
    var c = text.charAt(i);
    return c === '' || isWs(c) || c === ',' || c === '}' || c === ']' || c === ':';
  }

  /** Is the char at index i an escaped quote — odd number of consecutive
      backslashes immediately before it? (\" is content; \\" is not.) */
  function escapesAt(text, i) {
    var n = 0;
    while (i - 1 - n >= 0 && text.charAt(i - 1 - n) === '\\') n++;
    return n % 2 === 1;
  }

  /** Pass 12 — Escape unescaped inner double quotes (checklist §4.4): a
      TERMINATED "..." span that opens in VALUE position (right after a ':')
      and is immediately followed (in code, whitespace ignored) by a bare
      word that is NOT a key — no colon after the word — can only be read as
      a string that never closed at its apparent end: the closer is content.
      A span preceded by { , [ is skipped — a bare word after THAT is a
      missing delimiter (pass 9) or structural nonsense, and merging it into
      one string would corrupt the document. Repair candidates: every later
      quote position C (capped), and for each one escape every unescaped "
      strictly between the opener s and C, so s..C becomes one string; each
      candidate is certified by a strict JSON.parse of the WHOLE text (the
      parser itself decides — pass 11's policy) and the leftmost certifying
      C wins. The no-colon rule keeps this off missing-comma keys (pass 9's
      job), and the trigger can only fire on already-invalid text, so valid
      input is untouched (§5.3). Carries pass 9's ambiguous-paste no-guess
      guard. Not repaired (clean error report): breaks inside array elements
      or at key positions, breaks at quote adjacency (no bare word after the
      premature close), and strings that are ALSO missing their final closing
      quote — all documented in the header. Placed in PASSES before pass 9
      despite its number: pass 9's D1 insertion would rewrite this trigger
      shape (a comma inside what was string content). */
  function passInnerQuotes(text) {
    // Ambiguous-paste guard — same reasoning as pass 9.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var MAX_CANDIDATES = 16;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0], e = spans[k][1];
      if (text.charAt(s) !== '"' || !spans[k][2]) continue; // unterminated → pass 13
      // VALUE position only: the span must open right after a ':' (an object
      // value). A span preceded by { , [ is a key or an array element — a bare
      // word after THAT is a missing delimiter (pass 9's job) or structural
      // nonsense, and merging it into one string would corrupt the document.
      if (prevCodeChar(text, spans, s) !== ':') continue;
      var f = e;
      while (f < text.length && isWs(text.charAt(f))) f++;
      if (f >= text.length || !isWordChar(text.charAt(f))) continue;
      var w1 = f;
      while (w1 < text.length && isWordChar(text.charAt(w1))) w1++;
      var g = w1;
      while (g < text.length && isWs(text.charAt(g))) g++;
      if (g < text.length && text.charAt(g) === ':') continue; // a key — pass 9's shape

      var q = text.indexOf('"', e + 1);
      var tried = 0;
      while (q !== -1 && tried < MAX_CANDIDATES) {
        tried++;
        var target = [];
        for (var p = s + 1; p < q; p++) {
          if (text.charAt(p) === '"' && !escapesAt(text, p)) target.push(p);
        }
        var out = '';
        var prev = 0;
        for (var t = 0; t < target.length; t++) {
          // Insert '\' just before the quote at target[t]; keep the quote.
          out += text.slice(prev, target[t]) + '\\';
          prev = target[t];
        }
        out += text.slice(prev);
        if (attemptParse(out).ok) {
          return { text: out, changes: [{ key: 'innerquote', count: target.length }] };
        }
        q = text.indexOf('"', q + 1);
      }
    }
    return { text: text, changes: [] };
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

  /** Pass 13 — Close unterminated double-quoted strings (checklist §4.1):
      a " span that mapStrings extends to end-of-text has NO unescaped
      closer anywhere in the remainder of the document; it is closed by
      inserting one. Positions tried, in order:
        1. every structural char ( , } ] ) inside the open span, left to
           right (capped) — insert " just before it; the FIRST whole-text
           result that strict-parses wins (the checklist's own rule, same
           parser-certified policy as pass 11 — e.g. { "a": "x } closes at
           the brace in one edit);
        2. otherwise: the end of the span's content — trailing whitespace
           stays OUTSIDE the string, and an odd dangling backslash run (it
           cannot escape anything) is dropped.
      Only a span that opens in code context ({ , : [ or text start) is
      closed — a stray " in prose degrades to the clean error report
      (header limitation). The trigger can only fire on already-invalid
      text, so valid input is untouched (§5.3). Placed in PASSES before
      pass 11 despite its number: the balance EOF-close would otherwise
      land INSIDE the open span and corrupt it. */
  function passUnterminatedStrings(text) {
    var spans = mapStrings(text);
    var s = -1;
    for (var k = 0; k < spans.length; k++) {
      if (text.charAt(spans[k][0]) === '"' && !spans[k][2]) { s = spans[k][0]; break; }
    }
    if (s === -1) return { text: text, changes: [] };
    var pc = prevCodeChar(text, spans, s);
    if (pc !== null && pc !== '{' && pc !== ',' && pc !== ':' && pc !== '[') return { text: text, changes: [] };

    var p = text.length;
    while (p > s + 1 && isWs(text.charAt(p - 1))) p--; // trailing whitespace stays outside
    var be = p;
    while (be > s + 1 && text.charAt(be - 1) === '\\') be--;
    if ((p - be) % 2 === 1) p = be; // odd dangling backslash run — drop it

    var tested = 0;
    for (var m = s + 1; m < p && tested < 16; m++) {
      var c = text.charAt(m);
      if ((c !== ',' && c !== '}' && c !== ']') || escapesAt(text, m)) continue;
      var cand = text.slice(0, m) + '"' + text.slice(m);
      if (attemptParse(cand).ok) return { text: cand, changes: [{ key: 'strclose', count: 1 }] };
      tested++;
    }

    return { text: text.slice(0, p) + '"' + text.slice(p), changes: [{ key: 'strclose', count: 1 }] };
  }

  /** Pass 14 — Escape unescaped control characters inside string spans
      (checklist §4.5): raw U+0000–U+001F → the JSON escapes \b \t \n \f
      \r, all others as \u00xx. Existing escape pairs pass through
      untouched. Placed after pass 13 (so its trailing-whitespace trim sees
      the raw characters) and before pass 11. Valid JSON never contains a
      raw control character in a span, so this only fires on already-
      invalid text (§5.3). */
  function passEscCtrl(text) {
    var spans = mapStrings(text);
    var count = 0;
    var out = '';
    var last = 0;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0], e = spans[k][1];
      var cEnd = spans[k][2] ? e - 1 : e; // content excludes the closing delimiter (unterminated: to EOF)
      out += text.slice(last, s + 1);
      var b = '';
      for (var i = s + 1; i < cEnd; i++) {
        var ch = text.charAt(i);
        if (ch === '\\' && i + 1 < cEnd) { b += ch + text.charAt(i + 1); i++; continue; } // keep existing escape
        var code = text.charCodeAt(i);
        if (code < 32) {
          count++;
          if (ch === '\b') b += '\\b';
          else if (ch === '\t') b += '\\t';
          else if (ch === '\n') b += '\\n';
          else if (ch === '\f') b += '\\f';
          else if (ch === '\r') b += '\\r';
          else { var h = code.toString(16); b += '\\u00' + (h.length < 2 ? '0' : '') + h; }
          continue;
        }
        b += ch;
      }
      out += b;
      if (cEnd < e) out += text.charAt(e - 1); // closing delimiter
      last = e;
    }
    out += text.slice(last);
    return count ? { text: out, changes: [{ key: 'ctrl', count: count }] } : { text: text, changes: [] };
  }

  /** Pass 11 — Balance brackets (checklist §3): a closer without a
      matching open is removed ("stray"); at end-of-text the still-open
      brackets are closed in reverse order. A type mismatch (e.g. `]`
      when the top frame is `{`) gets the checklist's two single-edit
      candidates — swap the closer to match the open frame, or remove it
      — each certified by a strict JSON.parse of the WHOLE text (the
      parser itself decides; no guesswork). At most one candidate can
      ever parse: a swap keeps the outside-string bracket count and a
      removal lowers it by one, while valid JSON needs exactly one
      closer per opener. The first adoptable position in text order wins
      and is the ONLY edit this invocation makes (one targeted fix per
      round, §7) — adoption always makes the whole document parse, so it
      completes the repair. If no candidate parses on its own, behavior
      is unchanged from the legacy path: every stray/mismatch closer is
      removed and still-open brackets are closed at EOF (which may then
      compose with other passes in later rounds). Candidate tests are
      capped (MAX_MISMATCH_TESTS strict parses) so a pathological input
      reaches the legacy path instead of churning. */
  function passBalanceBrackets(text) {
    var spans = mapStrings(text);
    var stack = [];
    var strayAt = [];       // ALL unmatched closer positions (removal list)
    var mismatchOpen = [];  // parallel: top-frame opener for TYPE mismatches ('' = empty-stack stray)
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          var want = c === '}' ? '{' : '[';
          var top = stack.length ? stack[stack.length - 1] : null;
          if (top === want) stack.pop();
          else {
            strayAt.push(i);
            mismatchOpen.push(top === null ? '' : top);
          }
        }
      }
    }
    // Candidate decision for type mismatches ("try both, keep whichever
    // parses", checklist §3). Swap is tested before removal; the order is
    // immaterial to correctness (at most one can parse) — swap-first just
    // prefers keeping the author's bracket count. Empty-stack strays have
    // no frame to match, so removal only, exactly as the legacy path did.
    var MAX_MISMATCH_TESTS = 32;
    var tested = 0;
    for (var m = 0; m < mismatchOpen.length && tested < MAX_MISMATCH_TESTS; m++) {
      if (!mismatchOpen[m]) continue;
      var mi = strayAt[m];
      var swapText = text.slice(0, mi) + (mismatchOpen[m] === '{' ? '}' : ']') + text.slice(mi + 1);
      tested++;
      if (attemptParse(swapText).ok) {
        return { text: swapText, changes: [{ key: 'swapped', count: 1 }] };
      }
      var rmText = text.slice(0, mi) + text.slice(mi + 1);
      tested++;
      if (attemptParse(rmText).ok) {
        return { text: rmText, changes: [{ key: 'stray', count: 1 }] };
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


  /* ---- split point: the module continues in fixer-c.js (see fixer-a.js). ---- */
  root.__JBF_B = { passPyLiterals: passPyLiterals, passNumbers: passNumbers,
               scanNumberToken: scanNumberToken, isNumberEndAfter: isNumberEndAfter,
               escapesAt: escapesAt, passInnerQuotes: passInnerQuotes,
               passDelimiters: passDelimiters,
               passDuplicatePunct: passDuplicatePunct, passUnterminatedStrings: passUnterminatedStrings,
               passEscCtrl: passEscCtrl, passBalanceBrackets: passBalanceBrackets };
})(typeof window !== 'undefined' ? window : globalThis);
