# JSON BFF — Implementation Plan

**JSON BFF – Beautify, Format, Fix** — a free, in-browser JSON tool to validate, beautify, repair, and compact JSON. Static site → GitHub Pages, AdSense-ready, zero dependencies.

Target user: developers & data folks who paste JSON copied from APIs or logs, often broken (trailing commas, single quotes, missing brackets), and want it fixed fast without installing anything.

---

## 1. Goals & constraints

| # | Constraint | Why |
|---|-----------|-----|
| 1 | Pure static site: HTML + CSS + vanilla JS, no build step, no framework, no CDN libraries | Hosts on GitHub Pages as-is; zero-latency start; portable to any host later |
| 2 | All JSON processing happens client-side in the browser (no app network calls) | Privacy selling point ("nothing is uploaded"), fast, works offline |
| 3 | AdSense-ready: clearly marked ad script + slot placeholders | Monetization from day one once approved |
| 4 | No `package.json`/npm dependencies | Keeps deployment = "push to main" forever; migration path stays trivial |
| 5 | SEO-first: meaningful title/description, JSON-LD schema, robots.txt, sitemap | Goal is organic Google traffic |
| 6 | Mobile-friendly single page | Google mobile-first indexing; share links land on phones |

Non-goals (for now): user accounts, server code, localStorage history, syntax highlighting (plain-text output keeps zero deps), i18n.

---

## 2. File structure (final repo layout)

```
JSONBFF/
├── index.html            # Single-page app, ad slots, SEO tags
├── about.html            # Content page: what JSON BFF is, how-to, FAQ (SEO + AdSense "real content" requirement)
├── privacy.html          # Short privacy policy (required for AdSense approval)
├── 404.html              # Simple not-found with link home
├── robots.txt
├── sitemap.xml           # Generated once final URL (gh-pages or custom domain) is known
├── ads.txt               # Added after AdSense approval
├── .nojekyll             # Tells GitHub Pages to serve files as-is
├── README.md
├── JSONBFF-PLAN.md       # This file
├── css/
│   └── style.css         # Two-pane layout, toolbar, responsive rules
└── js/
    ├── app.js            # UI wiring: buttons, status bar, copy/download/share, ?json= prefill
    ├── formatter.js      # validate / format / compact + line/col error reporting
    ├── fixer.js          # Repair pipeline (string-aware scanner + transform passes)
    └── tests/
        ├── run-tests.js  # Plain Node test runner (zero deps), run: node js/tests/run-tests.js
        └── fixtures/     # broken-input → expected-output cases
```

Scripts load in `index.html` via plain `<script src="js/formatter.js">` etc. (no ES modules) so the site also works from `file://` and from any static host. The test runner loads these same files with `fs` + Node `vm`, so browser files run unmodified under Node — no packaging layer, ever.

---

## 3. UI design (modeled on jsonformatter.org / jsonbeautify.com)

Single page, top to bottom:

```
┌──────────────────────────────────────────────────────────┐
│ [logo] JSON BFF — Beautify, Format, Fix          [About] │
│  ┌──────────── ad slot (responsive, max ~90px) ─────────┐ │
├──────────────────────────────────────────────────────────┤
│ Toolbar: [Validate] [Format] [Fix] [Compact]      [Clear]│
│          Indent: ( 2sp | 4sp | Tab )                        │
├───────────────────────┬──────────────────────────────────┤
│ INPUT textarea            │ OUTPUT (read-only <pre>)      │
│ (spellcheck off, mono)    │ [Copy] [Download .json] [Share]│
├───────────────────────────┴──────────────────────────────┤
│ Status bar: ✓ Valid · 12 objects   |  ✗ Error at line 4, │
│             column 7: ...      |  🔧 Fixed 3 issues: …   │
├──────────────────────────────────────────────────────────┤
│ Footer: privacy line + links — optional ad slot           │
└──────────────────────────────────────────────────────────┘
```

- Left pane: `<textarea id="json-input" spellcheck="false">`, monospace font, horizontal scroll (no wrap).
- Right pane: `<pre id="json-output"><code>` in a scrollable container (read-only; plain text keeps us dependency-free).
- Buttons: **Validate / Format / Fix / Compact** are the primary actions (Format styled as default/primary); **Clear** on the right.
- Indent selector: 2 spaces (default), 4 spaces, tab.
- Status bar: single line, color-coded green/red/amber. For Fix it lists what was repaired (e.g. "removed trailing commas ×2, closed 1 bracket, quoted 3 keys").
- First load: input prefilled with a small **broken** sample so a visitor immediately sees Fix working; placeholder text explains where to paste.
- Mobile (<768px): panes stack vertically; toolbar wraps.
- Accessibility: `aria-label`s on buttons, textarea labeled "JSON input", status bar `aria-live="polite"`, contrast ≥ 4.5:1, visible focus outlines.

---

## 4. Behavior specs

### Validate
- Attempt `JSON.parse(input)`.
- Success → status: `✓ Valid JSON` (+ size in bytes).
- Failure → status: `✗ Invalid — <error message> at line L, column C (position P)`.
- Line/col extraction: V8 SyntaxError messages include either `position P` or `line N column M` — parse both with regex; fallback computes line/col from the character offset by counting newlines.

### Format (beautify)
- `JSON.stringify(JSON.parse(input), null, indent)` with the selected indent.
- If invalid: show the error in status; do NOT clobber the output pane with garbage — keep last good output and hint "use Fix".

### Compact
- `JSON.stringify(JSON.parse(input))` — no whitespace. Status shows size delta ("1,204 → 318 bytes").

### Fix (repair)
- Run the repair pipeline from §5 on the raw input.
- Success → output the repaired JSON **formatted** at the current indent; status: `🔧 Fixed — N changes: …` listing each transform with counts.
- Failure (unrecoverable) → best effort: show the remaining parse error in status and leave the best-effort text in the output so the user can copy near-valid JSON.
- Fix must be **idempotent**: running Fix on already-valid JSON changes nothing (beyond re-formatting) and reports 0 changes.

### Global behaviors
- **Ctrl/Cmd+Enter** = Format.
- **Share link**: button copies URL `?json=<URL-encoded input>`; on load, if the param exists, prefill input and auto-run Format (Fix if it fails). Keep inputs under ~50 KB for the share feature — above that, disable the Share button with a tooltip.
- **Copy**: `navigator.clipboard.writeText` with `execCommand('copy')` fallback.
- **Download**: Blob download named `json-formatted.json`.
- No persistence: never write to localStorage (privacy + simplicity).

---

## 5. Repair pipeline (`js/fixer.js`) — the core feature

### 5.1 Architecture
One shared string-aware scanner; transforms act only outside string literals, so JSON content containing `//`, `#`, or bracket-like text is never mangled.

```
mapStrings(text)            → array of [start, end) spans for every quoted string (handles escapes; supports ' and " delimiters)
transformOutsideSpans(text, spans, fn)
                            → applies fn only to non-string regions, rebuilding text with string spans preserved byte-for-byte
```

Passes run in a fixed order; after **each** pass attempt `JSON.parse` and stop at the first success. Every applied change is recorded as `{pass, count}` and becomes the "what we fixed" report. If the input is valid before any pass runs: return it with 0 changes immediately.

### 5.2 Passes (in order)
1. **Normalize** — strip UTF-8 BOM, convert `\r\n`/`\r` → `\n`.
2. **Strip comments** — `//…` to end-of-line and `/* … */` (multi-line), outside string spans only.
3. **Single quotes → double** — for each single-quoted span: switch delimiters to `"` and escape any inner `"`.
4. **Quote unquoted keys** — regex outside spans: `([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)` → `$1"$2"$3`. (Only keys directly after `{` or `,` — safe heuristic for JS-object-style input.)
5. **Trailing commas** — drop a comma when the next non-whitespace character outside spans is `}` or `]`.
6. **Invalid literals → null** — whole-word, outside spans: `NaN`, `Infinity`, `-Infinity`, `undefined` → `null`.
7. **Python/other literals** — whole-word, outside spans: `True`→`true`, `False`→`false`, `None`→`null`.
8. **Balance brackets** — scan outside spans, maintain a stack of open `{`/`[`; push openers, pop on matching closers (a closer with no matching opener is removed and logged as "removed stray bracket"); at end-of-text, append the missing closers in reverse order. This recovers the most common real-world breakage: unclosed brackets.
9. *(Stretch)* **Insert missing commas** — with the scanner, detect a value-end (outside spans) immediately followed by a new member (`key:` or `[`/`{`) where a comma belongs → insert `,`. If this pass cannot be made provably safe on valid input, drop it and rely on clear error reporting — never ship a pass that corrupts valid JSON.

### 5.3 Hard rules
- A transform that changes the meaning of **valid** input is a bug. Fixtures must include valid JSON with tricky strings (URLs containing `//`, brackets and quotes inside strings, escaped chars) where expected output is byte-identical modulo re-formatting.
- Unrecoverable input: report the remaining parse error **plus** which passes already applied, so the user sees progress.

### 5.4 Test suite (`js/tests/`)
Plain Node script, zero dependencies: reads every file in `fixtures/`, each fixture is JSON-ish `{ "name", "input", "expected" }` (`input` may contain invalid JSON — it's just a string field). Runner calls `fix(input)`, compares to `expected` via `JSON.parse` + `util.isDeepStrictEqual`, prints a pass/fail summary, exits non-zero on failure.

Minimum fixture set:
- already-valid (with tricky strings) → unchanged, 0 fixes
- trailing commas (multiple levels)
- single quotes (incl. doubles nested inside singles and vice versa)
- unquoted keys
- line + block comments (incl. a string value containing `//`)
- missing closing bracket (nested) and missing closing brace
- `NaN` / `undefined` / `Infinity` values
- Python `True` / `False` / `None`
- BOM + CRLF input
- the "disaster": several of the above combined in one document
- empty input and whitespace-only input → handled gracefully (no crash, clean status)
- non-JSON garbage (`hello world`) → clean failure report, no crash

---

## 6. `index.html` specifics

- `<title>`: `JSON BFF — Beautify, Format & Fix JSON Online (Free, In-Browser)`
- `<meta name="description">` (~155 chars, natural keywords): "Free online JSON tool to validate, format/beautify, repair broken JSON (trailing commas, missing brackets, single quotes) and compact it — all in your browser, nothing uploaded."
- `canonical` link: absolute URL of the page (update once final domain is known).
- Open Graph + Twitter Card tags (title, description, type=website, url).
- **JSON-LD** `WebApplication` schema: name, description, `applicationCategory: "DeveloperApplication"`, offers with price 0, `operatingSystem: "Any (web browser)"`.
- **AdSense placeholder** (clearly marked for post-approval drop-in):

```html
<!-- ADSENSE — replace ca-pub-XXXXXXXXXXXXXXXX with your publisher ID after approval -->
<script async
  src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXXXXXXXX"
  crossorigin="anonymous"></script>
```

  Slots: one responsive `<ins class="adsbygoogle">` under the header (max-height ~90px), one above the footer. Wrap both in `#ad-header` / `#ad-footer` divs so they can be hidden via CSS while testing locally.
- Footer line: "100% client-side — your JSON never leaves this page." + links to About and Privacy.
- `about.html`: ~700–900 words of genuine content — what JSON is, what BFF means, when to use each button, common breakage scenarios as an FAQ, privacy statement, browser support. This serves SEO **and** AdSense's "meaningful content" policy (a tool page with no prose risks rejection as thin content).
- `privacy.html`: short policy — no data collection, everything client-side; ads served by Google may set cookies per their policy.

## 7. SEO & AdSense checklist

- [x] `robots.txt` — allow all + `Sitemap: <absolute>/sitemap.xml`
- [x] `sitemap.xml` — index.html, about.html, privacy.html (regenerate if custom domain added)
- [ ] `ads.txt` after approval: `google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0`
- [x] `404.html` (GitHub Pages serves it automatically for unknown paths)
- [ ] After deploy: verify site in Google Search Console, submit sitemap, request indexing
- [ ] Submit site to AdSense with the About + Privacy pages live

## 8. Deploy on GitHub Pages

1. Push repo → `github.com/<user>/JSONBFF`, branch `main`.
2. Settings → Pages → Build and deployment → Source: **Deploy from a branch** → branch `main`, folder `/ (root)` → Save.
3. Site goes live at `https://<user>.github.io/JSONBFF/` (project site — hence relative paths `css/…`, `js/…` everywhere).
4. Optional custom domain: add a `CNAME` file, point DNS (CNAME `<user>.github.io` or A records to GitHub Pages IPs), Settings → Pages → Custom domain → Enforce HTTPS.
5. Once the final URL is known: regenerate `sitemap.xml`, set `canonical`/OG URLs; re-verify in Search Console.

**Status 2026-09-09:** custom domain live — site now served at **https://chris-pardue.com/JSONBFF/** (`chris-pardue.com`, GitHub Pages custom domain behind a Cloudflare proxy); `cpardue.github.io/JSONBFF/` 301-redirects there. Step 5 complete: `sitemap.xml` regenerated + robots.txt `Sitemap:` line, and every page's `canonical`/`og:url`/JSON-LD `url` point at the production URL (README live URL updated to match).

## 9. Migration path to full hosting (only if traffic justifies it)

- **Drop-in**: the exact same folder deploys unchanged to Netlify, Vercel, Cloudflare Pages, S3+CloudFront, nginx — no build step exists and all paths are relative.
- **If a backend ever becomes necessary** (server-side share links, API endpoint for other apps): `formatter.js`/`fixer.js` are pure functions with zero DOM access by design → importable by a Node server as-is; add the server in a new `server/` folder without touching the static site.
- **Analytics**: GA4 `gtag` placeholder marked with a second comment block next to the AdSense script, same "fill in after approval" pattern.

## 10. Implementation steps (execute in this order)

**Step 1 — Scaffold.** Create file structure per §2. `index.html` skeleton with layout, buttons, ad placeholders, SEO tags; `style.css` two-pane + toolbar + responsive; `app.js` wiring with stub handlers. *Check: open index.html via file:// → layout renders, buttons clickable, no console errors.*
**Step 2 — formatter.js.** Implement validate/format/compact + line/col extraction per §4; wire to UI. *Check: valid JSON formats at all indent options; invalid JSON reports correct line/column on known-broken samples.*
**Step 3 — fixer.js.** Build scanner (§5.1) + passes 1–8, write `tests/run-tests.js` and all §5.4 fixtures; wire the Fix button with the fixes report. *Check: `node js/tests/run-tests.js` green; the "disaster" fixture fully repaired.*
**Step 4 — UX polish.** Share link (`?json=`), Copy, Download, Clear, Ctrl+Enter, prefilled broken sample, status bar detail, mobile check at 375px. *Check: share URL round-trips (copy → open in new tab → prefilled + auto-run).* *(Done 2026-09-08: `?json=` prefill + auto Format/Fix, ~50 KB Share cap with disable+tooltip, broken-sample prefill, richer status strings; app.js smoke checks in run-tests.js cover the round-trip — the live browser pass stays a step-6 check.)*
**Step 5 — SEO & content pages.** about.html (~700 words), privacy.html, robots.txt, sitemap.xml (placeholder domain OK for now), 404.html, .nojekyll. *Check: no broken internal links; both pages render from file:// and over http.* *(Done 2026-09-08: about.html (~850 words + FAQPage JSON-LD) and privacy.html with per-page SEO heads, canonical/OG, hidden pre-approval ad slots (own slot IDs); robots.txt + sitemap.xml at the project-site URL; noindex 404.html; .nojekyll; run-tests.js gains a "static pages & links" section enforcing the step's no-broken-internal-links check. Live browser + Lighthouse pass remains a step-6 check.)*
**Step 6 — Verify & ship.** Run test suite; open in Chrome + Firefox; Lighthouse (Performance ≥ 90, no CLS on load); fix findings. Then deploy per §8 and smoke-test the live URL including /404.html, robots.txt, sitemap.xml. *(Done 2026-09-09 — all checks passed. Test suite 40/40 re-run; `node --check` clean on all JS. Zero-console pass in Chrome (headless Chrome for Testing 153, isolated profile) from `file://` (index/about/privacy) and live https (index/about/privacy/404.html): zero console errors/warnings, zero exceptions, no failed requests, no HTTP ≥400 — including the fix for a real DoD violation found on the live site: missing `favicon.ico` (HTTP 404 + console error on every load) replaced by an inline SVG data-URI favicon on all four pages. Lighthouse mobile on production: Performance 98 / Accessibility 100 / SEO 100, CLS 0, LCP 2.0 s, TBT 90 ms (all ≥90 thresholds met). 375 px viewport: panes stack, no horizontal overflow; 1280 px: side-by-side. Live smoke test re-run on the custom domain: /, about.html, privacy.html, 404.html, robots.txt, sitemap.xml all correct; pushed files verified byte-exact vs local (SHA-1) after each push. Note: no Firefox in the dev environment — a user spot-check of that half of the zero-console DoD item remains recommended.)*
**Step 7 — WebMCP.** `js/webmcp.js` + fake-modelContext tests done 2026-09-08; remaining work is deploy-time only (origin trial for the final origin + token meta), per the §12 checklist.

## 11. Definition of done

- [x] Zero console errors in Chrome, from both file:// and https (headless Chrome for Testing 153, all four pages, 2026-09-09); no Firefox in dev env — user spot-check recommended
- [x] `node js/tests/run-tests.js` passes (all §5.4 fixtures)
- [x] All four buttons behave per §4; Fix is idempotent on valid input (run-tests.js app smoke + re-fix/idempotency fixtures)
- [x] No external dependencies other than the AdSense/GA scripts
- [x] Mobile viewport (375px) works with stacked layout (CDP geometry check 2026-09-09: stacked, no horizontal overflow; side-by-side at 1280px)
- [x] Lighthouse: Performance ≥ 90, Accessibility ≥ 90, SEO ≥ 90 (mobile on production, 2026-09-09: 98 / 100 / 100, CLS 0)
- [x] Deployed to GitHub Pages; live smoke test of /, about.html, privacy.html, 404.html, robots.txt, sitemap.xml passes (re-verified on custom domain chris-pardue.com/JSONBFF/, 2026-09-09)

## 12. WebMCP — agent-facing tools (investigated 2026-09-08)

**Verdict: integrable — cheap progressive enhancement, zero conflict with §1 constraints.**

Findings (spec: W3C WebML CG "WebMCP Draft Community Group Report" of 2026-09-04; Chrome docs rev. 2026-09-01; repo `webmachinelearning/webmcp`):
- API: `document.modelContext.registerTool({ name, description, inputSchema, execute }, { exposedTo? })` — object form, **plain JSON Schema** (Zod not required → zero-dep compatible). Also `unregisterTool`, `getTools()`, page-side `executeTool()` with AbortSignal, `toolchange` event.
- Browser support (Sept 2026): Chrome 149 / Edge 150 **origin trials** (production origins need an origin-scoped token meta tag); local dev via `about:flags#enable-webmcp-testing`; Brave Leo experimental; **ChatGPT Desktop ships with WebMCP support**; Firefox/Safari have standards positions only, no implementation.
- Gated by the `tools` Permissions Policy (default `self`): top-level page registration allowed — a GitHub Pages project site is fine; cross-origin iframes would need `allow="tools"` (not used here). API disabled if `document.domain` is set (not used).
- Chrome docs position WebMCP explicitly as "progressive enhancement" — feature detection is the expected pattern.

Integration design (step 7 — code implemented 2026-09-08; origin-trial meta tag stays commented until deploy per §8):
- Add `js/webmcp.js` (~60 lines, zero deps), loaded after formatter.js/fixer.js. Guard: `typeof document !== 'undefined' && document.modelContext` → silent no-op everywhere else (Firefox/Safari/file://) so the §11 zero-console-errors DoD holds. Register four tools wrapping the existing pure functions: `json_validate {text}`, `json_format {text, indent?}`, `json_compact {text}`, `json_fix {text, indent?}`; handlers return small JSON result objects (reuse the §4 status strings) and cap input at ~50 KB (spec mitigation: restrict max input lengths).
- `index.html`: commented Origin Trial `<meta http-equiv="OriginTrial">` placeholder next to the AdSense block — same "fill in after approval" pattern. **Token is origin-scoped: moving to a custom domain requires requesting a token for that origin** (or both at request time). Tokens expire (~6 months) — renew at deploy.
- `run-tests.js` covers it without a browser: loads webmcp.js bare (must no-op silently) and against a fake document.modelContext that captures + executes the 4 tools. Manual test in a real agent-capable browser: Chrome + origin trial/flag, and/or the "Model Context Tool Inspector" extension.

Risks & notes:
- Spec is a draft CG report — the API already changed once (navigator→document, positional→object form). Keep all coupling inside webmcp.js so future churn is a one-file change.
- Current real-world reach is small (origin trials + ChatGPT Desktop); value = future-proofing for agent-driven traffic, and it reinforces the "nothing leaves your browser" story (agent calls run in-page).
- Security: no consequential actions, read/transform-only tools, no new data flow; keep tool descriptions/output free of instruction-like text (prompt-injection hygiene per spec §6).

**Deploy-time WebMCP checklist (no code changes — run after §8):**
1. Join the Chrome/Edge origin trial and request a token for the production origin **https://chris-pardue.com** (custom domain live 2026-09-09 — §8; cpardue.github.io now 301s there, so browsers land on the chris-pardue.com origin and no github.io token is needed). Tokens are origin-scoped and expire (~6 months) — renew on expiry or any domain change.
2. Uncomment the `<meta http-equiv="OriginTrial" content="…">` placeholder in `index.html`'s `<head>` and paste the token (the head comment block in the file explains this step), then commit + push.
3. Verify via the Model Context Tool Inspector extension or DevTools: `document.modelContext.getTools()` should list all four `json_*` tools; optionally execute one through the inspector (e.g. `json_fix` on a trailing-comma string) to confirm end-to-end behavior.
