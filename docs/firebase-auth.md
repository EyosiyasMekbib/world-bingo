# World Bingo — Firebase Phone Sign-In Runbook

> **Scope:** phone (SMS) sign-in through Firebase Authentication — one of three ways a player
> reaches an account, beside the username/password form (`/auth/login`, `/auth/register`) and
> Telegram. It is the default tab on both auth pages; the other two are unchanged, including
> the support-issued temporary password for a player who has forgotten theirs.
>
> Staff (CLERK / ADMIN / SUPER_ADMIN) sign in with a password at `/auth/admin/login`, from the
> admin app, and **cannot** sign in by SMS — see the refusals below.
>
> **Golden rule, same as every other integration here:** env-gated and inert when unset. With
> no `FIREBASE_PROJECT_ID` the API answers `503 firebase_not_configured` on `/auth/phone` and
> nothing else in the system changes.
>
> **One Firebase project per brand.** arada and betbawa each have their own project, their own
> SMS quota and their own authorized domains. Nothing brand-specific is in the code; every
> difference is an env var.

## 1. How it works

```
browser                                   Firebase                 API
   │  phone number                            │                     │
   ├─ signInWithPhoneNumber ──────────────────►│  (invisible reCAPTCHA)
   │                                          ├── SMS ──► player's handset
   │  6-digit code                            │                     │
   ├─ confirmationResult.confirm ────────────►│                     │
   │◄──────────────── Firebase ID token ──────┤                     │
   │                                                                │
   ├─ POST /auth/phone { idToken, referralCode? } ─────────────────►│
   │                                       verify signature against Google's
   │                                       public certs; check aud/iss = this
   │                                       project; read phone_number from the
   │                                       signed claims                    │
   │◄───────────── { user, accessToken, refreshToken } ─────────────┤
```

The ID token is the only thing the browser sends. The phone number is read from the token's
**signed claims**, never from the request body — a number in the body would be caller-chosen.

Sign-in and sign-up are the same call. A number the deployment has never seen gets a new
account (wallet included); a number that matches an existing account signs into it — including
an account that was created with a username and password, which keeps working as before. The
client is not told which happened and does not need to be.

### What the server does with a verified number

1. Match on `users.firebaseUid` — set the first time a player signs in with SMS, stable for
   that number within the brand's Firebase project.
2. Otherwise match on `users.phone`, comparing against **every spelling** the number could be
   stored under (`+251911234567`, `251911234567`, `0911234567`, `911234567` — accounts created
   before phone sign-in hold whatever the player typed). The comparison is exact against that
   list, never a suffix or `contains` match.
3. Otherwise create the account, storing the number in E.164 as Firebase verified it.

Two deliberate refusals:

- **A staff account is never reachable by SMS** (`403`). An SMS code is one factor and a SIM
  is swappable; CLERK/ADMIN/SUPER_ADMIN keep the password path, and `AuthService.login` refuses
  any other role at `/auth/admin/login` before it mints a token.
- **A token that is not a phone sign-in is refused** even if it verifies. An anonymous session
  on the same Firebase project is a valid token and proves nothing about a phone number.

### Signing in by SMS after a support password reset

Support issues a temporary password and sets `mustChangePassword`, which holds the player on
`/set-password` — a page that asks for that temporary password as the current one. A player who
never received it and signs in by SMS instead would be stuck there with nothing to type, so an
SMS sign-in on an account in that state **retires the unused temporary password**: the flag and
the hash are both cleared, and the player lands in the lobby.

`passwordResetAt` is deliberately left alone, so `WalletService.requestWithdrawal` still holds
withdrawals for 24 hours after the reset however the player got back in. A password the player
still uses is never touched — only `adminResetPassword` ever sets the flag.

No service-account key is involved anywhere. Verifying an ID token needs only Google's public
certificates and the project id, so there is no Firebase credential to leak from a deployment.

## 2. Create the project (per brand)

Do this twice — once for arada, once for betbawa.

1. https://console.firebase.google.com → **Add project**. Name it for the brand
   (`arada-bingo`, `betbawa`). Google Analytics is not needed.
2. **Authentication → Get started → Sign-in method → Phone → Enable.**
3. **Authentication → Settings → Authorized domains**: add the brand's domain (e.g.
   `aradabingo.com`). `localhost` is authorized by default, which is what makes local
   development work with no extra setup.
4. **Project settings → General → Your apps → Web app (`</>`)** → register an app → copy the
   `firebaseConfig` values.
5. **Authentication → Settings → SMS region policy**: allow Ethiopia only, unless you are
   deliberately supporting other countries. This is the cheapest guard against SMS-pumping
   fraud, where an attacker drives sign-ins to premium ranges abroad.

## 3. Configure the deployment

Both services need values from the **same** project, or every token the web app mints will be
refused by the API.

| var | service | value |
|---|---|---|
| `FIREBASE_PROJECT_ID` | api | `projectId` from the config |
| `NUXT_PUBLIC_FIREBASE_API_KEY` | web | `apiKey` |
| `NUXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | web | `authDomain` (`<project>.firebaseapp.com`) |
| `NUXT_PUBLIC_FIREBASE_PROJECT_ID` | web | `projectId` — must equal `FIREBASE_PROJECT_ID` |
| `NUXT_PUBLIC_FIREBASE_APP_ID` | web | `appId` |

The four `NUXT_PUBLIC_*` values are public by design: they identify the project, they do not
authorise anything, and they ship in the client bundle. They are read at runtime through Nuxt's
`runtimeConfig`, so changing them needs a restart, not a rebuild.

They are wired into every compose file (`docker-compose.yml`, `.prod.yml`,
`.aradabingo{,.staging}.yml`, `.betbawa{,.staging}.yml`) and default to empty, so a deployment
that has not set them still boots.

## 4. Verify it works

```bash
# Unconfigured deployment — the expected answer when the vars are empty:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>/api/auth/phone \
  -H 'content-type: application/json' -d '{"idToken":"x"}'
# 503

# Configured deployment, junk token:
# 401 with {"code":"firebase_token_invalid"}
```

Then sign in from the app itself: `/auth/login` → Phone tab (the default) → number → code. On
success the player lands in the lobby with a wallet.

Checks worth doing once per brand, in a staging deployment:

- An existing account whose `users.phone` is stored as `09…` signs into **that** account, with
  its balance, rather than getting a fresh empty one.
- That same account still signs in on the Password tab with its username and password.
- A staff phone number is refused with the "sign in from the admin dashboard" message.
- The admin app still signs in at `/auth/admin/login`, and support's temporary-password reset
  still lands the player on `/set-password`.

## 5. Automated tests without sending SMS

Firebase supports **test phone numbers**: a fixed number and a fixed code, with no SMS sent and
no quota spent.

**Authentication → Sign-in method → Phone → Phone numbers for testing** → add e.g.
`+251911000000` / `123456`.

These work with the real client SDK and produce real ID tokens, so an end-to-end test can drive
the whole flow. Keep them out of the production project, or delete them once testing is done —
anyone who learns the pair can sign into that account.

The unit tests need none of this: `apps/api/src/test/firebase-token.test.ts` verifies tokens
against a self-signed fixture key, and `auth-firebase-phone.test.ts` stubs verification to
exercise the account-matching rules.

## 6. Quotas, cost and failure modes

- Firebase's free Spark plan allows **10 SMS/day**; the Blaze plan meters per message and per
  country. An Ethiopian SMS is roughly US$0.01–0.06. Budget from expected daily sign-ins, and
  set a billing alert.
- **`auth/too-many-requests`** is Firebase's per-number metering. The app shows "Too many
  attempts, wait a few minutes" and does not treat it as a wrong code.
- **`auth/quota-exceeded`** is the project running out of SMS budget — nothing the player can
  fix, and the message says so.
- The API's own `/auth/phone` limit is 30/min per IP plus the shared 120/min sign-in ceiling.
  It is a backstop only: the body is one opaque token, and anything readable out of it
  (a token hash, the unverified payload) is chosen by the caller, so it cannot key a bucket an
  attacker could not rotate. Firebase's reCAPTCHA-gated, per-number SMS metering is the real
  guard.
- If Google's certificate endpoint is unreachable, the API keeps verifying from its cached
  certificates (they stay valid for weeks after rotation). Only a cold cache fails, with
  `503 firebase_keys_unavailable` — a retry, not a rejected code.

## 7. Where the code lives

| path | what |
|---|---|
| `apps/api/src/lib/firebase.ts` | ID token verification: Google's certs, cache, `aud`/`iss`/`alg` checks |
| `apps/api/src/services/auth.service.ts` | `firebasePhoneAuth` — which account a verified number belongs to |
| `apps/api/src/routes/auth/index.ts` | `POST /auth/phone`, and the staff-only `/auth/admin/login` |
| `packages/shared-types/src/phone.ts` | E.164 ↔ local spellings, shared by API and web |
| `apps/web/composables/useFirebasePhoneAuth.ts` | reCAPTCHA → SMS → code → ID token |
| `apps/web/components/PhoneSignIn.vue` | the form, shared by `/auth/login` and `/auth/register` |
| `apps/web/utils/firebase-error.ts` | Firebase error codes → what the player reads |
