/* ============================================================
   JSON BFF — fixer-c.js (fixer.js part 3/3 — passes 11-16, pipeline, fix())

   Part 3 of 3 of the single fixer.js module (JSONBFF-PLAN.md §5) — see
   fixer-a.js for why the module is split. The alias lines below restore
   parts 1 and 2 into scope; the original source that follows is unchanged,
   including the final export of window.JSONBFFFix.
   ============================================================ */
(function (root) {
  'use strict';
  var S = root.__JBF;
  var SB = root.__JBF_B;
  var mapStrings = S.mapStrings, transformOutsideSpans = S.transformOutsideSpans,
      isWs = S.isWs, isWordChar = S.isWordChar, attemptParse = S.attemptParse,
      lineColOf = S.lineColOf, parseErrorPosition = S.parseErrorPosition,
      prevCodeChar = S.prevCodeChar, contextSnippet = S.contextSnippet,
      errorDetail = S.errorDetail, passNormalize = S.passNormalize,
      passWrapper = S.passWrapper, passComments = S.passComments,
      passSingleQuotes = S.passSingleQuotes, passUnquotedKeys = S.passUnquotedKeys,
      passTrailingCommas = S.passTrailingCommas, passJsLiterals = S.passJsLiterals;
  var escapesAt = SB.escapesAt,
      scanNumberToken = SB.scanNumberToken, passPyLiterals = SB.passPyLiterals,
      passNumbers = SB.passNumbers, passInnerQuotes = SB.passInnerQuotes,
      passDelimiters = SB.passDelimiters, passDuplicatePunct = SB.passDuplicatePunct,
      passUnterminatedStrings = SB.passUnterminatedStrings, passEscCtrl = SB.passEscCtrl,
      passBalanceBrackets = SB.passBalanceBrackets;

  /* Duplicate-key detection (checklist §6) — success path only, over
     text that has JUST strict-parsed, so it may assume a valid-JSON
     shape: mapStrings spans are exactly the string literals, brackets
     balance, and every object key is a "..." span. Counts, per object,
     how many DIRECT members repeat a key already seen in that same
     object — keys compare by DECODED value (JSON.parse of the key
     span), so "\u0061" and "a" are one key, and the same key in two
     different objects never counts. The return is the number of
     occurrences the JSON.stringify reserialization in fix() drops
     (native keep-last: last value wins, at the key's first position) —
     reported as a dupkeys change entry. No text surgery here: a removal
     pass could reorder keys relative to the parse and is not needed for
     "clean" output (§5.3). */
  function countDuplicateKeys(text) {
    var spans = mapStrings(text);
    var n = text.length;
    var total = 0;

    /** Span containing position i, or null (spans are sorted — the linear
        scan is the file's convention, cf. nextCodeChar). */
    function spanAt(i) {
      for (var k = 0; k < spans.length; k++) {
        if (i >= spans[k][0] && i < spans[k][1]) return spans[k];
        if (spans[k][0] > i) break;
      }
      return null;
    }

    function skipWs(p) {
      while (p < n && isWs(text.charAt(p))) p++;
      return p;
    }

    /** Position just past the value starting at p: one string span, a
        balanced container, or a scalar that in valid JSON can never
        contain , } ]. */
    function skipValue(p) {
      var sp = spanAt(p);
      if (sp) return sp[1];
      var c = text.charAt(p);
      if (c === '{' || c === '[') {
        var depth = 1;
        p++;
        while (depth > 0) {
          var s2 = spanAt(p);
          if (s2) { p = s2[1]; continue; }
          var d = text.charAt(p);
          if (d === '{' || d === '[') depth++;
          else if (d === '}' || d === ']') depth--;
          p++;
        }
        return p;
      }
      while (p < n) {
        var sc = text.charAt(p);
        if (sc === ',' || sc === '}' || sc === ']') break;
        p++;
      }
      return p;
    }

    /** The object whose '{' sits at openPos: visit its DIRECT members
        only (nested containers are skipped whole by skipValue) and count
        every direct key repeated within this object. Bails without
        counting when the shape is unexpected — unreachable on text that
        just strict-parsed, but it must never guess. */
    function countObject(openPos) {
      var seen = Object.create(null);
      var p = skipWs(openPos + 1);
      if (text.charAt(p) === '}') return; // empty object
      for (;;) {
        var sp = spanAt(p);
        if (!sp || text.charAt(p) !== '"') break;
        var key;
        try { key = JSON.parse(text.slice(p, sp[1])); } catch (err) { break; }
        p = skipWs(sp[1]);
        if (text.charAt(p) !== ':') break;
        p = skipValue(skipWs(p + 1));
        if (seen[key]) total++;
        else seen[key] = true;
        p = skipWs(p);
        if (text.charAt(p) !== ',') break; // '}' ends the object (valid JSON)
        p++;
      }
    }

    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : n;
      for (var i = gs; i < ge; i++) {
        if (text.charAt(i) === '{') countObject(i); // every object, at every depth — each counted once
      }
    }
    return total;
  }

  /* Permissive (JSON5-style) fallback parse (checklist §8.1). Recursive
     descent over the raw text, tolerating exactly four non-strict
     constructs — comments, trailing commas, single-quoted strings, and
     unquoted identifier keys — everything else stays strict JSON (JSON
     numbers, double-quoted strings, true/false/null, ONE top-level value,
     nothing after it). Every tolerance is meaning-preserving: comments are
     skipped, a trailing comma is dropped, 'x' decodes exactly like "x"
     under the JSON escape rules (\' collapses to '), and a bare key IS the
     identifier — so a successful parse re-serializes to unambiguous strict
     JSON with no guessing. Runs only after the repair pipeline failed, and
     only over the pre-processed ORIGINAL text (BOM/fence/prose stripped —
     passes 1-2, the safe ones; the surgical passes may have mangled their
     intermediate, which is discarded). Classic rescue: comments containing
     QUOTE characters, which start fake spans in mapStrings and defeat the
     span-based passes (header limitation, fixtures 67-69). Still rejected
     (clean failure): numeric keys { 1: 2 }, non-identifier key characters
     { my-key: 1 }, bare words in VALUE position, non-JSON numbers,
     unicode-only identifiers, multiple top-level values, trailing junk.
     Returns { ok:true, value, deviations } or { ok:false }; throws only on
     runaway recursion depth, which fix() catches as a failed fallback. */
  function permissiveParse(text) {
    var n = text.length;
    var p = 0;
    var deviations = 0;

    function fail(at) {
      var err = new Error('Permissive parse failed at position ' + (at == null ? p : at));
      err.pos = at == null ? p : at;
      throw err;
    }
    function ch(i) { return i < n ? text.charAt(i) : ''; }

    /** Skip whitespace AND comments (comments are one of the four
        tolerated constructs — counted). An unterminated block comment runs
        to end-of-text; the following value check then fails cleanly. */
    function ws() {
      while (p < n) {
        var c = ch(p);
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') p++;
        else if (c === '/' && ch(p + 1) === '/') {
          while (p < n && ch(p) !== '\n') p++;
          deviations++;
        }
        else if (c === '/' && ch(p + 1) === '*') {
          var q = text.indexOf('*/', p + 2);
          p = q === -1 ? n : q + 2;
          deviations++;
        }
        else break;
      }
    }

    /** One string: p sits on the opening quote; returns its decoded value.
        Double-quoted → decoded by JSON.parse of the exact span (strict
        JSON escape rules). Single-quoted → JSON5: same escapes, plus \'
        collapsing to ', with unescaped " left as content; re-wrapped and
        decoded by JSON.parse so the browser's own decoder stays the source
        of truth. Unterminated span or an escape JSON itself rejects
        (raw line terminator, bad escape pair) → fail. */
    function string(single) {
      var start = p;
      p++;
      var end = -1;
      while (p < n) {
        var c = ch(p);
        if (c === '\\') { p += 2; continue; }
        if (c === (single ? "'" : '"')) { end = p; break; }
        p++;
      }
      if (end === -1) fail(start);
      p = end + 1; // advance past the closing quote
      var value;
      try {
        if (!single) {
          value = JSON.parse(text.slice(start, end + 1));
        } else {
          var inner = '';
          for (var i = start + 1; i < end; i++) {
            var d = text.charAt(i);
            if (d === '\\') {
              var nx = text.charAt(i + 1);
              inner += (nx === "'") ? "'" : (d + nx);
              i++;
              continue;
            }
            inner += (d === '"') ? '\\"' : d;
          }
          value = JSON.parse('"' + inner + '"');
        }
      } catch (err) { fail(start); }
      if (single) deviations++;
      return value;
    }

    /** true | false | null — exact literal with a clean right boundary;
        any other bare word in VALUE position fails (no guess, header). */
    function wordValue() {
      var lits = ['true', 'false', 'null'];
      for (var k = 0; k < 3; k++) {
        if (text.substr(p, lits[k].length) === lits[k] && !isWordChar(ch(p + lits[k].length))) {
          p += lits[k].length;
          return lits[k] === 'true' ? true : (lits[k] === 'false' ? false : null);
        }
      }
      fail(p);
    }

    function number() {
      // Strict JSON number grammar only — pass 15's own classifier; the
      // fallback never REPAIRS numbers (that is a surgical-pass job).
      var t = scanNumberToken(text, p, n);
      if (!t.ok) fail(p);
      var v = Number(text.slice(p, t.end));
      p = t.end;
      return v;
    }

    /** A property name: "..." | '...' | an ASCII identifier (the same set
        pass 5 quotes). Digits do not start identifiers, so numeric keys
        fail clean — JSON5 agrees. */
    function key() {
      var c = ch(p);
      if (c === '"') return string(false);
      if (c === "'") return string(true);
      if (isWordChar(c) && !(c >= '0' && c <= '9')) {
        var s = p;
        while (p < n && isWordChar(ch(p))) p++;
        deviations++;
        return text.slice(s, p);
      }
      fail(p);
    }

    function value() {
      ws();
      var c = ch(p);
      if (c === '"') return string(false);
      if (c === "'") return string(true);
      if (c === '{') return obj();
      if (c === '[') return arr();
      if (c === '-' || (c >= '0' && c <= '9')) return number();
      if (isWordChar(c)) return wordValue();
      fail(p);
    }

    function obj() {
      var o = {};
      p++; // consume {
      ws();
      if (ch(p) === '}') { p++; return o; }
      for (;;) {
        ws();
        var k = key();
        ws();
        if (ch(p) !== ':') fail(p);
        p++;
        o[k] = value(); // duplicate keys: last wins, exactly native semantics
        ws();
        var c = ch(p);
        if (c === ',') {
          p++;
          ws();
          if (ch(p) === '}') { deviations++; p++; return o; } // trailing comma
          continue;
        }
        if (c === '}') { p++; return o; }
        fail(p);
      }
    }

    function arr() {
      var a = [];
      p++; // consume [
      ws();
      if (ch(p) === ']') { p++; return a; }
      for (;;) {
        a.push(value());
        ws();
        var c = ch(p);
        if (c === ',') {
          p++;
          ws();
          if (ch(p) === ']') { deviations++; p++; return a; } // trailing comma
          continue;
        }
        if (c === ']') { p++; return a; }
        fail(p);
      }
    }

    var v = value();
    ws();
    if (p !== n) fail(p); // trailing junk — strict like JSON.parse
    return { ok: true, value: v, deviations: deviations };
  }

  /** Pass 16 — Leading comma: drop a comma sitting directly after `[`
      (whitespace between is fine) within the SAME code region (§10). A
      comma there has no valid reading in any dialect we accept (JSON5
      rejects leading commas too), so deletion — never value invention —
      is the only meaning-preserving repair; the strict re-parse after
      every pass certifies it like all the others. The scan is
      region-local by design: nextCodeChar skips string spans, but
      `[ "x" , …]` has a VALUE between the [ and the comma and must not
      fire (a span in between means it is not a leading comma). Objects
      are deliberately out of scope — `{ , "a": 1 }` keeps its clean
      failure; fixture 74 pins that boundary. A mid-array empty element
      is always spelled with adjacent commas and is the §2.4
      duplicate-comma case, already covered by pass 10. */
  function passLeadingCommas(text) {
    var spans = mapStrings(text);
    var removeAt = [];
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        if (text.charAt(i) !== '[') continue;
        var j = i + 1;
        while (j < ge && isWs(text.charAt(j))) j++;
        if (j < ge && text.charAt(j) === ',') removeAt.push(j);
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
    return { text: out, changes: [{ key: 'leading', count: removeAt.length }] };
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
    passNumbers,         // 15 (checklist §5 — malformed number tokens: +5, 007, 5., .5)
    passInnerQuotes,     // 12 (checklist §4.4 — early by design: pass 9's D1 would rewrite its trigger shape)
    passDelimiters,      // 9 (checklist §2 — insert missing commas/colons, grammar-driven)
    passDuplicatePunct,  // 10 (checklist §2.4 — collapse duplicate ,, / :: separators)
    passUnterminatedStrings, // 13 (checklist §4.1 — before balance: the EOF-close must not land inside an open span)
    passEscCtrl,         // 14 (checklist §4.5 — after 13 so its trailing-ws trim sees raw chars)
    passBalanceBrackets, // 11 (checklist §3 — stray removal, mismatch swap/remove candidates, EOF close)
    passLeadingCommas    // 16 (checklist §10 — stray leading comma in arrays: `[ ,` → `[`)
  ];

  var LABELS = {
    normalize: function (c) { return c === 1 ? 'stripped 1 BOM/line-ending' : 'stripped ' + c + ' BOMs/line-endings'; },
    fence: function (c) { return c === 1 ? 'stripped 1 markdown code fence' : 'stripped ' + c + ' markdown code fences'; },
    prose: function (c) { return c === 1 ? 'removed 1 block of surrounding prose' : 'removed ' + c + ' blocks of surrounding prose'; },
    comments: function (c) { return c === 1 ? 'removed 1 comment' : 'removed ' + c + ' comments'; },
    quotes: function (c) { return c === 1 ? 'converted 1 single-quoted string' : 'converted ' + c + ' single-quoted strings'; },
    keys: function (c) { return c === 1 ? 'quoted 1 key' : 'quoted ' + c + ' keys'; },
    trailing: function (c) { return c === 1 ? 'removed 1 trailing comma' : 'removed ' + c + ' trailing commas'; },
    leading: function (c) { return c === 1 ? 'removed 1 stray leading comma' : 'removed ' + c + ' stray leading commas'; },
    quotefix: function (c) { return c === 1 ? 'corrected 1 mismatched closing quote' : 'corrected ' + c + ' mismatched closing quotes'; },
    jslit: function (c) { return c === 1 ? 'replaced 1 invalid literal' : 'replaced ' + c + ' invalid literals'; },
    pylit: function (c) { return c === 1 ? 'replaced 1 Python-style literal' : 'replaced ' + c + ' Python-style literals'; },
    number: function (c) { return c === 1 ? 'fixed 1 malformed number' : 'fixed ' + c + ' malformed numbers'; },
    comma: function (c) { return c === 1 ? 'inserted 1 missing comma' : 'inserted ' + c + ' missing commas'; },
    colon: function (c) { return c === 1 ? 'inserted 1 missing colon' : 'inserted ' + c + ' missing colons'; },
    dupcomma: function (c) { return c === 1 ? 'collapsed 1 duplicate comma' : 'collapsed ' + c + ' duplicate commas'; },
    dupcolon: function (c) { return c === 1 ? 'collapsed 1 duplicate colon' : 'collapsed ' + c + ' duplicate colons'; },
    stray: function (c) { return c === 1 ? 'removed 1 stray bracket' : 'removed ' + c + ' stray brackets'; },
    swapped: function (c) { return c === 1 ? 'corrected 1 mismatched bracket' : 'corrected ' + c + ' mismatched brackets'; },
    closed: function (c) { return c === 1 ? 'closed 1 open bracket' : 'closed ' + c + ' open brackets'; },
    innerquote: function (c) { return c === 1 ? 'escaped 1 unescaped inner quote' : 'escaped ' + c + ' unescaped inner quotes'; },
    strclose: function (c) { return c === 1 ? 'closed 1 unterminated string' : 'closed ' + c + ' unterminated strings'; },
    ctrl: function (c) { return c === 1 ? 'escaped 1 raw control character in a string' : 'escaped ' + c + ' raw control characters in strings'; },
    dupkeys: function (c) { return c === 1 ? 'removed 1 duplicate key' : 'removed ' + c + ' duplicate keys'; },
    json5: function (c) { return c === 1 ? 'tolerated 1 non-strict construct via the permissive (JSON5-style) fallback parse'
                                        : 'tolerated ' + c + ' non-strict constructs via the permissive (JSON5-style) fallback parse'; }
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

  /** Mismatched-closing-quote scan (checklist §11), run on the ORIGINAL
      failing text before any pass. For every double-quoted span, each '
      that is followed (past whitespace) by , } ] or EOF is a candidate
      closing quote; it yields two one-character repairs — swap it to "
      (the value ends there) or add a " after it (the apostrophe is data
      and its real closing quote is missing). Each repair is certified by
      a strict parse of the WHOLE text, so a legitimate multi-line string
      that merely contains an apostrophe can never be certified here and
      falls through to the normal pipeline untouched (§4.5, fixture 50 /
      77). fix() applies the repair when exactly one of all candidates
      parses (unique, parser-certified) and fails precisely — no guess —
      when two or more parse. Tests are capped (like pass 11) so a
      pathological document costs O(cap) parses. */
  var MAX_QUOTE_TESTS = 32;
  function findMismatchedQuotes(text) {
    var spans = mapStrings(text);
    var n = text.length;
    var parseable = []; // { pos, start, swapOk, insertOk }
    var tests = 0;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0], e = spans[k][1];
      if (text.charAt(s) !== '"') continue; // double-quoted opener only
      for (var p = s + 1; p < e; p++) {
        if (text.charAt(p) !== "'") continue;
        var j = p + 1;
        while (j < n && isWs(text.charAt(j))) j++;
        if (j < n) {
          var c = text.charAt(j);
          if (c !== ',' && c !== '}' && c !== ']') continue;
        }
        if (tests >= MAX_QUOTE_TESTS) break;
        tests += 2;
        var swapOk = attemptParse(text.slice(0, p) + '"' + text.slice(p + 1)).ok;
        var insertOk = attemptParse(text.slice(0, p + 1) + '"' + text.slice(p + 1)).ok;
        if (swapOk || insertOk) parseable.push({ pos: p, start: s + 1, swapOk: swapOk, insertOk: insertOk });
      }
      if (tests >= MAX_QUOTE_TESTS) break;
    }
    return parseable;
  }

  /** Short one-line preview of a string reading for the §11 report. */
  function quotePreview(text, from, to) {
    var v = text.slice(from, to).replace(/[\n\r\t]/g, ' ');
    return v.length > 24 ? v.slice(0, 24) + '…' : v;
  }

  /** Fix (repair) per §4: repaired output formatted at `indent`; status
      lists what was fixed; idempotent on valid input (0 changes). */
  function fix(text, indent) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, message: 'Input is empty — paste JSON first.' };
    }
    var current = text;
    var parsed = attemptParse(current);
    // §8.2 — the failure report anchors on the FIRST strict error of the
    // ORIGINAL input (coordinates must match what the user pasted, not a
    // pass-produced intermediate).
    var firstError = parsed.ok ? null : parsed.error;
    var changes = [];
    /* §11 — mismatched closing quote ("...'): decided BEFORE any pass
       runs, because the fake multi-line span this defect creates is
       exactly what lets the pipeline "succeed" with data swallowed.
       Exactly one parseable one-char repair → apply it and fall through
       to the normal success flow; two or more (both readings are valid
       JSON) → precise clean failure, no guess (§5.3). */
    if (!parsed.ok) {
      var mq = findMismatchedQuotes(text);
      var mqOk = 0;
      for (var q = 0; q < mq.length; q++) mqOk += (mq[q].swapOk ? 1 : 0) + (mq[q].insertOk ? 1 : 0);
      if (mqOk === 1) {
        var mqHit = null;
        for (var q2 = 0; q2 < mq.length; q2++) {
          if (mq[q2].swapOk || mq[q2].insertOk) { mqHit = mq[q2]; break; }
        }
        current = mqHit.swapOk
          ? text.slice(0, mqHit.pos) + '"' + text.slice(mqHit.pos + 1)
          : text.slice(0, mqHit.pos + 1) + '"' + text.slice(mqHit.pos + 1);
        changes.push({ key: 'quotefix', count: 1 });
        parsed = attemptParse(current); // certified ok by construction
      } else if (mqOk > 1) {
        var pcQ = lineColOf(text, mq[0].pos);
        var sv = quotePreview(text, mq[0].start, mq[0].pos);
        var iv = quotePreview(text, mq[0].start, mq[0].pos + 1);
        return {
          ok: false,
          output: text,
          message: '✗ Mismatched quote at line ' + pcQ.line + ', column ' + pcQ.col +
                   ' — this string opens with " but is closed by \'. ' +
                   (mqOk === 2 ? 'Two one-character repairs both give valid JSON' : mqOk + ' one-character repairs give valid JSON') +
                   ': end the value there (\'' + sv + '\') or keep the apostrophe and add the missing closing quote (\'' + iv + '\'). ' +
                   'I can\'t tell which value you meant, so I won\'t guess. Fix that one character, then re-run.' +
                   '\n' + contextSnippet(text, { line: pcQ.line, col: pcQ.col, pos: mq[0].pos }),
          changes: []
        };
      }
    }
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
      // §6 — duplicate object keys: the reserialization below already
      // dedupes them natively (keep-last); count how many occurrences
      // drop so the user sees it. `current` is exactly the text that
      // just strict-parsed, which countDuplicateKeys requires.
      var dupKeys = countDuplicateKeys(current);
      if (dupKeys) changes.push({ key: 'dupkeys', count: dupKeys });
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

    /* §8.1 — permissive fallback, one shot: over the pre-processed
       ORIGINAL text (safe passes 1-2 only — the surgical passes may have
       mangled `current`, which is discarded; a recovery must read the
       user's document, not the wreckage). Never reached on valid input
       (§5.3); a throw (runaway recursion) counts as a failed fallback. */
    var fbChanges = [];
    var pre = passNormalize(text);
    if (pre.changes.length) fbChanges = fbChanges.concat(pre.changes);
    pre = passWrapper(pre.text);
    if (pre.changes.length) fbChanges = fbChanges.concat(pre.changes);
    var pp = { ok: false };
    try { pp = permissiveParse(pre.text); } catch (err) { pp = { ok: false }; }
    if (pp.ok) {
      fbChanges.push({ key: 'json5', count: pp.deviations });
      var fSpace = indent;
      if (!(typeof fSpace === 'string' || (typeof fSpace === 'number' && fSpace > 0))) fSpace = 2;
      var fEdits = totalEdits(fbChanges);
      return {
        ok: true,
        output: JSON.stringify(pp.value, null, fSpace),
        message: '🔧 Fixed ' + fbChanges.length + (fbChanges.length === 1 ? ' issue: ' : ' issues: ') +
                 changePhrases(fbChanges) + ' (' + fEdits + (fEdits === 1 ? ' edit' : ' edits') + ').',
        changes: fbChanges
      };
    }

    /* §8.2 — clean failure with the exact location and a context snippet,
       so the user can fix it by hand (best-effort repaired text stays in
       `output`; the snippet reads the ORIGINAL input it cites). */
    var phrases = changePhrases(changes);
    var pc = parseErrorPosition(text, firstError);
    return {
      ok: false,
      output: current,
      message: '✗ Could not fully fix — ' + errorDetail(text, firstError) + '.' +
               (phrases ? ' Repaired so far: ' + phrases + '.' : ' No safe repair matched.') +
               ' The permissive (JSON5-style) fallback parse failed too.' +
               '\n' + contextSnippet(text, pc),
      changes: changes
    };
  }

  root.JSONBFFFix = {
    fix: fix,
    // Scanner internals exposed for tests (§5.1 names them as the API):
    _internal: { mapStrings: mapStrings, transformOutsideSpans: transformOutsideSpans }
  };
})(typeof window !== 'undefined' ? window : globalThis);
