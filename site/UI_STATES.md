# UI states: what the site does when things aren't on the happy path

This is the map of the ten interface states (empty, loading, error, offline, slow network, no results, permission,
session expired, validation, success) across the site's real workflows, and where each one lives in the code.
Keep it up to date when a workflow changes.

## Shared building blocks

| Piece | File | What it does |
| --- | --- | --- |
| `request()` | `src/lib/client/network.ts` | Every browser `fetch` goes through it. Adds a timeout, a "slow" callback, and sorts failures into `offline`, `timeout` or an HTTP reply. Tells the network banner when the connection drops or comes back, judged by real requests, not just `navigator.onLine`. |
| `NetworkBanner` | `src/components/NetworkBanner.astro` | A small bar at the bottom of every page (public and admin). Shows "You're offline…" with *Try now*, checks `/api/health` with growing gaps (2 s → 30 s), then says "Back online" and hides. |
| `attachValidation()` | `src/lib/client/validate.ts` | Inline form errors: a message under each field (`aria-describedby`), `aria-invalid`, an error summary with links when two or more fields need fixing, focus on the first problem, re-checks as the guest corrects. Errors are text plus an icon, never colour alone. Forms opt in with `data-validate`. |
| `EmptyState` | `src/components/EmptyState.astro` | Heading, explanation and one or two actions, for lists with nothing in them. |
| Admin form guard | `src/layouts/Admin.astro` | On every admin form: "Saving…" and the button switched off (no double refunds or double quotes), a hold when offline, and a draft kept in the tab (never passwords or keys) so work survives an expired login. |
| `500.astro` | `src/pages/500.astro` | The page for unexpected server errors: plain words, *Try again*, and a WhatsApp link. |

Booking is **idempotent**: the booking form sends an `attemptId` with each try. If the same attempt arrives twice
(a retry after a timeout, a double tap), `/api/book` returns the booking it already made instead of making a second
one or sending a second M-Pesa prompt. Changing anything in the form starts a new attempt.

## Coverage matrix

✅ handled · — doesn't apply (reason given) · Every message below is the real text the user sees.

### Journeys and destinations lists (`/packages/`, `/destinations/`)

| State | Trigger | What the user sees / can do |
| --- | --- | --- |
| Empty | No journeys published | EmptyState "New journeys are on their way" + *Plan a trip with us* and *Send an enquiry*. The filter bar is hidden (there's nothing to filter). |
| Loading | — | Server-rendered; images have fixed width/height so nothing jumps as they load. |
| Error | Server fails | `500.astro`. |
| Offline | Connection drops after load | Page stays readable (it's all on the page); the banner says filters still work. |
| Slow | — | No requests after the page loads. |
| No results | Search/filters match nothing | "No journeys match "blu sea"". *Did you mean "blue sea"?* when a close word would find something, other filters that do have results (with counts), *Clear search and filters*, and *ask us*. Distinct from Empty. |
| Permission | — | No device permissions used. |
| Session | — | Public, no login. |
| Validation | — | No form. |
| Success | — | Nothing to confirm. |

### Book a journey (`BookingPanel` on `/packages/[slug]/`)

| State | Trigger | What the user sees / can do |
| --- | --- | --- |
| Empty | Journey has no price | Booking panel isn't shown; the enquiry form is (existing behaviour). |
| Loading | Submit | Button off, `aria-busy`, "Saving your booking and sending the M-Pesa prompt…". |
| Error | 4xx/5xx from `/api/book` | The server's specific message (e.g. "The earliest date you can book online is…"). Everything typed is kept. |
| Offline | Request never reaches server | "You're offline, so your booking wasn't sent. Nothing has been charged. Your details are still here: press the button again once you're connected." + banner. |
| Slow | No reply after 8 s | "Still working on it. Your connection seems slow; please keep this page open." Hard stop at 60 s: "We didn't hear back in time. Your booking may have gone through: press the button again and you won't be booked twice." (safe because booking is idempotent). |
| No results | — | Not a search. |
| Permission | — | None. |
| Session | — | Guests don't log in. |
| Validation | Missing/invalid fields | Inline errors per field, summary when 2+, focus first error. Date range, email format, Kenyan M-Pesa number ("Enter a Safaricom number like 0712 345 678"). Server re-checks everything and prices it itself. |
| Success | Server returns `next` | Straight on to the pay page or the provider's checkout; the pay page confirms only when the provider does. |

### Pay for a booking (`/pay/[ref]/`)

| State | Trigger | What the user sees / can do |
| --- | --- | --- |
| Empty | Unknown reference | "We couldn't find that payment link…" + *Ask us on WhatsApp* (existing). Nothing to pay (cancelled/refunded): heading "Nothing to pay" (existing). |
| Loading | Any pay button | Buttons off, status line ("Sending the payment prompt…"). |
| Error | Provider declines / request fails | Server message in the status box, buttons back on. |
| Offline | Pay request or status check can't connect | Pay request: "You're offline, so nothing was sent and nothing was charged…". While waiting for M-Pesa: "You're offline. If you've entered your PIN, the payment still goes through; we'll check again as soon as you're back online." The 3-minute wait clock pauses while offline. |
| Slow | No reply after 8 s / 30 s cap | M-Pesa: after the cap we don't offer a resend (a second prompt could double-charge); we start checking status instead: "We couldn't confirm the prompt was sent. If one arrives, enter your PIN. We're checking for your payment." Card/other providers: "That's taking too long. Nothing has been charged; try again." |
| No results | — | — |
| Permission | — | None (the PIN is entered on the phone, not here). |
| Session | — | Pay links don't need a login. |
| Validation | Phone/email | Inline errors as above (M-Pesa number checked before sending). |
| Success | Status endpoint says paid | "Payment received." + receipt number, heading changes to "All paid. Thank you!", focus moves to the heading so screen readers hear it, and next steps (*See more journeys*, *Message us*). Never shown before the provider confirms. |

### Trip enquiry (`EnquiryForm`, `TripSketcher`)

| State | Notes |
| --- | --- |
| Validation | Inline errors for name and message (`data-validate`). |
| Success | Honest: "WhatsApp should open with your message ready to send" — we can't confirm it was sent, so we don't say it was. |
| Permission | If the browser blocks the WhatsApp tab, we fall back to opening WhatsApp in the same tab (existing). |
| Others | — Nothing is sent to our server. |

### Admin (all `/admin/` pages)

| State | Trigger | What the user sees / can do |
| --- | --- | --- |
| Empty | No quotes / no journeys | Existing empty messages with a first action. |
| Loading | Any form submit | Pressed button says "Saving…" (or its own `data-pending` text) and every submit button in that form is switched off until the page changes. |
| Error | Action fails | Red flash message (existing), form input kept by the server where it re-renders. |
| Offline | Submit while offline | Submit is held: "You're offline. Nothing was saved; your changes are still here. Press the button again once you're connected." + banner. |
| Slow | — | Native form posts show the browser's own progress; the button stays in "Saving…" so it can't be pressed twice. |
| No results | Quote search matches nothing | "No quotes match "…"" + *Clear search*. |
| Permission | Clipboard blocked | *Copy* falls back to selecting the text and "Press Ctrl+C" (existing). |
| Session expired | Login runs out (12 h) | Posting a form sends you to login with "Your session expired. For your security, please log in again to continue." After logging in you're returned to the page you were on, and what you'd typed is filled back in with a notice to check and save again. Passwords, keys, secrets and files are never kept. Drafts live only in that browser tab (sessionStorage) and are dropped after 30 minutes. No redirect loops: only `/admin/...` paths are allowed as the return address. |
| Validation | Missing/invalid fields | Inline errors on login and quote forms (`data-validate`); server validation remains the authority. |
| Success | Action done | Green flash message (existing). |

## Tests

- `tests/unit/network.test.ts`: timeout, offline vs HTTP error, slow callback, cancellation.
- `tests/unit/validate.test.ts`: messages, aria wiring, summary, focus, custom checks.
- `tests/unit/booking.test.ts`: the same `attemptId` never creates two bookings.
- `tests/e2e/states.spec.ts`: booking validation, offline booking then a safe retry, slow booking, no-results suggestions, empty list, pay page offline wait, admin double submit, admin session expiry with draft restore, offline banner, 500 page, accessibility (axe) on the new states.
