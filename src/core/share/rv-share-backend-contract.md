# Share backend — HTTP contract (plan-386 §2.6)

**This document is the hand-off.** The client half (`rv-share-session.ts`,
`rv-share-upload.ts`) is implemented in this repo and tested against a stub that
implements *exactly* what is written below (`tests/helpers/rv-share-backend-stub.ts`,
`tests/rv-share-upload.test.ts`). The server half lives in another repo — Firebase
Functions / customer portal. Anything the server does differently from this page
is a contract break, and the stub is where it will show.

R1 in the plan is precisely this risk: a contract that drifts because nobody wrote
it down. So the rule is one-directional — **the server is written against this
document, and this document changes only together with the client and its stub.**

- **Base URL** — configurable; defaults to `/api/share` (same origin).
  A deploy whose API lives elsewhere calls `configureShareApi({ baseUrl })`.
- **Auth** — `Authorization: Bearer <session token>` on every route marked *(auth)*.
  The token goes to **this API only**; it is never attached to the signed storage URL.
- **Errors** — always `{"error": {"code": "<code>", "message": "<human sentence>"}}`.
  The client prefers `error.code` over the status code; the status is the fallback.
  Known codes: `unauthenticated`, `terms-required`, `forbidden`, `not-found`,
  `gone`, `too-large`, `quota-exceeded`, `not-uploaded`, `hash-mismatch`,
  `conflict`, `bad-request`, `server`.
- **No credentials in the client.** The client holds one secret: the session token
  the server minted for that user. Nothing else — no storage key, no project id,
  no service account (`upload_NoCredentialsInClient`).

---

## 1. Magic-link sign-in (F9)

Why a login at all: uploads to us are attributable and, because links persist by
default, "my shared links" (F11) needs an owner. The *own URL* path hosts nothing
at ours and therefore needs no login at all (Finding 14) — it never reaches this API.

### `POST /auth/request`

```json
{ "email": "thomas@realvirtual.io", "returnUrl": "https://web.realvirtual.io/?mode=planner" }
```

→ `202` `{ "requestId": "…", "expiresInSec": 900 }`

Sends a mail containing `<returnUrl>` with `?sharetoken=<one-time token>` appended.
The response must **not** reveal whether the address is known — same answer either way.

### `POST /auth/exchange`

```json
{ "token": "<one-time token from the mail>" }
```

→ `200` `{ "session": { "token": "<bearer>", "email": "…", "expiresAt": "<ISO 8601>" } }`
→ `401` `unauthenticated` — unknown, expired **or already redeemed** token.

One-time means one time: a replayed token is `401` (`upload_ExpiredOrReplayedSession_Rejected`).
The client strips `?sharetoken=` from the address bar immediately, redeemed or not.

### `GET /auth/session` *(auth)*

→ `200` `{ "email": "…", "expiresAt": "<ISO 8601>" }` · `401` `unauthenticated`

### `POST /auth/logout` *(auth)*

→ `204`. Best effort from the client's side; it drops the local session first.

---

## 2. Upload state machine (F9a)

```
   POST /uploads          PUT <signed url>        POST /uploads/:id/confirm
 ──────────────────►  created  ──────────────►  uploaded  ──────────────►  confirmed
                         │                         │                          │
                         └── orphan sweep ─────────┘                          │
                                     │                                        │
                                     ▼                             DELETE /shares/:id
                                  deleted  ◄──────────────────────  TTL job (if expiry set)
```

**Only `confirmed` is visible.** Nothing before it is reachable through a link, and
nothing before it appears in `GET /shares`. A `created`/`uploaded` record without a
`confirm` inside the grace period is swept (`upload_OrphanCleanedUp`).

### `POST /uploads` *(auth)*

```json
{
  "filename": "pick-and-place.glb",
  "contentType": "model/gltf-binary",
  "size": 2411008,
  "sha256": "<lowercase hex>",
  "expiry": "never" | "7d" | "30d" | "90d",
  "allowDownload": true,
  "terms": { "version": "2026-08-08", "acceptedAt": "<ISO 8601>" },
  "meta": { "v": 1, "name": "…", "author": "…", "license": "…", "level": "assembly", "allowDownload": true }
}
```

→ `201`

```json
{
  "id": "<opaque share id>",
  "uploadUrl": "https://storage…/…?X-Goog-Signature=…",
  "uploadHeaders": { "Content-Type": "model/gltf-binary" },
  "uploadMethod": "PUT",
  "uploadExpiresAt": "<ISO 8601>"
}
```

Errors:

| Status | code | When |
|---|---|---|
| `401` | `unauthenticated` | no/expired session (`upload_RequiresLogin`) |
| `422` | `terms-required` | `terms` missing, or `terms.version` not the current one (`upload_RequiresTermsAcceptance`) |
| `413` | `too-large` | `size` over the per-file limit (`upload_OversizeRejectedWithMessage`) |
| `507` | `quota-exceeded` | account total would be exceeded (`upload_QuotaExceeded_Message`) |

Server obligations:

- **Bind** `size`, `sha256` and `contentType` to the record *now*, before any byte
  exists. `confirm` verifies against this, which is what makes tampering a
  server-side fact instead of a client promise.
- The signed URL is **single-use and short-lived**. A second `PUT` on the same URL
  is rejected (`upload_SignedUrlNotReusable`) — signature reuse, `403`.
- **Log the consent** with `terms.version`, `terms.acceptedAt` and the account, so
  it is later provable who agreed to what (F9c).
- The `id` is **opaque** and carries no storage path (§2.1).

### `PUT <uploadUrl>`

Raw GLB bytes, exactly the headers from `uploadHeaders`, **no `Authorization`**.
→ `200`/`201`/`204` on success · `403` on a reused or expired signature.
Moves the record to `uploaded`.

The bytes never pass through the API (`upload_PutsBytesDirectlyToSignedUrl`).

### `POST /uploads/:id/confirm` *(auth)*

Header: `Idempotency-Key: <client-generated>`

```json
{ "sha256": "<lowercase hex>", "size": 2411008 }
```

→ `200` `{ "id": "…", "url": "<storage url>", "expiresAt": "<ISO 8601>" }`

`expiresAt` is present **only** when `expiry !== "never"` (`upload_DefaultExpiry_IsNever`,
`upload_ChosenExpiry_SetsExpiresAt`). `url` is the storage URL — internal; the client
never puts it in a shared link.

Errors:

| Status | code | When |
|---|---|---|
| `409` | `not-uploaded` | no bytes yet — `confirm` before `PUT` (`upload_ConfirmBeforePut_Rejected`) |
| `422` | `hash-mismatch` | stored object's size/hash differs from the binding (`upload_TamperedBytes_RejectedByHash`) |
| `403` | `forbidden` | the session is not the record's owner (`upload_CrossOwnerConfirmOrDelete_403`) |
| `401` | `unauthenticated` | expired or replayed session |

**Idempotency:** repeating a `confirm` with the same key returns the same body and
creates no second share (`upload_ConfirmIsIdempotent`). A *different* key on an
already-confirmed record is `409 conflict`.

### `DELETE /uploads/:id` *(auth)*

Abandon a `created`/`uploaded` record. → `204`, also when it is already gone.
The client calls this best-effort when the flow fails after `create`, so a failed
share leaves no half state (`upload_FailureLeavesNoHalfState`). The sweep is the
real guarantee; this is the polite version.

---

## 3. Inventory and deletion (F11)

### `GET /shares` *(auth)*

→ `200`

```json
{ "shares": [
  { "id": "…", "name": "Pick & Place Cell", "sizeBytes": 2411008,
    "createdAt": "<ISO>", "expiresAt": "<ISO>", "allowDownload": true, "expired": false }
] }
```

Scoped to the bearer of the session — **only his own**, never anyone else's
(`myShares_ListsOnlyOwnUploads`). The scoping is server-side; the client neither
filters nor asks for a wider set, so a client bug cannot widen the disclosure.
`expired` is the server's verdict, not something the panel derives from the clock.

### `DELETE /shares/:id` *(auth)*

→ `204` · `403` `forbidden` for a foreign owner · `404` when unknown.

After this the link answers `410` with `reason: "deleted"`
(`myShares_DeleteRemovesAndReturns410`). "Deleted" has to be defined, not assumed
(F9b): object removed, CDN cache invalidated, and a stated backup retention window.

---

## 4. Resolving an opaque link (§2.1)

### `GET /shares/:id/download-url` — **no auth**

A shared link works for anybody who holds it; that is the feature (F3).

→ `200` `{ "url": "<short-lived signed download url>", "expiresAt": "<ISO>" }`

→ `410` with `X-Rv-Share-Reason: expired | deleted` and body
`{"error": {"code": "gone"}, "reason": "expired"}`.

The reason code is what lets the viewer say *"this link has expired"* versus
*"this link was deleted by its owner"* — and, when the server gives no reason, the
viewer says the neutral *"no longer available"* rather than inventing a cause
(F10a). Claiming a cause we were not told is exactly the small lie that makes an
error message untrustworthy.

`404` is treated by the client like `410` without a reason.

The download URL must be **short-lived**. Not DRM: the browser has to load the
bytes, so a determined visitor can always read them out of the network tab. What
this buys is that the *forwarded* artefact is a viewer link, plus immediate
revocation, a reason on `410`, and access counts.

---

## 5. Jobs and operator controls (F9b/F9d) — backend-only

None of this has a client counterpart; it is listed here because the client's
behaviour assumes it exists.

| Job / control | Requirement |
|---|---|
| **Orphan sweep** | delete `created`/`uploaded` records past a short grace period, storage object included |
| **TTL job** | delete records whose `expiresAt` has passed; afterwards `410` with `reason: "expired"` |
| **Account recovery** | a lost mailbox must not make content undeletable |
| **Admin takedown** | we must be able to remove third-party content ourselves |
| **Abuse reporting** | a route per link, or at minimum a documented address |
| **Deletion semantics** | object, CDN cache and backup window all defined explicitly |
| **Quota** | per-file limit *and* per-account total; without a default expiry the quota is the brake (§5.2) |
| **Rate limit** | per sender, on `/auth/request` and `/uploads` |
| **Right to delete** | the terms grant deletion at any time — storage pressure, abuse, illegality (F9d) |

## 6. Terms version

`SHARE_TERMS_VERSION` in `rv-share-session.ts` is currently **`2026-08-08`**. The
server rejects a `create` whose `terms.version` is not the current one, and the
client asks again when it changes — including for a restored draft, because
consent to a text that has since changed is not consent.
