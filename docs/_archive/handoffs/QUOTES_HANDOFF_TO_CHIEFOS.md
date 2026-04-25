# Quotes Handoff to ChiefOS

Engineering handoff from the `mission-quote-standalone` proof-of-concept to the ChiefOS production build. This document is the single source of truth for what was built, what worked, and what must be redesigned before the Quotes spine ships inside the real product.

Generated: 2026-04-18.
Repo root (absolute path): `C:\Users\scott\Documents\mission-quote-standalone`
ChiefOS repo root (for reference only — do **not** touch from this session): `C:\Users\scott\Documents\Sherpa AI\Chief`

---

## 1. Purpose and Scope

### What this standalone was built for
A throwaway microsite to close one real customer: **Darlene MacDonald**, an exterior-renovation prospect of **Mission Exteriors** in Komoka, ON. The owner-operator (Scott Jutras) needed a mobile-friendly, brand-appropriate quote-and-contract flow delivered via a link he could send the customer the same evening. The ChiefOS Quotes spine did not yet exist, and the timeline did not allow for a proper build. This standalone was designed to test customer-facing UX assumptions and get a signature in the next 24–48 hours — nothing more.

### What was validated in the field
- The customer opened the link on a mobile device (iOS Safari).
- She entered her name, ticked the acceptance checkbox, signed with her finger on a touchscreen canvas, and tapped Accept & Sign.
- On sign completion, a Postmark email landed in Scott's inbox containing the signer name, total, doc hash, IP, user-agent, and the signature PNG as an attachment.
- The customer downloaded the signed agreement as a PDF via `window.print()` → iOS share sheet → Save to Files.
- **Outcome**: job closed.

### Approximate time-to-sign
Unknown with precision from this session. Authoritative sources:
- **Postmark Activity** (dashboard → server → Activity) — definitive send timestamps per signature event.
- **Vercel function logs** (project: `mission-quote-standalone`, filter for `[QUOTE-SIGNED]`) — IP, UA, `signedAt`, `receivedAt`. Hobby retention ≈1 hour; Pro retention ≈1 day. If the original sign happened in the last day it is still retrievable; otherwise treat as lost.

### What this standalone is NOT
- Not a ChiefOS record. No `tenant_id`, no `owner_id`, no `user_id`, no RLS.
- Not durable. Signatures are logged to stdout and emailed; there is no database.
- Not immutable. The "signed" state machine is client-side only and resets on tab refresh.
- Not governed by CIL (Canonical Ingress Layer). There is no Ingress → CIL Draft → Validation → Domain Mutation chain. The sign POST writes directly to Postmark and the log stream.
- Not the canonical financial spine. Totals are derived client-side from a hardcoded JSON object in `lib/quotes.js`.
- No versioning, no audit events, no idempotency.
- No customer portal, no secondary visit flow — the URL is the entire experience.
- No auth; the slug is the only access control.

### Retirement statement
This standalone **is being retired**. The production Quotes, Contracts, Change Orders, and Customer Receipts spine will be built natively inside ChiefOS under the Engineering Constitution, Beta Delta Appendix, and dual-boundary identity model. This document is reference-only. Do not port files wholesale; the visual and UX output should be preserved, the plumbing must be rebuilt.

---

## 2. The Customer Experience That Worked

### Delivery
Scott sent Darlene the stable URL via direct message (text/WhatsApp — exact channel not recorded):

```
https://mission-quote-standalone.vercel.app/q/darlene-macdonald-komoka
```

There was no email send, no intake form, no account creation. She tapped the link directly.

### What she saw on mobile (iOS Safari, iPhone)
1. Page loaded at a fixed virtual viewport of 860 CSS pixels, scaled by Safari to fit the physical display (~45% on a 390px iPhone). This was a deliberate choice: the document's paper-like 820px-wide layout could not be made responsive within the timeline. Scaling the whole document as if it were a PDF preserved the visual design exactly.
2. Toolbar at top: status pill (`Viewed`), Print button, Download PDF button. Status automatically transitioned `sent → viewed` on mount.
3. Three stacked `<Page>` cards, each bound by a subtle shadow:
   - **Page 1 — Agreement**: Header band with Mission Exteriors logo (navy/red gradient on top edge) + "Agreement" title + quote ID. Billed To (customer) and From (tenant) blocks. Project scope paragraph. Line items table (`#`, title + details bullets, amount). Totals panel: subtotal, HST 13%, total, deposit, balance on completion. Payment method strip. Page footer.
   - **Page 2 — Warranty Coverage**: Intro paragraph + three `WarrantyBlock`s (55-yr panel, 40-yr paint, automatic base steel) + workmanship warranty section + exclusions bulleted list.
   - **Page 3 — Terms & Acceptance**: Clauses 1–8 (Scope, Payment, Changes, Materials & Substitutions, Access & Site Conditions, Warranty, Insurance, Governing Law). Signature block at bottom with text input (legal name), acceptance checkbox, and the `<SignaturePad>` trigger (a dashed box labeled "Tap to sign").
4. She filled in her name, ticked the checkbox, and tapped the dashed "Tap to sign" box.

### The signature modal
Tapping "Tap to sign" mounted `<SignatureModal>` — a `position: fixed; inset: 0; z-index: 9999` full-screen overlay with a dark navy backdrop. The modal:
- Removes the `width=860` viewport meta from `<head>` and appends a fresh `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no` meta so the canvas renders at native phone resolution instead of the scaled-down 45%.
- Renders a white canvas filling ~80% of the phone screen with a faint "× Customer signature" guide line.
- Listens to `touchstart`/`touchmove`/`touchend` **via `addEventListener({ passive: false })`** (not React synthetic events — React attaches touch listeners as passive, which causes `preventDefault()` to be silently ignored, which causes the page to scroll instead of drawing).
- Sets `touch-action: none` on both the modal container and the canvas.
- Scales the 2D context by `window.devicePixelRatio` so the signature is crisp on retina displays.
- Exposes Cancel / Clear / **Accept & sign** buttons at the bottom.

Darlene signed with her finger. Tapping **Accept & sign** did:
1. `capturedRef.current = true` (used by cleanup to decide viewport restore behavior).
2. `canvas.toDataURL("image/png")` → PNG data URL.
3. `onCapture(dataUrl)` fires up to the parent.
4. Modal unmounts. Cleanup does **not** restore viewport to `width=860` (a deliberate workaround for an iOS Safari bug where dynamic viewport reverts don't reliably trigger layout reflow). Instead the viewport is left at `width=device-width, initial-scale=1` — because the confirmation page is designed for device-width and the customer never returns to the 860-width doc on screen.

### The post-sign confirmation
The component re-renders with `signature` set. A `<SignedConfirmation>` overlay (`position: fixed; inset: 0; z-index: 50; className="signed-confirmation no-print"`) covers the agreement on screen. It is mobile-native at device-width and contains:
- Green check circle.
- "Thank you, {signerName}" in Fraunces serif.
- Short paragraph: next steps (Scott will reach out about deposit and scheduling).
- Summary card: `Document`, `Total (incl. HST)`, `Deposit due`, `Signed` timestamp, and a `hash xxxxxxxxxxxxxxxx` monospace line.
- The captured signature PNG rendered via `<img>`.
- **Download signed agreement** button — swaps viewport temporarily to `width=860`, waits 120ms for Safari to re-layout, calls `window.print()`, then restores viewport after a 600ms delay.
- Mission Exteriors contact footer.

The agreement is still in the DOM behind the overlay. `@media print` hides `.signed-confirmation` and `.no-print`, leaving the full 3-page agreement to become the PDF.

### The email-on-sign notification
Server-side on the `/api/sign/[slug]` endpoint, after logging the record, a Postmark `sendEmail` fires with:
- `From`: `scott@usechiefos.com` (domain-verified sender signature).
- `To`: `scott@scottjutras.com` (default, overridable via `NOTIFY_EMAIL` env var).
- `Subject`: `[Mission Exteriors] {signerName} signed {quoteId}`.
- `TextBody`: signer, timestamps, total, doc hash, IP, UA, view URL.
- `Attachments`: the signature PNG as `{slug}-signature.png`.
- `MessageStream`: `"outbound"` (Postmark transactional default).

If Postmark is not configured or fails, the sign response still returns `{ ok: true }` — the log line `[QUOTE-SIGNED] {...}` is the fallback record.

### iOS Safari quirks encountered
1. **Passive touch listeners**: React's synthetic `onTouchStart`/`onTouchMove` handlers cannot `preventDefault()` because React attaches them as passive. Finger draw caused the page to scroll instead of drawing ink. **Fix**: native `addEventListener(..., { passive: false })` + `touch-action: none`.
2. **Viewport meta mutation caching**: Mutating the `content` attribute of the existing `<meta name="viewport">` tag often does not trigger a re-layout on iOS. **Fix**: remove the existing meta element and append a new one. Each `appendChild` is treated as a fresh directive.
3. **Viewport restore bug**: Even with the remove-and-append pattern, restoring `width=860` after the signature modal closed reliably failed to reflow iOS Safari — the document stayed at device-width (squished). **Fix / sidestep**: do not return the customer to the agreement view at all. Post-sign, render the confirmation at device-width; only the `Download PDF` action temporarily swaps viewport for the print snapshot.
4. **`window.print()` on iOS Safari** uses the current rendered page and current viewport. If `width=device-width` is active when print is called, the resulting PDF is the squished layout. **Fix**: the Download button in the confirmation swaps viewport to `width=860` before calling `window.print()`.

### Print-to-PDF quirks encountered
- `@media print` in a `<style>` tag inside the React render works. The rules applied: `.no-print { display: none }`, `.signed-confirmation { display: none }`, `.chiefos-page { box-shadow: none; margin: 0 }`, `body { background: white }`.
- Base64-embedded logo prints cleanly at any resolution (no external fetch, no broken image on print).
- The 3-page `<Page>` sectioning relies on top-level fixed `maxWidth: 820` + `margin: 0 auto 24px` — each Page renders as its own stacked card on screen and as visually continuous content on print. **No explicit `page-break-before`/`page-break-after` rules are set.** Each printer/viewer decides page breaks. This has not caused visible problems in the field flow tested, but it is a latent issue: long warranty content on Page 2 could wrap awkwardly on A4 vs. Letter.

---

## 3. Visual and Brand Design Decisions

### Typography
Loaded once via Google Fonts `@import url(...)` at the top of the component's inline `<style>`:
- **Fraunces** (display/serif) — weights 400/500/600/700, optical sizing 9–144. Used for `h1/h2/h3` (Agreement title, section headings).
- **Inter** (body sans) — weights 400/500/600. Default body text.
- **JetBrains Mono** (metadata/monospace) — weights 400/500/600. Uppercase labels, doc IDs, hashes, the "× Customer signature" line.

CSS class hooks applied to the doc root:
```css
.chiefos-doc { font-family: 'Inter', system-ui, sans-serif; color: #1A1A1A; }
.chiefos-doc h1, h2, h3 { font-family: 'Fraunces', Georgia, serif; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.serif { font-family: 'Fraunces', Georgia, serif; }
```

### Color palette (`BRAND` constant at `components/QuoteContract.jsx:19-29`)

```js
const BRAND = {
  navy:     "#1B2B4A",
  navyDeep: "#0F1C36",
  red:      "#D42E3C",
  redDeep:  "#A52028",
  paper:    "#FAF8F4",
  ink:      "#1A1A1A",
  muted:    "#6B6B6B",
  rule:     "#E6E2D9",
  soft:     "#F2EEE5",
};
```

Usage:
- `navy` — headings, accent text, HST badge border, status pill fg for sent/viewed.
- `navyDeep` — gradient end on header band, signature pen stroke (`strokeStyle = navyDeep`), locked-status pill background.
- `red` — primary button background (Accept & sign, Download PDF), HST badge background, acceptance checkbox accent.
- `paper` — background for signed signature block.
- `ink` — default text color.
- `muted` — secondary labels, metadata, mono small text.
- `rule` — horizontal rules, table borders, subtle separators.
- `soft` — page background behind the stacked `<Page>` cards (doc-surrounding wash).

Status pill color mapping (`components/QuoteContract.jsx:644-650`):
```js
draft:  { bg: "#EEE",        fg: BRAND.ink   }
sent:   { bg: BRAND.soft,    fg: BRAND.navy  }
viewed: { bg: "#E8F0FF",     fg: BRAND.navy  }
signed: { bg: "#E7F3E9",     fg: "#1F5A2A"   }
locked: { bg: BRAND.navyDeep, fg: "#fff"     }
```

### Logo handling
The Mission Exteriors brand mark is a base64-encoded JPEG embedded directly in the JS bundle at `components/QuoteContract.jsx:33-34` as `const MISSION_LOGO_SRC = "data:image/jpeg;base64,..."` (a single long string, ~117 KB of source text before gzip, ~60 KB compiled into the route bundle).

Rationale: the component is fully self-contained (no asset fetch, no broken images on print, no CDN dependency). This inflates the `/q/[slug]` route JS bundle to 60.1 KB / First Load 147 KB but is acceptable for a single-document microsite.

The logo is rendered by a tiny `MissionLogo` helper:
```jsx
const MissionLogo = ({ height = 52 }) => (
  <img src={MISSION_LOGO_SRC} style={{ height, width: "auto", display: "block" }} />
);
```

Called with `height={64}` in the Page 1 header (`components/QuoteContract.jsx` ~line 820).

**For ChiefOS**: do not embed logos as base64. Store tenant brand marks in Supabase Storage (or the tenant's own hosted asset) and serve via a signed URL or a trusted CDN. Pre-compute dimensions at upload time so the printable layout doesn't jump.

### Page layout structure
Three logical pages, each a `<Page>` wrapper (`maxWidth: 820, margin: 0 auto 24px, background: #fff, boxShadow: 0 10px 40px rgba(15,28,54,0.1), overflow: hidden`). Stacked vertically on screen; `@media print` strips the shadow and margin.

- **Page 1 — Agreement**: Header band (8px navy gradient strip) → logo + "Agreement" title + quote ID → Billed To / From two-column → Project scope → Line items (zebra-striped, col widths 42 / flex / 130) → Totals panel → Payment method strip → Page foot (`1 / 3`).
- **Page 2 — Warranty Coverage**: "Section II" chapter header → intro paragraph → three `<WarrantyBlock term termUnit title body>` cards → Installation Warranty (10-yr workmanship) paragraph → Exclusions bulleted list → warranty instrument reference → Page foot (`2 / 3`).
- **Page 3 — Terms & Acceptance**: "Section III" chapter header → 8 numbered `<Clause n title>children</Clause>` blocks (Scope, Payment, Changes, Materials & Substitutions, Access & Site Conditions, Warranty, Insurance, Governing Law) → Signature block (`2px solid red` pre-sign, `2px solid navy` post-sign) with name input, acceptance checkbox, `<SignaturePad>`; post-sign it swaps to two stacked signature lines (customer + contractor counter-signature) → Page foot (`3 / 3`).

### Print-safe styles (`components/QuoteContract.jsx:748-753`)
```css
@media print {
  .no-print            { display: none !important; }
  .signed-confirmation { display: none !important; }
  .chiefos-page        { box-shadow: none !important; margin: 0 !important; }
  body                 { background: white !important; }
}
```

What gets the `.no-print` class: the top toolbar (status pill, Print, Download PDF), the blue "This is a live document…" helper banner on the first visit, the interactive pre-sign form widgets.

### Signature canvas dimensions
- CSS size: `width: 100%; height: 100%` within a flex-1 modal container at padding 16, so effectively `(100vw - 32) × (100vh - header/buttons)` at device-width viewport. Typical iPhone: ~358 × ~500 CSS px.
- Drawing buffer: `canvas.width = rect.width * dpr; canvas.height = rect.height * dpr` — e.g. on a DPR-3 iPhone, internal buffer is ~1074 × ~1500 device pixels.
- Stroke: `lineWidth = 2.5`, `lineCap = round`, `lineJoin = round`, `strokeStyle = BRAND.navyDeep (#0F1C36)`.
- Captured as PNG via `canvas.toDataURL("image/png")`. Typical captured size: 10–40 KB base64.

---

## 4. Data Shape (Quote Payload)

All quote data lives in a hardcoded JS object exported from `lib/quotes.js`. There is no database. The shape is essentially a single typed document; it is what the ChiefOS migration must honor (with the caveat that the identity/audit fields are missing and must be added).

### JSDoc-style interface

```js
/**
 * @typedef {Object} Quote
 * @property {string}  slug       Non-guessable URL slug. Acts as sole access token.
 * @property {string}  id         Human-facing quote number, e.g. "QT-2026-0414-0119".
 * @property {number}  version    Integer. Incremented only by re-issuance (never in current impl).
 * @property {string}  issuedAt   ISO date, e.g. "2026-04-18".
 * @property {"draft"|"sent"|"viewed"|"signed"|"locked"} status
 * @property {Tenant}    tenant
 * @property {Customer}  customer
 * @property {Project}   project
 * @property {LineItem[]} lineItems
 * @property {Payment}   payment
 * @property {number}    hstRate  Decimal (0.13 for Ontario HST).
 */

/** @typedef Tenant
 * @property {string} legalName   e.g. "9839429 Canada Inc."
 * @property {string} brandName   e.g. "Mission Exteriors"
 * @property {string} contact     Primary human contact name.
 * @property {string} address
 * @property {string} phone
 * @property {string} email
 * @property {string} web
 * @property {string} hst         CRA HST registration number.
 */

/** @typedef Customer
 * @property {string} name
 * @property {string} address
 * @property {string} phone
 * @property {string} email
 */

/** @typedef Project
 * @property {string} title   Displayed on Page 1 as project subtitle.
 * @property {string} scope   1-paragraph scope summary (shown above line items).
 */

/** @typedef LineItem
 * @property {number|string} id   "1", "2", ... "8a", "8b". Rendered with padStart(2, "0").
 * @property {string}        title
 * @property {string[]}      details  Bulleted sub-items under the title.
 * @property {number}        amount   CAD, pre-HST.
 */

/** @typedef Payment
 * @property {number} deposit     CAD, upfront to schedule.
 * @property {string} etransfer   Email address for e-transfer.
 * @property {string} cheque      Payable-to name.
 */
```

### Where each field renders
| Field | UI location |
|---|---|
| `quote.id` | Page 1 header (right side under "Agreement"), Page 1 billed-to footer line, Page 3 signature block ("Document:" line), confirmation summary card |
| `quote.version` | "v{version}" appended to `quote.id` in the two mono labels |
| `quote.issuedAt` | Page 1 header meta line and billed-to block |
| `quote.status` | Status pill in toolbar (screen only) |
| `quote.tenant.*` | Page 1 "From" block, page footers (`brandName`, `legalName`, `hst`), confirmation footer |
| `quote.customer.*` | Page 1 "Billed To" block |
| `quote.project.title` | Page 1 project subtitle |
| `quote.project.scope` | Page 1 scope paragraph above line items |
| `quote.lineItems[i].{id, title, details, amount}` | Line items table, Page 1 |
| `quote.payment.deposit` | Page 1 totals panel (Deposit), Page 3 Clause 2 (Payment) |
| `quote.payment.etransfer` | Page 1 payment strip, Page 3 Clause 2 |
| `quote.payment.cheque` | Page 1 payment strip, Page 3 Clause 2 |
| `quote.hstRate` | HST calculation only (not displayed as a rate; shown as a line in the totals) |

### Totals calculation
All derived; no totals are stored. Computed once per render at `components/QuoteContract.jsx:684-689`:
```js
const subtotal = quote.lineItems.reduce((s, i) => s + i.amount, 0);
const hst      = subtotal * quote.hstRate;
const total    = subtotal + hst;
const balance  = total - quote.payment.deposit;
```

Currency formatting: a module-level `fmt()` helper (`components/QuoteContract.jsx:46-51`) using `Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2 })`.

Rounding: relies on JavaScript floating-point arithmetic; `toLocaleString` formats to 2 decimals but the raw `total` value is an unrounded float. For the current dataset this produces `$39,797.0858` → formatted `$39,797.09`. **The POST payload sends `total` as the raw float.** The ChiefOS build must use a decimal type or integer cents everywhere.

### Warranty content block
**Static in the component source**, not per-quote. See `components/QuoteContract.jsx:1136-1165` for the three `<WarrantyBlock>` invocations (55-yr panel transferable, 40-yr paint Beckers/BeckryTech, automatic base steel G90/275 g/m²) and lines 1170-1240 for the 10-year workmanship warranty paragraph and exclusions list.

For ChiefOS, warranty content must be per-tenant (and potentially per-product family), stored as editable rich text alongside the quote template, not embedded in the document component source.

### Tenant HST badge
Rendered as a small red-on-navy monospace badge inside the "From" block at Page 1 (~line 910). Content: `HST # 759884893RT0001`. Hardcoded wording but dynamic value from `quote.tenant.hst`.

---

## 5. Signature Capture Implementation

Implementation lives entirely in `components/QuoteContract.jsx`:
- **Trigger** — `SignaturePad({ onCapture, disabled })` at ~line 71. Renders a dashed box "Tap to sign" with a "× Customer signature" line. On click (when not disabled), mounts `<SignatureModal>`.
- **Modal** — `SignatureModal({ onClose, onCapture })` at ~line 127.

### Canvas element and DPR scaling
Canvas is CSS-sized via flex within the modal's padded `position: fixed` container. Logical size ≈ `(viewportWidth - 32) × (viewportHeight - ~120)`. On mount, an effect reads `canvas.getBoundingClientRect()` and sets:
```js
const dpr = window.devicePixelRatio || 1;
canvas.width  = rect.width  * dpr;
canvas.height = rect.height * dpr;
canvas.getContext("2d").scale(dpr, dpr);
```
Stroke style: `lineWidth = 2.5`, `lineCap = round`, `lineJoin = round`, `strokeStyle = BRAND.navyDeep (#0F1C36)`.

### Touch event handling
Attached with `addEventListener(type, handler, { passive: false })` on the canvas element. **This is critical — React synthetic touch handlers are passive and will silently fail `preventDefault()`, causing the page to scroll instead of drawing.**

```js
canvas.addEventListener("touchstart",  start, { passive: false });
canvas.addEventListener("touchmove",   move,  { passive: false });
canvas.addEventListener("touchend",    end);
canvas.addEventListener("touchcancel", end);
canvas.addEventListener("mousedown",   start);
canvas.addEventListener("mousemove",   move);
canvas.addEventListener("mouseup",     end);
canvas.addEventListener("mouseleave",  end);
```

Handler logic:
- `start(e)`: `e.preventDefault()`, `drawing = true`, record last position (`clientX - rect.left`, `clientY - rect.top`).
- `move(e)`: if drawing, `e.preventDefault()`, stroke a line from `last` to current pos, update `last`, set `hasInk = true`.
- `end()`: `drawing = false; last = null`.

### Mouse event handling
Same handlers as touch (coordinates derived from `e.clientX/Y` the same way). Works on desktop browsers for testing.

### `touch-action: none`
Applied inline on both the modal container div and the canvas element. This instructs the browser not to hijack touches for pan/zoom/scroll gestures. In combination with non-passive listeners and `preventDefault`, this is what makes mobile signing feel native.

### Clear and commit
- `clearCanvas()` — clears the full drawing buffer via `ctx.clearRect(0, 0, canvas.width, canvas.height)` and sets `hasInk = false`. Button disabled while `!hasInk`.
- `commit()` — if `!hasInk` returns early (no-op). Else: `capturedRef.current = true` (used by the viewport-restore cleanup), then `onCapture(canvas.toDataURL("image/png"))`. The wrapper `SignaturePad` closes the modal and calls the parent's `onCapture` (ultimately `handleSign`).

### Captured PNG format
`data:image/png;base64,iVBOR...` — a standard PNG data URL. When forwarded to the sign endpoint, the route strips the `data:image/\w+;base64,` prefix and attaches the raw base64 bytes to Postmark as `image/png`.

### Accessibility gaps
- No keyboard equivalent for signing (no type-your-name fallback).
- No `<canvas role="img">` or `aria-label` describing what the control does — screen-reader users will hear nothing meaningful.
- Color contrast on the disabled-button state is borderline (#C9C9C9 on white).
- No explicit instructions for assistive-tech users on how to capture a signature.

These were not addressed in the standalone. ChiefOS should provide at minimum a typed-signature fallback and proper ARIA labeling.

---

## 6. State Machine (What Was Implemented)

### States in use
String literal field `quote.status`, initialized from the data file:
- `draft` — not used in flight; defined in the status pill map but no quote ships with this status.
- `sent` — initial seed value for Darlene's quote in `lib/quotes.js`.
- `viewed` — transitioned to on mount via `useEffect(() => { if (status === "sent") setStatus("viewed") }, [])` at `components/QuoteContract.jsx:691-694`. Purely a client-side visual change to the status pill.
- `signed` — set in `handleSign` at line 711 immediately after the PNG is captured and the hash is computed.
- `locked` — set via `setTimeout(() => setStatus("locked"), 600)` at line 712. A cosmetic transition — nothing server-enforced.

### Transitions
```
sent  --(mount)-->          viewed
viewed --(handleSign)-->    signed
signed --(600ms timeout)--> locked
```

All transitions are `setState` calls in the browser. Refreshing the tab after signing **resets to `viewed`** because there is no persistence. This is fine for the single-use flow (customer never refreshes after seeing the confirmation) but is a hard blocker for ChiefOS.

### Client-side SHA-256 hash computation
`sha256Short(text)` at `components/QuoteContract.jsx:53-65`. Uses `crypto.subtle.digest("SHA-256", ...)` on the Web Crypto API, hex-encodes, returns the **first 16 hex chars** (a 64-bit truncation).

Input payload (constructed in `handleSign` at line 700-706):
```js
const payload = JSON.stringify({
  quoteId: quote.id,
  version: quote.version,
  total,
  signer: signerName,
  ts: now,
});
```

Output: a 16-char hex string (e.g. `"9f2c8a71e3b4d052"`) stored in local state as `docHash` and sent to the server in the sign POST.

### What was NOT implemented
- **Server-authoritative hashing.** The hash is trusted verbatim from the client. A tampered payload → tampered hash → no way to detect.
- **Canonical document serialization.** The payload hashed is only 5 high-level fields; the line items, warranty text, and clause content are not part of the hash. Changing the line items after signing would not change the doc hash.
- **Immutability enforcement.** Nothing prevents a second POST to `/api/sign/[slug]` after a first has succeeded. Nothing prevents editing `lib/quotes.js` (which is static at build time) and redeploying — a future deploy would render a different document under the same slug.
- **Versioning.** The `quote.version` field is `1` and there is no mechanism to bump it or to preserve v1 when v2 is issued.
- **Audit trail.** No events persisted. The Postmark email is the only durable artifact.

### The signature record POSTed on sign
From client (`components/QuoteContract.jsx:718-725`):
```js
{
  signerName,           // string, from the text input
  signedAt,             // ISO-8601 string, client wall clock
  signatureDataUrl,     // string "data:image/png;base64,..."
  docHash,              // string, 16 hex chars
  total,                // number, float CAD
}
```

Server augments to (`app/api/sign/[slug]/route.js:78-89`):
```js
{
  slug,                 // URL param
  quoteId,              // from quote data
  receivedAt,           // ISO-8601, server wall clock
  ip,                   // x-forwarded-for header or "unknown"
  userAgent,            // user-agent header or "unknown"
  signerName,
  signedAt,
  docHash,
  total,
  signatureBytes,       // length of signatureDataUrl string (proxy for size)
}
```

This is the exact line that `console.log`s with the `[QUOTE-SIGNED]` prefix.

---

## 7. API Routes Built

### `POST /api/sign/[slug]`
- **File**: `app/api/sign/[slug]/route.js`
- **Runtime**: `"nodejs"` (explicit `export const runtime = "nodejs"` at line 6; required because the Postmark SDK uses Node primitives).
- **Request payload**: see §6 "signature record POSTed on sign".
- **Response payload**:
  - `200 { "ok": true,  "receivedAt": "2026-04-17T00:27:39.235Z" }` on success.
  - `404 { "ok": false, "error": "unknown slug" }` if the slug isn't in `QUOTES`.
  - `400 { "ok": false, "error": "invalid json" }` if the body isn't JSON.
- **Persistence**:
  - `console.log("[QUOTE-SIGNED]", JSON.stringify(record))` — written to stdout, captured by Vercel function logs (ephemeral retention).
  - Optional HTTP POST to `process.env.SIGN_WEBHOOK_URL` if set. Was never configured in production.
  - Postmark `sendEmail` to `NOTIFY_EMAIL` (default `scott@scottjutras.com`) if `POSTMARK_SERVER_TOKEN` and `POSTMARK_FROM_EMAIL` are both present.
- **Error handling**: the webhook call and Postmark call are independently `try/catch`ed and **do not** fail the request. If Postmark throws, the response is still `200 ok:true`; the error is `console.error`'d. This is deliberate — the customer sign should never visibly fail because of a third-party mail outage.

### `GET /q/[slug]`
- **File**: `app/q/[slug]/page.jsx`
- **Runtime**: default (Edge or Node depending on Next resolution; `export const dynamic = "force-dynamic"` forces per-request rendering).
- **Behavior**: calls `getQuote(params.slug)`. If null → `notFound()` → 404 page. Else renders `<QuoteContract quote={quote} />`.
- **Metadata**: `generateMetadata` sets title to `"{brandName} — Quote for {customerName}"` and `robots: { index: false, follow: false }`.

### `GET /`
- **File**: `app/page.jsx`
- Calls `notFound()` unconditionally → 404.

### `GET /<anything-else>`
- Handled by `app/not-found.jsx`, a minimal styled 404 page instructing the visitor to contact Mission Exteriors.

---

## 8. Email / Notification Flow

### Service
**Postmark** — https://postmarkapp.com. Chosen over Resend for deliverability (transactional inbox placement). SDK: `postmark` (`package.json` pins `^4.0.7`).

### Sender and receiver
- `From`: `process.env.POSTMARK_FROM_EMAIL` — in production, `scott@usechiefos.com`. The `usechiefos.com` domain is a verified Postmark Sender Signature (domain-level DKIM/SPF), so any `*@usechiefos.com` is a valid From.
- `To`: `process.env.NOTIFY_EMAIL || "scott@scottjutras.com"`. **Scott (the contractor) is the only recipient.** The customer does not receive an email copy of the signed agreement — she downloads the PDF directly.

### Template
Plain-text body (no HTML template, no Postmark templates API). Assembled inline in `notifyPostmark()` at `app/api/sign/[slug]/route.js:30-44`:
```
Signed quote: QT-2026-0414-0119 (v1)
Customer:     Darlene MacDonald
Project:      119 St Lawrence Ave, Komoka, ON

Signer:       Darlene MacDonald
Signed at:    2026-04-16, 8:57:41 p.m. (America/Toronto)
Total:        $39,797.09
Doc hash:     9f2c8a71e3b4d052

IP:           203.0.113.42
User-Agent:   Mozilla/5.0 (iPhone; ...)

View: https://mission-quote-standalone.vercel.app/q/darlene-macdonald-komoka
```

Subject: `[Mission Exteriors] {signerName} signed {quoteId}`.

### Attachment
The captured signature PNG, attached as `{slug}-signature.png` (e.g. `darlene-macdonald-komoka-signature.png`). The base64 data URL is stripped of the `data:image/*;base64,` prefix and passed as raw base64 to Postmark's `Attachments[].Content` field.

### Required env vars
| Var | Purpose | Required? |
|---|---|---|
| `POSTMARK_SERVER_TOKEN` | Server API token (per Postmark "Server") | Yes for email |
| `POSTMARK_FROM_EMAIL`   | Verified sender address                  | Yes for email |
| `NOTIFY_EMAIL`          | Notification recipient                   | Optional (default `scott@scottjutras.com`) |
| `SIGN_WEBHOOK_URL`      | Optional HTTP webhook to fan out the record | Optional, never set in prod |

All are set in the Vercel project (`mission-quote-standalone`) under Environment Variables for `production` / `preview` / `development`.

**For ChiefOS**: the same Postmark server/token can be reused — it comingles the Activity log for both projects. If clean separation is needed, create a new Postmark "Server" and point ChiefOS at its token.

---

## 9. Deployment Configuration

### Vercel project
- **Project name**: `mission-quote-standalone`
- **Project ID**: `prj_ja8pbGWdiEodhlP02vr0yO7qDxrH`
- **Team (org) ID**: `team_QP4aDTwCG7iQ7msRhEggbi6r` (`scott-jutras-projects`)
- **Framework preset**: Next.js (auto-detected).
- **Build command**: `next build` (default).
- **Install command**: `npm install` (default).
- **Output directory**: Next.js default (`.next`).
- **Root directory**: repo root.

### URLs
- **Stable production alias**: `https://mission-quote-standalone.vercel.app`
- **Team-scoped production alias**: `https://mission-quote-standalone-scott-jutras-projects.vercel.app`
- **Username-scoped production alias**: `https://mission-quote-standalone-scottjutras-scott-jutras-projects.vercel.app`
- **Per-deploy immutable URL**: e.g. `https://mission-quote-standalone-l1qvye36o-scott-jutras-projects.vercel.app` (latest).
- **Customer URL**: `https://mission-quote-standalone.vercel.app/q/darlene-macdonald-komoka`

No custom domain (`quote.usechiefos.com` etc.) was configured.

### Deployment Protection
**Disabled**. New projects under this team ship with Vercel SSO protection on by default — the first `vercel --prod --yes` produced a 401 login wall. Disabled via one-shot API call:

```
PATCH https://api.vercel.com/v9/projects/{projectId}?teamId={teamId}
Authorization: Bearer {cli-token}
Content-Type: application/json

{"ssoProtection": null}
```

CLI has no equivalent subcommand. Dashboard path: Project → Settings → Deployment Protection → Vercel Authentication → Disabled.

### `vercel.json`
**None.** All settings are either Next.js auto-detect or dashboard-configured.

### Build settings
- Next.js `14.2.15`.
- React `18.3.1`.
- React strict mode: on (`next.config.js`).
- Node runtime on the sign route (explicit).

### Environment variables (production)
Listed via `GET /v9/projects/{projectId}/env`:
- `POSTMARK_SERVER_TOKEN` — encrypted, all three environments.
- `POSTMARK_FROM_EMAIL` — `scott@usechiefos.com`, encrypted, all three environments.

`NOTIFY_EMAIL` and `SIGN_WEBHOOK_URL` not set.

### Repo/git
Initialized from scratch in the project folder, one local `master` branch. **Not pushed to GitHub.** Commits live only on disk and in Vercel's deployment archive. 12 commits from `deda1e7` (Initial quote standalone) to `1bf9d9c` (Update quote: scope tweaks, Fascia $2460, Siding 8a $2980, issued 2026-04-18).

---

## 10. What Worked Well and What Didn't

### Worked better than expected
- **Postmark end-to-end first try** — sender verified in ~1 min via domain DNS, first test send delivered, attachment rendered inline in the email.
- **Base64 logo embed** — no image-loading edge cases across devices, no broken PDF, no CDN dependency. ~60 KB bundle cost.
- **`window.print()` → iOS share sheet → Save to Files as PDF** — worked on iOS without any `@react-pdf/renderer` or server-side rendering. Zero-dependency path.
- **Viewport-swap modal pattern** — swapping viewport from `width=860` to `width=device-width` for the signature modal only gave native-resolution signing inside a paper-layout document. Unconventional but effective.
- **Client-side 16-char SHA-256 hash** — enough of a visual tamper-evident signal to make the signed page feel authoritative. Cheap, no server dependencies. (Note: it is not actually tamper-evident — see Gap Analysis.)

### Caused friction
- **React synthetic touch event passive-listener bug** — hours lost diagnosing "finger touch scrolls the page instead of drawing." Fix required native `addEventListener({ passive: false })`. The existence of this bug is barely documented in the React ecosystem.
- **iOS Safari viewport-restore caching** — when the modal closed, restoring to `width=860` frequently failed to trigger reflow, leaving the document squished. Tried three fixes (mutate content string, two-step set with RAF, remove-and-re-append); only the remove-and-re-append pattern kind-of worked, and even then restoration on sign was unreliable. Ultimately sidestepped by redesigning the post-sign flow to never return the user to the 860-wide document.
- **Vercel Deployment Protection on by default** — silent 401 on every URL after first deploy. Not mentioned in the CLI output. Lost 5 minutes figuring out why the customer URL needed auth.
- **Base64 logo string in source control** — a single ~117 KB line bloats diffs and grep results. Worth keeping out of git in the production build.

### Bugs found during the Darlene flow (and fixed)
1. **Mobile-squished document** — initial viewport was `width=device-width`; doc at fixed 820 width overflowed right. Fixed by changing to `width=860, initial-scale=1` (commit `6926be0`).
2. **Finger signing hijacked by scroll** — fixed by rewriting signature pad to use native listeners with `passive: false` inside a full-screen modal (commit `7d538f2`).
3. **iOS viewport not restoring on modal close** — sidestepped by rendering a device-width confirmation overlay post-sign (commit `c5c3647`), and having Download PDF do its own scoped viewport swap.

### UX feedback from Darlene
None explicitly captured. She signed and the job closed — interpret as a thumbs-up for the path that shipped, but we have no knowledge of friction moments she pushed through.

### Preserve in the ChiefOS build
- Three-page paper document metaphor (Agreement / Warranty / Terms & Acceptance).
- Full-screen signature modal at device-native resolution.
- Post-sign confirmation screen that replaces the agreement on mobile (never let the customer bounce back to a squished 860 layout).
- Email notification to the contractor on sign, with the signature PNG attached.
- Client-side SHA-256 hash displayed on the signed doc as a tamper-evident visual signal (but back it with a server hash for actual integrity — see §11).
- Typography: Fraunces + Inter + JetBrains Mono.
- Brand-level color system via a single `BRAND` constant consumed by inline styles.
- `@media print` + `window.print()` for PDF export — good enough for v1, preserves brand fidelity.

### Replace or improve in the ChiefOS build
- **Everything identity-related.** Add `tenant_id`, `owner_id`, `user_id` and gate visibility via Supabase RLS.
- **Persistence.** Store quotes, line items, warranty content, signatures, audit events in Supabase. Drop the hardcoded `lib/quotes.js`.
- **Server-side hash + lock.** Hash on the server at sign time, over a canonical serialization of the full document (line items, warranty block, clause text, not just 5 top-level fields).
- **Versioning.** Locked signed docs must be immutable. Edits fork a new version.
- **Idempotency.** `(owner_id, source_msg_id, kind)` on ingress; sign POST must be idempotent on `(quote_id, version)`.
- **CIL compliance.** Sign POST is the hot path — it must go through Ingress → CIL Draft → Validation → Domain Mutation instead of short-circuiting straight to email.
- **Token-based URL access.** Replace slug-as-secret with a signed, expiring, single-purpose token per recipient.
- **Audit event emission.** `quote.sent`, `quote.viewed`, `quote.signed`, `quote.locked` etc. emitted and persisted.
- **Typed-signature fallback + ARIA.** Accessibility basics.
- **Customer-side email** with the signed agreement PDF attached, not just the contractor-side notification.
- **WhatsApp delivery** as the primary channel (per ChiefOS product direction), with email as fallback.
- **Template editability.** Warranty and clause content editable per tenant, not hardcoded in JSX.

---

## 11. Gap Analysis: Standalone vs ChiefOS-Native

| Concern | Standalone Implementation | ChiefOS Requirement |
|---|---|---|
| **Identity** | No `tenant_id`, no `owner_id`, no `user_id`. No RLS. | Dual-boundary: `tenant_id` (uuid) on every row for RLS; `owner_id` (digits/phone) for ingestion keying; `user_id` (digits) for actor attribution. All three present on Quote, LineItem, Signature, AuditEvent. |
| **Storage** | Quote data is a hardcoded JS object in `lib/quotes.js`. Signature record is `console.log` + email. | Supabase PG with RLS: `chiefos_quotes`, `chiefos_quote_line_items`, `chiefos_quote_signatures`, `chiefos_quote_events`, tenant-scoped. Financial totals are part of the canonical spine and reconcile with invoices/receipts. |
| **Hash** | Client-side `sha256Short` over 5 top-level fields, truncated to 16 hex chars. | Server-authoritative SHA-256 at lock time over a canonical serialization of the full document (stable field order, line items, warranty text, all clauses, totals to integer cents). Stored full hash; display truncated. |
| **URL security** | Non-guessable slug (path segment). Anyone with the slug can POST signatures. | Signed, expiring, single-purpose token per recipient (JWT or equivalent). Token binds to one customer, one quote version, one action. Rate-limited and rotatable. |
| **Plan gating** | None. Anyone who clicks the link can sign. | Feature is Beta/Starter+-only per Beta Delta Appendix. Quota-enforced: per-tenant monthly signed-quote count; overage prompts upsell. Admin can issue tokens only while plan is valid. |
| **State machine** | Client-side `useState` transitions. Refresh resets to `viewed`. | Server-enforced. `signed` is a terminal irreversible state except via explicit void-and-reissue. Immutability guarded by DB constraints + application-level checks on every mutation. |
| **Versioning** | `quote.version` field exists but is never incremented. No historical versions stored. | Immutable on `signed`. Post-signature edits create a v+1 row; v1 is preserved verbatim (including rendered-HTML snapshot and signed PDF). Version is part of the hash and token binding. |
| **Idempotency** | None. Repeat POSTs to `/api/sign/[slug]` each produce a new email. | Ingress dedup on `(owner_id, source_msg_id, kind)` or equivalent; sign endpoint is idempotent per `(quote_id, version, actor)`. |
| **CIL enforcement** | Sign POST writes directly to Postmark and stdout log. No intermediate draft, no validation, no domain layer. | Mandatory Ingress → CIL Draft → Validation → Domain Mutation chain. Sign action creates a draft, validates against current quote state, then emits a locked domain event. Side effects (email, WhatsApp, PDF generation) flow from the domain event, not the HTTP request. |
| **Notification** | Postmark email to contractor only. No customer copy. | WhatsApp (primary) + email (fallback) to both contractor and customer. Each notification emits an audit event (`notification.sent` with channel + message id). Customer email carries the signed PDF. |
| **Tamper evidence** | Client-side 16-char hash displayed on the signed page. Not verified anywhere. | Server hash + signed PDF checksum stored alongside the signature row. Retrieval endpoints return `(doc_html_snapshot, doc_hash, signature_png, signed_pdf, audit_chain)` to prove integrity. |
| **PDF generation** | `window.print()` on the customer's browser. PDF quality depends on their device/OS. Never stored server-side. | Server-rendered PDF at sign time (e.g. Puppeteer, `@react-pdf/renderer`, or print-CSS service). Stored in Supabase Storage, tenant-scoped bucket. Retrievable via signed URL. Attached to customer email. |
| **Accessibility** | No keyboard fallback for signing, no ARIA on canvas, no typed-signature option. | Typed-signature fallback, ARIA labels, keyboard focus traps inside the modal, screen-reader-friendly instructions. Meets WCAG AA. |
| **Audit trail** | Single `[QUOTE-SIGNED]` log line + Postmark email (ephemeral). | Persistent `chiefos_quote_events`: `created`, `sent`, `viewed` (per device/session), `signed`, `locked`, `voided`, `reissued`. Each event stamped with `tenant_id`, `owner_id`, `user_id`, `ip`, `ua`, `at`. |
| **Template content** | Warranty text and 8 clauses are hardcoded JSX in `components/QuoteContract.jsx`. | Per-tenant editable templates stored in DB. Clause library with tenant overrides. Jurisdiction-specific boilerplate (e.g. CRA/IRS, ON/other provinces). |
| **Currency/rounding** | Raw JS float `total` sent to server and email. Formatted at display. | Integer cents everywhere. Server computes totals from line items; client never sends totals. HST rate pulled from tenant jurisdiction, not hardcoded. |
| **Change orders** | Not implemented. Clause 3 says verbal changes are rejected; no UI path. | Full Change Order flow: contractor creates CO linked to signed quote; customer receives a new signed-token link; CO has its own hash, signature, version, and appears in the quote's event chain. |
| **Receipts** | Not implemented. | Customer Receipt objects linked to payment events; deposit receipt on payment, balance receipt on completion. Part of the canonical financial spine. |

---

## 12. Recommended Build Sequence for ChiefOS

Per the Beta Delta Appendix, build order should be Quotes → Invoices → Change Orders → Customer Receipts. The standalone gives you starting material for Quotes only.

### 12.1 Quotes (document spine)
**Transfers directly from the standalone (UX/visual reference, not code):**
- 3-page document structure.
- Typography and `BRAND` palette.
- Page 1 layout (header band, Billed To / From, scope, line items, totals panel, payment strip).
- Warranty-block card component pattern (`term / termUnit / title / body` props).
- Clause-block pattern (`n / title / children`).
- `SignatureModal` interaction design (full-screen, device-width, native event listeners, post-sign confirmation overlay).
- `@media print` → `window.print()` as the v1 PDF export path.
- Postmark notification pattern (contractor-side).

**Must be rebuilt:**
- Data layer. Drop `lib/quotes.js`; Supabase-backed `chiefos_quotes` with RLS.
- Identity. Add `tenant_id`, `owner_id`, `user_id` everywhere.
- Sign endpoint. Enforce CIL. Server-side hash. Idempotency. Audit event emission.
- URL tokens. Replace slug with signed expiring tokens.
- Template editability. Warranty and clause content in DB, not JSX.
- Per-tenant branding (logo, colors, fonts) from tenant config.

**Not in the standalone — design fresh:**
- Quote draft/send UI for the contractor (intake from WhatsApp conversation, review, push).
- Template editor.
- Version/reissue flow (edit signed quote → v2).
- Customer-facing "you have a quote to review" WhatsApp + email delivery (with token).
- Server-rendered PDF generation + Supabase Storage.
- Per-tenant signed-quote quota enforcement.
- Admin dashboard view of all quotes with status, amount, signed timestamp.

### 12.2 Invoices
Nothing from the standalone transfers. Design fresh, but mirror the Quotes architecture:
- Same dual-boundary identity, same RLS, same CIL flow.
- Invoice links to a signed Quote (optional) or stands alone.
- Line items derived from the Quote or ad-hoc.
- Partial vs. full payment tracking.
- HST/CRA reporting ties into the existing expenses/tax spine in ChiefOS.

### 12.3 Change Orders
Not in the standalone — design fresh:
- Parent: a signed Quote.
- Child: a CO with its own line items (adds/removes/modifies).
- Its own sign flow (same modal UX as the Quote).
- Its own hash, version, audit chain.
- Updates the net payable on the parent quote.

### 12.4 Customer Receipts
Not in the standalone — design fresh:
- Linked to payment events (deposit received, balance paid).
- Auto-issued when payment is recorded in ChiefOS.
- Delivered via WhatsApp + email.
- Part of the tenant's year-end export.

### Architectural gotchas to design against from day one
- Every financial write must reconcile three ways: canonical spine, customer-visible doc, and tax export. The standalone never had to reconcile anything. ChiefOS does.
- The document's hashed payload must be a stable canonical form — don't let JSON key ordering or float formatting drift between the signed hash and any later rehash. Use an explicit serializer.
- The Postmark "From" address must be tenant-aware. Not every ChiefOS tenant owns `usechiefos.com`.

---

## 13. Files in This Repo Worth Reading

Absolute paths (Windows). All are readable by the Chief repo's Claude Code session for direct reference.

- `C:\Users\scott\Documents\mission-quote-standalone\components\QuoteContract.jsx` — the rendered 3-page document, signature modal, post-sign confirmation overlay, all brand constants, client-side state machine, PDF print styles. The single most important file. 1,800 lines.
- `C:\Users\scott\Documents\mission-quote-standalone\lib\quotes.js` — the hardcoded quote payload for Darlene. Mirror of the schema ChiefOS must honor. 142 lines.
- `C:\Users\scott\Documents\mission-quote-standalone\app\api\sign\[slug]\route.js` — sign endpoint. The entire email-and-log flow. 112 lines.
- `C:\Users\scott\Documents\mission-quote-standalone\app\q\[slug]\page.jsx` — dynamic quote page (server render, metadata, 404 fallback). 21 lines.
- `C:\Users\scott\Documents\mission-quote-standalone\app\layout.jsx` — root layout + the `width=860` viewport meta. 16 lines.
- `C:\Users\scott\Documents\mission-quote-standalone\app\not-found.jsx` — customer-friendly 404 text.
- `C:\Users\scott\Documents\mission-quote-standalone\lib\signatures.js` — `logSignature` helper (just a `console.log`). 4 lines.
- `C:\Users\scott\Documents\mission-quote-standalone\package.json` — dependency versions (Next 14.2.15, React 18.3.1, postmark 4.0.7, lucide-react 0.454.0).
- `C:\Users\scott\Documents\mission-quote-standalone\next.config.js` — minimal (strict mode on).
- `C:\Users\scott\Documents\mission-quote-standalone\jsconfig.json` — `@/*` path alias.
- `C:\Users\scott\Documents\mission-quote-standalone\.vercel\project.json` — Vercel project + team IDs (gitignored — read locally only).

Files to ignore:
- `QuoteContract (1).jsx` at repo root — untouched original copy of the component. Do not use; the edited version is in `components/`.
- `Screenshot 2026-04-17 044555.png`, `WhatsApp Image 2026-04-16 at 8.52.22 PM.jpeg` — reference images Scott sent during iteration; not source assets.

---

## 14. Open Questions and Unknowns

Issues not fully tested or resolved in this standalone. ChiefOS must decide how to handle each.

1. **Page-break behavior on print**: No explicit `page-break-before` / `page-break-after` CSS. Page 2's warranty content is long enough that on Letter paper it may split mid-paragraph. Never validated on an actual paper print, only on "Save to PDF". Worth adding `break-before: page` on each `.chiefos-page` in the ChiefOS build.
2. **Older iOS versions**: Tested on iOS 17+ Safari (Darlene's device assumed recent). iOS 14 and 15 Safari have different `touch-action` and viewport-meta quirks and weren't tested.
3. **Android Chrome**: Not tested in the Darlene flow (she was on iOS). The touch/modal path should work but the viewport-swap-on-close logic was tuned to iOS.
4. **Customer-facing signed PDF email**: Scott (contractor) gets an email with the signature PNG. The customer gets nothing except what she downloads via the browser. ChiefOS should decide whether to auto-email the customer a signed PDF.
5. **Post-sent, pre-sign edits**: Scott edited `lib/quotes.js` multiple times (line items split, prices changed, clauses added) **after** the URL was already in Darlene's possession. Because quote data is rebuilt from source on every request (`force-dynamic`), she always saw the latest. This is a bug-waiting-to-happen in any real system: the contractor could change the price after the customer saw version A but before they signed. ChiefOS must freeze a version the moment it's sent and reject silent edits.
6. **What "version" means**: `quote.version` is an integer in the data but nothing updates it and nothing enforces its semantics. Is v1 → v2 a new document with its own slug? Same slug with history? The standalone doesn't have an opinion. ChiefOS must.
7. **Signature PNG retention**: The PNG exists only in Scott's email inbox and (transiently) in Vercel function logs. No canonical store. If Scott deletes the email, the signature artifact is gone. ChiefOS must persist to Supabase Storage.
8. **`total` as float on the wire**: The sign POST sends `total` as a raw JS float. A tampered client could send any number. The server's Postmark email trusts this value. ChiefOS must recompute server-side from line items and never trust a client-sent total.
9. **Time-to-sign data lost**: At time of writing this handoff, the Vercel function log retention may have rolled past the actual Darlene sign event. If the Chief build team wants a real benchmark for "URL-to-signature" latency on a mobile-first quote, they may need to wait for the first ChiefOS-native signing event.
10. **Accessibility compliance**: Not audited. A signed contract executed by an assistive-tech user is legally suspect if the capture control was inaccessible. ChiefOS must address before general release.
11. **Postmark sender domain per tenant**: `scott@usechiefos.com` works for Scott's tenant. A second tenant with a different brand cannot reasonably send from `usechiefos.com` — it would look suspicious to their customers. The ChiefOS Postmark integration needs per-tenant sender support (verify tenant domain, fall back to a neutral `noreply@chiefos.com` style address otherwise).
12. **Signature fraud resistance**: The PNG captured is visually a signature but carries no cryptographic identity binding (no device attestation, no timestamp authority, no biometric). Whether the ChiefOS Quotes spine needs anything stronger than visible-PNG-plus-server-hash depends on the customer-risk profile and is a business-level decision.

---

*End of handoff. The rest of the work lives in the Chief repo.*
