# JSON BFF — Beautify, Format, Fix

Free, in-browser JSON toolkit: **validate**, **format/beautify**, **fix** broken JSON, and **compact** it — no sign-up, no uploads, 100% client-side.

> **Status:** ✅ steps 1–5 of the build plan complete (core app + tests + SEO content); deploy to GitHub Pages in progress ([plan §10 step 6](./JSONBFF-PLAN.md)). Full plan: [`JSONBFF-PLAN.md`](./JSONBFF-PLAN.md).

## What it does

- **Validate** — check whether your JSON parses, with the exact line & column of any error
- **Format** — pretty-print with 2-space, 4-space, or tab indentation
- **Fix** — auto-repair common breakage: trailing commas, single quotes, unquoted keys, comments, missing/unclosed brackets, `NaN`/`undefined`, Python-style literals… and report exactly what it changed
- **Compact** — minify to a single line, with the byte-size delta

Extras: share links (`?json=…`, capped at ~50 KB with a tooltip), copy / download `.json`, `Ctrl/Cmd+Enter` = Format. Works from `file://` and any static host — no build step.

## Why static?

One-page vanilla HTML/CSS/JS — **no build step, no server, no dependencies**. That means:

- today it hosts on GitHub Pages (push → live), with AdSense-ready ad slots
- tomorrow it deploys unchanged to Netlify/Vercel/Cloudflare Pages/any static host if traffic grows
- the formatter/fixer modules are pure functions, so a backend can be added later without a rewrite

## Quick start

```bash
# Option 1 — just open it in a browser (no server needed)
start index.html   # Windows
open index.html    # macOS / Linux

# Option 2 — serve locally (optional)
npx serve .
```

## Tests (zero-dep, plain Node)

```bash
node js/tests/run-tests.js
# → 40/40 checks passed
```

Coverage: repair-pipeline fixtures (valid-with-tricky-strings, trailing commas, single quotes, unquoted keys, comments, missing brackets, JS/Python literals, BOM+CRLF, the "disaster", empty/garbage input), UI smoke checks via a minimal fake DOM (prefill, share round-trip, `Ctrl+Enter`, 50 KB cap), static page/link checks (robots.txt, sitemap.xml, .nojekyll, no broken internal links), and WebMCP tool registration against a fake `document.modelContext`.

## Repository layout

```
index.html            # single-page app, SEO tags, ad slots, WebMCP origin-trial placeholder
about.html            # SEO + AdSense "meaningful content" page (with FAQ)
privacy.html          # privacy policy
404.html  robots.txt  sitemap.xml  .nojekyll
css/style.css         # two-pane layout, toolbar, responsive rules
js/formatter.js       # validate / format / compact + line/col error reporting
js/fixer.js           # repair pipeline (string-aware scanner + ordered passes)
js/webmcp.js          # WebMCP agent tools (silent no-op where unsupported)
js/app.js             # UI wiring: buttons, status bar, copy/download/share, ?json= prefill
js/tests/             # zero-dep Node test runner + fixtures
```

## WebMCP (agent-facing tools)

`js/webmcp.js` exposes `json_validate`, `json_format`, `json_compact`, and `json_fix` as [WebMCP](https://github.com/webmachinelearning/webmcp) tools for agent-capable browsers (Chrome/Edge origin trials, ChatGPT Desktop). It is a silent no-op everywhere the API is absent — pure progressive enhancement. The origin-trial `<meta>` token goes into `index.html` after deploy (checklist: plan §12).

## Deploy (GitHub Pages)

Settings → **Pages** → Build and deployment → *Deploy from a branch* → `main` / root → live at <https://cpardue.github.io/JSONBFF/>. Details incl. custom domain in [the plan, §8](./JSONBFF-PLAN.md).

## Roadmap

- [x] Repo + implementation plan
- [x] Core app: Validate / Format / Fix / Compact
- [x] Zero-dep test suite (40 checks)
- [x] SEO content (About, Privacy) + AdSense slots wired (placeholder IDs until approval)
- [x] WebMCP agent tools (progressive enhancement)
- [ ] Deploy to GitHub Pages + live smoke test (plan §10 step 6)
- [ ] AdSense approval → drop in real `ca-pub-ID` + `ads.txt`
- [ ] Custom domain + Google Search Console + WebMCP origin-trial token

## Privacy

Everything runs in your browser. Your JSON is never uploaded anywhere. Share links encode the input in the URL — only share data you're comfortable putting in a link.