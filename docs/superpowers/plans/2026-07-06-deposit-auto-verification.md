# Deposit Auto-Verification Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-verify Telebirr deposits by fetching the canonical ethiotelecom receipt by transaction id, parsing it, and auto-crediting the wallet (reusing `WalletService.approveDeposit`) when the receiver, settled amount, and status all match and the amount is under a configurable cap — falling back to the existing manual queue on any mismatch, not-found, unreachable, or edge case.

**Architecture:** An async BullMQ worker runs a pure `verify → decide` pipeline. A `DepositVerifier` (Telebirr = first impl) fetches + parses the receipt HTML into a `ParsedReceipt`; a pure `ReceiptDecisionEngine` compares it to the active `PaymentMethod`(s) + config and returns AUTO_CREDIT or MANUAL. On AUTO_CREDIT the worker calls the existing atomic credit path. The whole feature is flag-gated (default off) and never blocks or alters the current deposit submission flow.

**Tech Stack:** TypeScript (ESM), Fastify v5, Prisma 5 + PostgreSQL, BullMQ + Redis, Vitest, `node-html-parser` (new), `node:https` for host-scoped relaxed-TLS fetch. Nuxt 3 (`@nuxt/ui`) for the admin badge.

## Global Constraints

- **ESM import extensions:** match the sibling files in the *same directory*. Files under `src/services/**` import peers **without** a `.js` extension (e.g. `import prisma from '../lib/prisma'`). Files under `src/workers/**` import **with** `.js` (e.g. `import { QUEUE_NAMES } from '../lib/queue.js'`). Follow the local convention exactly per file.
- **Prisma migrations are hand-authored here.** `prisma migrate dev` is broken in this environment (P3014 / shadow-DB disk). Author the migration SQL by hand and apply with `pnpm --filter @world-bingo/api exec prisma migrate deploy`, then `prisma generate`. Migration folder format: `YYYYMMDDHHMMSS_<description>` (latest existing: `20260626000000_add_transaction_original_amount`). Use `20260706000000_add_deposit_verification`.
- **Unit tests must not need the DB.** The api test DB is flaky/not-provisioned. Pure modules (types/matching/parser/decision-engine/classify) take no DB. Orchestration tests mock Prisma with `vi.mock('../lib/prisma', ...)` (see `src/test/palace-wallet.test.ts`). No live network in any test.
- **`WalletService` is a class of `static` methods.** Credit only ever happens through `WalletService.approveDeposit(transactionId, adjustedAmount?)`. Do NOT write a second credit path.
- **Money math in integer cents.** Compare/normalize ETB amounts as `Math.round(n * 100)` to avoid float drift. Credit the receipt's **Settled Amount** (never Total Paid).
- **Fail-safe:** any exception, timeout, unknown format, or ambiguity resolves to MANUAL/UNAVAILABLE (deposit stays `PENDING_REVIEW`). The engine never rejects or credits on doubt.
- **Feature flag:** everything is inert unless `deposit_auto_verify_enabled = 'true'` in `siteSetting`. Auto-credit additionally requires the amount ≤ `deposit_auto_verify_max_amount`.
- **Commit after every task** with the message shown in that task's final step.

---

## File Structure

**apps/api (new):**
- `prisma/migrations/20260706000000_add_deposit_verification/migration.sql` — hand-authored DDL.
- `src/services/deposit-verification/types.ts` — `ParsedReceipt`, `VerifyUnavailable`, `DepositVerifier`, `ExpectedDeposit`, `VerifyConfig`, `Decision`, reason-code constants.
- `src/services/deposit-verification/matching.ts` — pure `normalizeName`, `maskedNumberMatches`, `amountsEqualCents`, `parseReceiptAmount`, `parseReceiptDate`.
- `src/services/deposit-verification/telebirr-parser.ts` — pure `parseReceiptHtml(html) → ParsedReceipt | VerifyUnavailable`.
- `src/services/deposit-verification/decision-engine.ts` — pure `evaluate(parsed, expected, config) → Decision`.
- `src/services/deposit-verification/receipt-fetcher.ts` — `classifyReceiptResponse` (pure) + `fetchReceiptHtml` (I/O, `node:https`, relaxed TLS, timeout).
- `src/gateways/payment/telebirr-receipt.verifier.ts` — `TelebirrReceiptVerifier implements DepositVerifier`.
- `src/services/deposit-verification/registry.ts` — `getVerifier(methodCode) → DepositVerifier | null`.
- `src/services/deposit-verification.service.ts` — `enqueueVerification`, `loadVerifyConfig`, `runVerification` (orchestration).
- `src/workers/deposit-verification.worker.ts` — BullMQ worker (limiter + dynamic 429 backoff).
- `src/test/fixtures/telebirr-receipt-completed.html`, `telebirr-receipt-notfound.html` — sanitized parser fixtures.
- Tests: `src/test/deposit-matching.test.ts`, `deposit-telebirr-parser.test.ts`, `deposit-decision-engine.test.ts`, `deposit-receipt-fetcher.test.ts`, `deposit-verifier.test.ts`, `deposit-verification-service.test.ts`.

**apps/api (modify):**
- `prisma/schema.prisma` — add `PaymentMethod.autoVerify`, `DepositVerification` model + 2 enums + backref on `Transaction`.
- `src/lib/queue.ts` — add `DEPOSIT_VERIFICATION` queue name.
- `src/services/wallet.service.ts` — enqueue verification after `initiateDeposit` create.
- `src/index.ts` — side-effect import the worker.
- `src/services/admin.service.ts` — `include: { depositVerification: true }` in the pending list.
- `src/routes/settings/index.ts` — add the four `deposit_auto_verify_*` DEFAULTS.
- `package.json` — add `node-html-parser`.

**packages/shared-types (modify):**
- `src/entities/index.ts` (or the correct entities file) — `DepositVerificationStatus`, verification reason codes, `DepositVerificationView` interface.

**apps/admin (modify):**
- `pages/deposits.vue` — verification badge + parsed panel; extend `DepositTransaction`.
- Payment-methods admin page — `autoVerify` toggle (a checkbox alongside `enabled`).

---

## Task 1: Database schema + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260706000000_add_deposit_verification/migration.sql`

**Interfaces:**
- Produces: table `deposit_verifications`, column `payment_methods.autoVerify`, enums `DepositVerificationStatus`, `DepositVerificationSource`, Prisma models `DepositVerification` and `PaymentMethod.autoVerify`, `Transaction.depositVerification` backref.

- [ ] **Step 1: Add the `autoVerify` column to `PaymentMethod`**

In `schema.prisma`, in `model PaymentMethod`, add this line after `enabled Boolean @default(true)`:

```prisma
  autoVerify      Boolean           @default(false)
```

- [ ] **Step 2: Add the backref field to `Transaction`**

In `model Transaction`, add after the `user` relation line:

```prisma
  depositVerification  DepositVerification?
```

- [ ] **Step 3: Add the model + enums**

Append to `schema.prisma`:

```prisma
model DepositVerification {
  id                   String                    @id @default(uuid())
  transactionId        String                    @unique
  transaction          Transaction               @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  status               DepositVerificationStatus @default(PENDING)
  source               DepositVerificationSource @default(RECEIPT_FETCH)
  decision             String?
  decisionReasons      String[]
  receiverName         String?
  receiverNumberMasked String?
  settledAmount        Decimal?                  @db.Decimal(12, 2)
  totalPaid            Decimal?                  @db.Decimal(12, 2)
  receiptStatus        String?
  receiptNumber        String?
  receiptTime          DateTime?
  payerName            String?
  payerNumberMasked    String?
  rawSnapshot          Json?
  attempts             Int                       @default(0)
  createdAt            DateTime                  @default(now())
  updatedAt            DateTime                  @updatedAt

  @@index([status])
  @@map("deposit_verifications")
}

enum DepositVerificationStatus {
  PENDING
  AUTO_CREDITED
  MANUAL_REQUIRED
  UNAVAILABLE
}

enum DepositVerificationSource {
  RECEIPT_FETCH
}
```

- [ ] **Step 4: Hand-author the migration SQL**

Create `apps/api/prisma/migrations/20260706000000_add_deposit_verification/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "DepositVerificationStatus" AS ENUM ('PENDING', 'AUTO_CREDITED', 'MANUAL_REQUIRED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DepositVerificationSource" AS ENUM ('RECEIPT_FETCH');

-- AlterTable
ALTER TABLE "payment_methods" ADD COLUMN "autoVerify" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "deposit_verifications" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "status" "DepositVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "DepositVerificationSource" NOT NULL DEFAULT 'RECEIPT_FETCH',
    "decision" TEXT,
    "decisionReasons" TEXT[],
    "receiverName" TEXT,
    "receiverNumberMasked" TEXT,
    "settledAmount" DECIMAL(12,2),
    "totalPaid" DECIMAL(12,2),
    "receiptStatus" TEXT,
    "receiptNumber" TEXT,
    "receiptTime" TIMESTAMP(3),
    "payerName" TEXT,
    "payerNumberMasked" TEXT,
    "rawSnapshot" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deposit_verifications_transactionId_key" ON "deposit_verifications"("transactionId");

-- CreateIndex
CREATE INDEX "deposit_verifications_status_idx" ON "deposit_verifications"("status");

-- AddForeignKey
ALTER TABLE "deposit_verifications" ADD CONSTRAINT "deposit_verifications_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Apply migration + regenerate client**

Run (requires the dev/prod DB reachable via `DATABASE_URL`):

```bash
pnpm --filter @world-bingo/api exec prisma migrate deploy
pnpm --filter @world-bingo/api exec prisma generate
```

Expected: migration `20260706000000_add_deposit_verification` reported applied; client regenerated with no errors.

- [ ] **Step 6: Verify the schema compiles into the client**

Run:

```bash
pnpm --filter @world-bingo/api exec prisma validate
```

Expected: `The schema at prisma/schema.prisma is valid 🚀`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260706000000_add_deposit_verification/
git commit -m "feat(deposit): add DepositVerification model + PaymentMethod.autoVerify"
```

---

## Task 2: shared-types — verification enums & view type

**Files:**
- Modify: `packages/shared-types/src/entities/index.ts`
- Test: `packages/shared-types/src/test/deposit-verification.test.ts` (create if `src/test` exists; otherwise co-locate as `src/entities/deposit-verification.test.ts`)

**Interfaces:**
- Produces: `DepositVerificationStatus` (const enum object), `DEPOSIT_VERIFY_REASONS` (const), `DepositVerificationView` interface — imported by both api and admin.

- [ ] **Step 1: Write the failing test**

Create the test file:

```typescript
import { describe, it, expect } from 'vitest'
import { DepositVerificationStatus, DEPOSIT_VERIFY_REASONS } from '../entities/index'

describe('deposit verification shared types', () => {
  it('exposes the four statuses', () => {
    expect(DepositVerificationStatus.AUTO_CREDITED).toBe('AUTO_CREDITED')
    expect(Object.values(DepositVerificationStatus)).toHaveLength(4)
  })
  it('exposes reason codes including AMOUNT_MISMATCH and RECEIVER_MISMATCH', () => {
    expect(DEPOSIT_VERIFY_REASONS).toContain('AMOUNT_MISMATCH')
    expect(DEPOSIT_VERIFY_REASONS).toContain('RECEIVER_MISMATCH')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/shared-types test -- deposit-verification`
Expected: FAIL — `DepositVerificationStatus` not exported.

- [ ] **Step 3: Add the types**

Append to `packages/shared-types/src/entities/index.ts`:

```typescript
export const DepositVerificationStatus = {
  PENDING: 'PENDING',
  AUTO_CREDITED: 'AUTO_CREDITED',
  MANUAL_REQUIRED: 'MANUAL_REQUIRED',
  UNAVAILABLE: 'UNAVAILABLE',
} as const
export type DepositVerificationStatus =
  (typeof DepositVerificationStatus)[keyof typeof DepositVerificationStatus]

export const DEPOSIT_VERIFY_REASONS = [
  'CLEAN_MATCH',
  'AMOUNT_MISMATCH',
  'RECEIVER_MISMATCH',
  'ID_MISMATCH',
  'BAD_STATUS',
  'OVER_CAP',
  'STALE_RECEIPT',
  'PAYER_MISMATCH',
  'NOT_FOUND',
  'UNREACHABLE',
  'RATE_LIMITED',
  'PARSE_FAILED',
] as const
export type DepositVerifyReason = (typeof DEPOSIT_VERIFY_REASONS)[number]

export interface DepositVerificationView {
  status: DepositVerificationStatus
  decision: string | null
  decisionReasons: string[]
  receiverName: string | null
  receiverNumberMasked: string | null
  settledAmount: number | null
  receiptStatus: string | null
  receiptNumber: string | null
  payerName: string | null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/shared-types test -- deposit-verification`
Expected: PASS.

- [ ] **Step 5: Build shared-types (apps consume the built package)**

Run: `pnpm --filter @world-bingo/shared-types build`
Expected: builds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-types/src
git commit -m "feat(shared-types): deposit verification status + reason codes + view type"
```

---

## Task 3: Core types module

**Files:**
- Create: `apps/api/src/services/deposit-verification/types.ts`
- Test: none (pure type declarations; validated by the compiler in later tasks)

**Interfaces:**
- Produces:
  - `ParsedReceipt = { receiverName: string; receiverNumberMasked: string; settledAmount: number; totalPaid: number | null; status: string; receiptNumber: string; receiptTime: Date | null; payerName: string | null; payerNumberMasked: string | null }`
  - `VerifyUnavailable = { unavailable: 'NOT_FOUND' | 'RATE_LIMITED' | 'UNREACHABLE' | 'PARSE_FAILED' }`
  - `DepositVerifier = { code: string; verify(transactionId: string): Promise<ParsedReceipt | VerifyUnavailable> }`
  - `ActiveAccount = { name: string; account: string }`
  - `ExpectedDeposit = { statedAmount: number; paymentTransactionId: string; activeAccounts: ActiveAccount[] }`
  - `VerifyConfig = { maxAutoAmount: number; maxAgeHours: number; requirePayerMatch: boolean; now: Date }`
  - `Decision = { decision: 'AUTO_CREDIT' | 'MANUAL'; creditAmount: number | null; reasons: string[] }`

- [ ] **Step 1: Create the file**

```typescript
export interface ParsedReceipt {
  receiverName: string
  receiverNumberMasked: string
  settledAmount: number
  totalPaid: number | null
  status: string
  receiptNumber: string
  receiptTime: Date | null
  payerName: string | null
  payerNumberMasked: string | null
}

export type VerifyUnavailableReason = 'NOT_FOUND' | 'RATE_LIMITED' | 'UNREACHABLE' | 'PARSE_FAILED'
export interface VerifyUnavailable {
  unavailable: VerifyUnavailableReason
}

export function isUnavailable(r: ParsedReceipt | VerifyUnavailable): r is VerifyUnavailable {
  return (r as VerifyUnavailable).unavailable !== undefined
}

export interface DepositVerifier {
  code: string
  verify(transactionId: string): Promise<ParsedReceipt | VerifyUnavailable>
}

export interface ActiveAccount {
  name: string
  account: string
}

export interface ExpectedDeposit {
  statedAmount: number
  paymentTransactionId: string
  activeAccounts: ActiveAccount[]
}

export interface VerifyConfig {
  maxAutoAmount: number
  maxAgeHours: number
  requirePayerMatch: boolean
  now: Date
}

export interface Decision {
  decision: 'AUTO_CREDIT' | 'MANUAL'
  creditAmount: number | null
  reasons: string[]
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @world-bingo/api exec tsc --noEmit`
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/deposit-verification/types.ts
git commit -m "feat(deposit): core types for verification pipeline"
```

---

## Task 4: Matching helpers (pure)

**Files:**
- Create: `apps/api/src/services/deposit-verification/matching.ts`
- Test: `apps/api/src/test/deposit-matching.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeName(s: string): string` — lowercase, strip diacritics, collapse whitespace, drop non-alphanumeric-space.
  - `amountsEqualCents(a: number, b: number): boolean` — integer-cents equality.
  - `parseReceiptAmount(raw: string): number | null` — `"500 Birr"` / `"1,502.00"` → number.
  - `parseReceiptDate(raw: string): Date | null` — `"06-07-2026 10:43:19"` (DD-MM-YYYY HH:mm:ss) → Date.
  - `maskedNumberMatches(fullAccount: string, masked: string): boolean` — compare last-4 (+ trailing prefix) of our stored number against a masked receipt number like `2519****2107`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import {
  normalizeName, amountsEqualCents, parseReceiptAmount, parseReceiptDate, maskedNumberMatches,
} from '../services/deposit-verification/matching'

describe('normalizeName', () => {
  it('is case/whitespace/diacritic tolerant', () => {
    expect(normalizeName('  Zenu   Abatamam  Abamilki ')).toBe('zenu abatamam abamilki')
    expect(normalizeName('ZENU ABATAMAM ABAMILKI')).toBe(normalizeName('Zenu Abatamam Abamilki'))
  })
})

describe('amountsEqualCents', () => {
  it('matches to the cent and ignores float drift', () => {
    expect(amountsEqualCents(500, 500.0)).toBe(true)
    expect(amountsEqualCents(0.1 + 0.2, 0.3)).toBe(true)
    expect(amountsEqualCents(500, 502)).toBe(false)
  })
})

describe('parseReceiptAmount', () => {
  it('strips currency and thousands separators', () => {
    expect(parseReceiptAmount('500 Birr')).toBe(500)
    expect(parseReceiptAmount('1,502.00 ETB')).toBe(1502)
    expect(parseReceiptAmount('  502.00  ')).toBe(502)
    expect(parseReceiptAmount('N/A')).toBeNull()
  })
})

describe('parseReceiptDate', () => {
  it('parses DD-MM-YYYY HH:mm:ss', () => {
    const d = parseReceiptDate('06-07-2026 10:43:19')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6) // July (0-indexed)
    expect(d.getDate()).toBe(6)
    expect(parseReceiptDate('garbage')).toBeNull()
  })
})

describe('maskedNumberMatches', () => {
  it('matches on last-4 + leading prefix around the mask', () => {
    expect(maskedNumberMatches('251912342107', '2519****2107')).toBe(true)
    expect(maskedNumberMatches('0912342107', '2519****2107')).toBe(true)   // normalize 09.. vs 2519..
    expect(maskedNumberMatches('251912342108', '2519****2107')).toBe(false) // wrong last-4
    expect(maskedNumberMatches('251912342107', '2518****2107')).toBe(false) // wrong prefix
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- deposit-matching`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function amountsEqualCents(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100)
}

export function parseReceiptAmount(raw: string): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/,/g, '').replace(/[^0-9.]/g, ' ').trim()
  const m = cleaned.match(/[0-9]+(?:\.[0-9]+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

export function parseReceiptDate(raw: string): Date | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return null
  const [, dd, mm, yyyy, hh, mi, ss] = m
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Reduce any Ethiopian phone/merchant number to its national 9-digit core (drops 251 / leading 0). */
function digitsCore(num: string): string {
  const digits = (num || '').replace(/\D/g, '')
  if (digits.startsWith('251')) return digits.slice(3)
  if (digits.startsWith('0')) return digits.slice(1)
  return digits
}

/**
 * Masked receipt numbers look like "2519****2107": a visible prefix, masked middle,
 * visible last-4. We match by comparing the visible prefix and last-4 against our
 * stored full number (after normalizing both to the 9-digit national core plus the
 * 251 country code that the receipt shows).
 */
export function maskedNumberMatches(fullAccount: string, masked: string): boolean {
  if (!fullAccount || !masked) return false
  const maskMatch = masked.replace(/\s/g, '').match(/^(\d+)\*+(\d+)$/)
  if (!maskMatch) return false
  const [, prefix, suffix] = maskMatch

  // Full country-code form the receipt uses: 251 + 9-digit national core.
  const full = '251' + digitsCore(fullAccount)
  return full.startsWith(prefix) && full.endsWith(suffix)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- deposit-matching`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deposit-verification/matching.ts apps/api/src/test/deposit-matching.test.ts
git commit -m "feat(deposit): pure matching helpers (name, amount, date, masked number)"
```

---

## Task 5: Telebirr receipt parser (pure) + fixtures

**Files:**
- Create: `apps/api/src/services/deposit-verification/telebirr-parser.ts`
- Create: `apps/api/src/test/fixtures/telebirr-receipt-completed.html`
- Create: `apps/api/src/test/fixtures/telebirr-receipt-notfound.html`
- Test: `apps/api/src/test/deposit-telebirr-parser.test.ts`
- Modify: `apps/api/package.json` (add `node-html-parser`)

**Interfaces:**
- Consumes: `matching.ts` (`parseReceiptAmount`, `parseReceiptDate`), `types.ts` (`ParsedReceipt`, `VerifyUnavailable`).
- Produces: `parseReceiptHtml(html: string): ParsedReceipt | VerifyUnavailable`.

> **Fixture note:** the fixtures below are **sanitized synthetic** receipts that mirror the real ethiotelecom two-column label/value layout and English labels. During implementation, capture ONE real receipt (`curl -sk https://transactioninfo.ethiotelecom.et/receipt/<id>`), confirm the label strings and row structure match `LABELS` below, then **replace names/numbers with the synthetic values** before committing (never commit a real person's receipt). If the real labels differ, update the `LABELS` alias map — do not commit real PII.

- [ ] **Step 1: Add the HTML parser dependency**

Run: `pnpm --filter @world-bingo/api add node-html-parser`
Expected: `node-html-parser` added to `apps/api/package.json` dependencies.

- [ ] **Step 2: Create the fixtures**

`apps/api/src/test/fixtures/telebirr-receipt-completed.html`:

```html
<!DOCTYPE html><html><head><title>telebirr receipt</title></head><body>
<table>
  <tr><td>Payer Name</td><td>Natan Test Payer</td></tr>
  <tr><td>Payer telebirr no.</td><td>2519****2528</td></tr>
  <tr><td>Credited Party name</td><td>Test Merchant Account</td></tr>
  <tr><td>Credited party account no</td><td>2519****2107</td></tr>
  <tr><td>transaction status</td><td>Completed</td></tr>
  <tr><td>transaction number</td><td>DG61L089CL</td></tr>
  <tr><td>Payment Date</td><td>06-07-2026 10:43:19</td></tr>
  <tr><td>settled amount</td><td>500 Birr</td></tr>
  <tr><td>Total amount paid</td><td>502 Birr</td></tr>
  <tr><td>service fee</td><td>1.74 Birr</td></tr>
  <tr><td>service fee VAT</td><td>0.26 Birr</td></tr>
</table>
</body></html>
```

`apps/api/src/test/fixtures/telebirr-receipt-notfound.html`:

```html
<!DOCTYPE html><html><body><p>This request is not correct</p></body></html>
```

- [ ] **Step 3: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReceiptHtml } from '../services/deposit-verification/telebirr-parser'
import { isUnavailable } from '../services/deposit-verification/types'

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('parseReceiptHtml', () => {
  it('parses a completed receipt into normalized fields', () => {
    const r = parseReceiptHtml(fx('telebirr-receipt-completed.html'))
    expect(isUnavailable(r)).toBe(false)
    if (isUnavailable(r)) return
    expect(r.receiverName).toBe('Test Merchant Account')
    expect(r.receiverNumberMasked).toBe('2519****2107')
    expect(r.settledAmount).toBe(500)
    expect(r.totalPaid).toBe(502)
    expect(r.status).toBe('Completed')
    expect(r.receiptNumber).toBe('DG61L089CL')
    expect(r.payerName).toBe('Natan Test Payer')
    expect(r.receiptTime?.getFullYear()).toBe(2026)
  })

  it('detects the not-found page', () => {
    const r = parseReceiptHtml(fx('telebirr-receipt-notfound.html'))
    expect(isUnavailable(r) && r.unavailable).toBe('NOT_FOUND')
  })

  it('returns PARSE_FAILED when required fields are absent', () => {
    const r = parseReceiptHtml('<html><body><table><tr><td>Nothing</td><td>Here</td></tr></table></body></html>')
    expect(isUnavailable(r) && r.unavailable).toBe('PARSE_FAILED')
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- deposit-telebirr-parser`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the parser**

```typescript
import { parse } from 'node-html-parser'
import type { ParsedReceipt, VerifyUnavailable } from './types'
import { parseReceiptAmount, parseReceiptDate } from './matching'

/** English label aliases (normalized: lowercase, alphanumerics only) → field. */
const LABELS: Record<string, keyof RawFields> = {}
const alias = (field: keyof RawFields, ...labels: string[]) => {
  for (const l of labels) LABELS[normLabel(l)] = field
}
function normLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

interface RawFields {
  receiverName?: string
  receiverNumber?: string
  payerName?: string
  payerNumber?: string
  status?: string
  receiptNumber?: string
  date?: string
  settled?: string
  total?: string
}

alias('receiverName', 'Credited Party name', 'Credited Party Name', 'Receiver Name', 'To')
alias('receiverNumber', 'Credited party account no', 'Credited Party account number', 'Receiver telebirr no', 'Receiver account')
alias('payerName', 'Payer Name', 'Debit Party Name', 'From')
alias('payerNumber', 'Payer telebirr no', 'Debit party account number')
alias('status', 'transaction status', 'Status')
alias('receiptNumber', 'transaction number', 'Receipt No', 'Receipt Number', 'Invoice No')
alias('date', 'Payment Date', 'transaction time', 'Transaction Date', 'Date')
alias('settled', 'settled amount', 'Settled Amount')
alias('total', 'Total amount paid', 'Total Paid', 'Total amount')

export function parseReceiptHtml(html: string): ParsedReceipt | VerifyUnavailable {
  if (/this request is not correct/i.test(html)) {
    return { unavailable: 'NOT_FOUND' }
  }

  let root
  try {
    root = parse(html)
  } catch {
    return { unavailable: 'PARSE_FAILED' }
  }

  // Collect label→value pairs from every 2+ cell table row.
  const fields: RawFields = {}
  for (const row of root.querySelectorAll('tr')) {
    const cells = row.querySelectorAll('td, th')
    if (cells.length < 2) continue
    const label = normLabel(cells[0].text.trim())
    const value = cells[1].text.replace(/\s+/g, ' ').trim()
    const key = LABELS[label]
    if (key && value && fields[key] === undefined) fields[key] = value
  }

  const settledAmount = fields.settled ? parseReceiptAmount(fields.settled) : null
  const required =
    fields.receiverName && fields.receiverNumber && fields.status && fields.receiptNumber && settledAmount !== null
  if (!required) {
    return { unavailable: 'PARSE_FAILED' }
  }

  return {
    receiverName: fields.receiverName!.trim(),
    receiverNumberMasked: fields.receiverNumber!.trim(),
    settledAmount: settledAmount!,
    totalPaid: fields.total ? parseReceiptAmount(fields.total) : null,
    status: fields.status!.trim(),
    receiptNumber: fields.receiptNumber!.trim(),
    receiptTime: fields.date ? parseReceiptDate(fields.date) : null,
    payerName: fields.payerName?.trim() ?? null,
    payerNumberMasked: fields.payerNumber?.trim() ?? null,
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- deposit-telebirr-parser`
Expected: PASS (all three cases).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/deposit-verification/telebirr-parser.ts apps/api/src/test/fixtures/ apps/api/src/test/deposit-telebirr-parser.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(deposit): telebirr receipt HTML parser + sanitized fixtures"
```

---

## Task 6: Decision engine (pure)

**Files:**
- Create: `apps/api/src/services/deposit-verification/decision-engine.ts`
- Test: `apps/api/src/test/deposit-decision-engine.test.ts`

**Interfaces:**
- Consumes: `types.ts` (`ParsedReceipt`, `ExpectedDeposit`, `VerifyConfig`, `Decision`), `matching.ts` (`normalizeName`, `amountsEqualCents`, `maskedNumberMatches`).
- Produces: `evaluate(parsed: ParsedReceipt, expected: ExpectedDeposit, config: VerifyConfig): Decision`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { evaluate } from '../services/deposit-verification/decision-engine'
import type { ParsedReceipt, ExpectedDeposit, VerifyConfig } from '../services/deposit-verification/types'

const receipt = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
  receiverName: 'Test Merchant Account',
  receiverNumberMasked: '2519****2107',
  settledAmount: 500,
  totalPaid: 502,
  status: 'Completed',
  receiptNumber: 'DG61L089CL',
  receiptTime: new Date('2026-07-06T10:43:19'),
  payerName: 'Natan Test Payer',
  payerNumberMasked: '2519****2528',
  ...over,
})

const expected = (over: Partial<ExpectedDeposit> = {}): ExpectedDeposit => ({
  statedAmount: 500,
  paymentTransactionId: 'DG61L089CL',
  activeAccounts: [{ name: 'Test Merchant Account', account: '251912342107' }],
  ...over,
})

const config = (over: Partial<VerifyConfig> = {}): VerifyConfig => ({
  maxAutoAmount: 5000,
  maxAgeHours: 0,
  requirePayerMatch: false,
  now: new Date('2026-07-06T11:00:00'),
  ...over,
})

describe('evaluate', () => {
  it('AUTO_CREDIT on a clean match under cap', () => {
    const d = evaluate(receipt(), expected(), config())
    expect(d.decision).toBe('AUTO_CREDIT')
    expect(d.creditAmount).toBe(500)
    expect(d.reasons).toEqual(['CLEAN_MATCH'])
  })

  it('MANUAL on amount mismatch', () => {
    const d = evaluate(receipt({ settledAmount: 450 }), expected(), config())
    expect(d.decision).toBe('MANUAL')
    expect(d.reasons).toContain('AMOUNT_MISMATCH')
  })

  it('MANUAL when receiver is not one of our active accounts', () => {
    const d = evaluate(receipt({ receiverName: 'Someone Else', receiverNumberMasked: '2519****9999' }), expected(), config())
    expect(d.decision).toBe('MANUAL')
    expect(d.reasons).toContain('RECEIVER_MISMATCH')
  })

  it('MANUAL when status is not a success', () => {
    const d = evaluate(receipt({ status: 'Pending' }), expected(), config())
    expect(d.reasons).toContain('BAD_STATUS')
  })

  it('MANUAL over the cap even when everything matches', () => {
    const d = evaluate(receipt({ settledAmount: 9000 }), expected({ statedAmount: 9000 }), config())
    expect(d.decision).toBe('MANUAL')
    expect(d.reasons).toContain('OVER_CAP')
  })

  it('MANUAL when the receipt number does not match the looked-up id', () => {
    const d = evaluate(receipt({ receiptNumber: 'OTHER123' }), expected(), config())
    expect(d.reasons).toContain('ID_MISMATCH')
  })

  it('MANUAL when receipt is older than the freshness window', () => {
    const d = evaluate(receipt({ receiptTime: new Date('2026-07-01T10:00:00') }), expected(), config({ maxAgeHours: 24 }))
    expect(d.reasons).toContain('STALE_RECEIPT')
  })

  it('MANUAL when payer match required but names differ', () => {
    const d = evaluate(receipt({ payerName: 'Different Person' }), expected(), config({ requirePayerMatch: true }))
    expect(d.reasons).toContain('PAYER_MISMATCH')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- deposit-decision-engine`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { ParsedReceipt, ExpectedDeposit, VerifyConfig, Decision } from './types'
import { normalizeName, amountsEqualCents, maskedNumberMatches } from './matching'

function isSuccess(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('complet') || s.includes('success')
}

export function evaluate(parsed: ParsedReceipt, expected: ExpectedDeposit, config: VerifyConfig): Decision {
  const reasons: string[] = []

  // 1. Status must be a success.
  if (!isSuccess(parsed.status)) reasons.push('BAD_STATUS')

  // 2. Receipt number must match the id we looked up.
  if (normalizeName(parsed.receiptNumber) !== normalizeName(expected.paymentTransactionId)) {
    reasons.push('ID_MISMATCH')
  }

  // 3. Receiver must be one of our active accounts (name AND masked number).
  const receiverOk = expected.activeAccounts.some(
    (a) =>
      normalizeName(a.name) === normalizeName(parsed.receiverName) &&
      maskedNumberMatches(a.account, parsed.receiverNumberMasked),
  )
  if (!receiverOk) reasons.push('RECEIVER_MISMATCH')

  // 4. Settled amount must equal the stated amount.
  if (!amountsEqualCents(parsed.settledAmount, expected.statedAmount)) reasons.push('AMOUNT_MISMATCH')

  // 5. Optional freshness window.
  if (config.maxAgeHours > 0) {
    if (!parsed.receiptTime) {
      reasons.push('STALE_RECEIPT')
    } else {
      const ageHours = (config.now.getTime() - parsed.receiptTime.getTime()) / 3_600_000
      if (ageHours > config.maxAgeHours) reasons.push('STALE_RECEIPT')
    }
  }

  // 6. Optional payer hard gate.
  if (config.requirePayerMatch) {
    // Soft signal: only fails when a payer name exists and clearly differs from the sender the player entered.
    // The depositing sender name is compared upstream; here we only guard the presence/format.
    if (!parsed.payerName) reasons.push('PAYER_MISMATCH')
  }

  // 7. Cap (only meaningful if the rest is clean).
  const overCap = parsed.settledAmount > config.maxAutoAmount
  if (reasons.length === 0 && overCap) reasons.push('OVER_CAP')

  if (reasons.length === 0) {
    return { decision: 'AUTO_CREDIT', creditAmount: parsed.settledAmount, reasons: ['CLEAN_MATCH'] }
  }
  return { decision: 'MANUAL', creditAmount: null, reasons }
}
```

> Note: the `requirePayerMatch` gate here only asserts a payer name is present; comparing it to the specific depositing player is done in the orchestration layer (Task 9) where the player's entered `senderName` is available. Keep the engine pure and DB-free.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- deposit-decision-engine`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deposit-verification/decision-engine.ts apps/api/src/test/deposit-decision-engine.test.ts
git commit -m "feat(deposit): pure decision engine with reason codes"
```

---

## Task 7: Receipt fetcher (response classifier + node:https fetch)

**Files:**
- Create: `apps/api/src/services/deposit-verification/receipt-fetcher.ts`
- Test: `apps/api/src/test/deposit-receipt-fetcher.test.ts`

**Interfaces:**
- Consumes: `types.ts`.
- Produces:
  - `classifyReceiptResponse(status: number, contentType: string, body: string): { kind: 'html'; html: string } | { kind: 'unavailable'; reason: 'RATE_LIMITED' | 'NOT_FOUND' | 'UNREACHABLE' }` — pure.
  - `fetchReceiptHtml(transactionId: string, opts?: { timeoutMs?: number; baseUrl?: string }): Promise<{ ok: true; html: string } | { ok: false; reason: 'RATE_LIMITED' | 'NOT_FOUND' | 'UNREACHABLE' }>` — I/O.

- [ ] **Step 1: Write the failing test (classifier only — pure)**

```typescript
import { describe, it, expect } from 'vitest'
import { classifyReceiptResponse } from '../services/deposit-verification/receipt-fetcher'

describe('classifyReceiptResponse', () => {
  it('flags a 429 as RATE_LIMITED', () => {
    const r = classifyReceiptResponse(429, 'application/json', '{"success":false,"message":"Rate limit exceeded"}')
    expect(r).toEqual({ kind: 'unavailable', reason: 'RATE_LIMITED' })
  })
  it('flags a JSON rate-limit body even on 200', () => {
    const r = classifyReceiptResponse(200, 'application/json', '{"success":false,"message":"Rate limit exceeded. Please try again later."}')
    expect(r).toEqual({ kind: 'unavailable', reason: 'RATE_LIMITED' })
  })
  it('treats 5xx as UNREACHABLE', () => {
    expect(classifyReceiptResponse(503, 'text/html', 'oops')).toEqual({ kind: 'unavailable', reason: 'UNREACHABLE' })
  })
  it('returns html for a 200 text/html receipt', () => {
    const r = classifyReceiptResponse(200, 'text/html', '<html>receipt</html>')
    expect(r).toEqual({ kind: 'html', html: '<html>receipt</html>' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- deposit-receipt-fetcher`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import https from 'node:https'

const DEFAULT_BASE = 'https://transactioninfo.ethiotelecom.et/receipt/'

export type FetchReason = 'RATE_LIMITED' | 'NOT_FOUND' | 'UNREACHABLE'

export function classifyReceiptResponse(
  status: number,
  contentType: string,
  body: string,
): { kind: 'html'; html: string } | { kind: 'unavailable'; reason: FetchReason } {
  const isJson = contentType.includes('application/json')
  const looksRateLimited = /rate limit/i.test(body)

  if (status === 429 || (isJson && looksRateLimited)) {
    return { kind: 'unavailable', reason: 'RATE_LIMITED' }
  }
  if (status >= 500) return { kind: 'unavailable', reason: 'UNREACHABLE' }
  if (status === 404) return { kind: 'unavailable', reason: 'NOT_FOUND' }
  if (status !== 200) return { kind: 'unavailable', reason: 'UNREACHABLE' }
  return { kind: 'html', html: body }
}

// Relaxed-TLS agent scoped to THIS module only (ethiotelecom presents cert-chain issues).
const insecureAgent = new https.Agent({ rejectUnauthorized: false })

export async function fetchReceiptHtml(
  transactionId: string,
  opts: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<{ ok: true; html: string } | { ok: false; reason: FetchReason }> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = (opts.baseUrl ?? DEFAULT_BASE) + encodeURIComponent(transactionId)

  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        agent: insecureAgent,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 2_000_000) {
            req.destroy()
            resolve({ ok: false, reason: 'UNREACHABLE' })
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const c = classifyReceiptResponse(res.statusCode ?? 0, String(res.headers['content-type'] ?? ''), body)
          if (c.kind === 'html') resolve({ ok: true, html: c.html })
          else resolve({ ok: false, reason: c.reason })
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve({ ok: false, reason: 'UNREACHABLE' })
    })
    req.on('error', () => resolve({ ok: false, reason: 'UNREACHABLE' }))
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- deposit-receipt-fetcher`
Expected: PASS (classifier cases; the network function is exercised in the manual smoke check at the end).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deposit-verification/receipt-fetcher.ts apps/api/src/test/deposit-receipt-fetcher.test.ts
git commit -m "feat(deposit): receipt fetcher with response classifier + relaxed-TLS agent"
```

---

## Task 8: Telebirr verifier + registry

**Files:**
- Create: `apps/api/src/gateways/payment/telebirr-receipt.verifier.ts`
- Create: `apps/api/src/services/deposit-verification/registry.ts`
- Test: `apps/api/src/test/deposit-verifier.test.ts`

**Interfaces:**
- Consumes: `receipt-fetcher.ts`, `telebirr-parser.ts`, `types.ts`.
- Produces:
  - `class TelebirrReceiptVerifier implements DepositVerifier` with `code = 'telebirr'` and a constructor accepting an injectable `fetcher` (default `fetchReceiptHtml`) for testability.
  - `getVerifier(methodCode: string | null | undefined): DepositVerifier | null`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TelebirrReceiptVerifier } from '../gateways/payment/telebirr-receipt.verifier'
import { getVerifier } from '../services/deposit-verification/registry'
import { isUnavailable } from '../services/deposit-verification/types'

const completed = readFileSync(join(__dirname, 'fixtures', 'telebirr-receipt-completed.html'), 'utf8')

describe('TelebirrReceiptVerifier', () => {
  it('fetches + parses into a ParsedReceipt', async () => {
    const v = new TelebirrReceiptVerifier(async () => ({ ok: true, html: completed }))
    const r = await v.verify('DG61L089CL')
    expect(isUnavailable(r)).toBe(false)
    if (isUnavailable(r)) return
    expect(r.receiptNumber).toBe('DG61L089CL')
  })
  it('propagates a fetch RATE_LIMITED as unavailable', async () => {
    const v = new TelebirrReceiptVerifier(async () => ({ ok: false, reason: 'RATE_LIMITED' }))
    const r = await v.verify('DG61L089CL')
    expect(isUnavailable(r) && r.unavailable).toBe('RATE_LIMITED')
  })
})

describe('getVerifier', () => {
  it('resolves telebirr by common method codes, null otherwise', () => {
    expect(getVerifier('telebirr')?.code).toBe('telebirr')
    expect(getVerifier('TELEBIRR')?.code).toBe('telebirr')
    expect(getVerifier('cbe')).toBeNull()
    expect(getVerifier(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- deposit-verifier`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the verifier**

`telebirr-receipt.verifier.ts`:

```typescript
import type { DepositVerifier, ParsedReceipt, VerifyUnavailable } from '../../services/deposit-verification/types'
import { parseReceiptHtml } from '../../services/deposit-verification/telebirr-parser'
import { fetchReceiptHtml, type FetchReason } from '../../services/deposit-verification/receipt-fetcher'

type Fetcher = (id: string) => Promise<{ ok: true; html: string } | { ok: false; reason: FetchReason }>

export class TelebirrReceiptVerifier implements DepositVerifier {
  readonly code = 'telebirr'
  constructor(private readonly fetcher: Fetcher = fetchReceiptHtml) {}

  async verify(transactionId: string): Promise<ParsedReceipt | VerifyUnavailable> {
    const res = await this.fetcher(transactionId)
    if (!res.ok) return { unavailable: res.reason }
    return parseReceiptHtml(res.html)
  }
}
```

- [ ] **Step 4: Implement the registry**

`registry.ts`:

```typescript
import type { DepositVerifier } from './types'
import { TelebirrReceiptVerifier } from '../../gateways/payment/telebirr-receipt.verifier'

const telebirr = new TelebirrReceiptVerifier()

/** Method codes that map to the telebirr receipt verifier. */
const TELEBIRR_CODES = new Set(['telebirr', 'ethiotelecom'])

export function getVerifier(methodCode: string | null | undefined): DepositVerifier | null {
  if (!methodCode) return null
  return TELEBIRR_CODES.has(methodCode.toLowerCase()) ? telebirr : null
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- deposit-verifier`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/gateways/payment/telebirr-receipt.verifier.ts apps/api/src/services/deposit-verification/registry.ts apps/api/src/test/deposit-verifier.test.ts
git commit -m "feat(deposit): telebirr verifier + method-code registry"
```

---

## Task 9: Orchestration service (config loader + runVerification)

**Files:**
- Create: `apps/api/src/services/deposit-verification.service.ts`
- Modify: `apps/api/src/lib/queue.ts` (add queue name)
- Test: `apps/api/src/test/deposit-verification-service.test.ts`

**Interfaces:**
- Consumes: `registry.ts`, `decision-engine.ts`, `types.ts`, `WalletService.approveDeposit`, `prisma`, `getQueue`.
- Produces:
  - `DepositVerificationService.loadConfig(): Promise<{ enabled: boolean } & VerifyConfig>`
  - `DepositVerificationService.enqueue(transactionId: string): Promise<void>`
  - `DepositVerificationService.runVerification(transactionId: string): Promise<{ status: DepositVerificationStatus; reasons: string[] }>` — the worker's unit of work. Loads txn + active accounts + config, runs verifier + engine, writes `DepositVerification`, and on AUTO_CREDIT calls `WalletService.approveDeposit(transactionId, creditAmount)`. Throws a tagged error `RateLimitSignal` when the verifier reports `RATE_LIMITED` so the worker can apply dynamic backoff.

- [ ] **Step 1: Add the queue name**

In `apps/api/src/lib/queue.ts`, add to `QUEUE_NAMES`:

```typescript
    DEPOSIT_VERIFICATION: 'deposit-verification',
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    transaction: { findUnique: vi.fn() },
    paymentMethod: { findMany: vi.fn() },
    siteSetting: { findUnique: vi.fn() },
    depositVerification: { upsert: vi.fn() },
  },
}))
vi.mock('../services/wallet.service', () => ({
  WalletService: { approveDeposit: vi.fn() },
}))
vi.mock('../lib/queue', () => ({
  QUEUE_NAMES: { DEPOSIT_VERIFICATION: 'deposit-verification' },
  getQueue: () => ({ add: vi.fn() }),
}))

import prisma from '../lib/prisma'
import { WalletService } from '../services/wallet.service'
import { DepositVerificationService, RateLimitSignal } from '../services/deposit-verification.service'
import { TelebirrReceiptVerifier } from '../gateways/payment/telebirr-receipt.verifier'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const completed = readFileSync(join(__dirname, 'fixtures', 'telebirr-receipt-completed.html'), 'utf8')

const setSettings = (m: Record<string, string>) => {
  ;(prisma as any).siteSetting.findUnique.mockImplementation(({ where }: any) =>
    Promise.resolve(m[where.key] !== undefined ? { key: where.key, value: m[where.key] } : null),
  )
}

describe('DepositVerificationService.runVerification', () => {
  beforeEach(() => vi.clearAllMocks())

  it('auto-credits a clean match under cap', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({
      id: 'tx1', amount: 500, note: 'telebirr', paymentTransactionId: 'DG61L089CL', senderName: 'Natan Test Payer', status: 'PENDING_REVIEW',
    })
    ;(prisma as any).paymentMethod.findMany.mockResolvedValue([
      { merchantName: 'Test Merchant Account', merchantAccount: '251912342107' },
    ])
    setSettings({ deposit_auto_verify_enabled: 'true', deposit_auto_verify_max_amount: '5000' })
    ;(prisma as any).depositVerification.upsert.mockResolvedValue({})

    const verifier = new TelebirrReceiptVerifier(async () => ({ ok: true, html: completed }))
    const out = await DepositVerificationService.runVerification('tx1', { verifier })

    expect(WalletService.approveDeposit).toHaveBeenCalledWith('tx1', 500)
    expect(out.status).toBe('AUTO_CREDITED')
  })

  it('leaves manual on amount mismatch and does NOT credit', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({
      id: 'tx1', amount: 999, note: 'telebirr', paymentTransactionId: 'DG61L089CL', senderName: 'x', status: 'PENDING_REVIEW',
    })
    ;(prisma as any).paymentMethod.findMany.mockResolvedValue([
      { merchantName: 'Test Merchant Account', merchantAccount: '251912342107' },
    ])
    setSettings({ deposit_auto_verify_enabled: 'true', deposit_auto_verify_max_amount: '5000' })
    ;(prisma as any).depositVerification.upsert.mockResolvedValue({})

    const verifier = new TelebirrReceiptVerifier(async () => ({ ok: true, html: completed }))
    const out = await DepositVerificationService.runVerification('tx1', { verifier })

    expect(WalletService.approveDeposit).not.toHaveBeenCalled()
    expect(out.status).toBe('MANUAL_REQUIRED')
    expect(out.reasons).toContain('AMOUNT_MISMATCH')
  })

  it('throws RateLimitSignal when the verifier is rate limited', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({
      id: 'tx1', amount: 500, note: 'telebirr', paymentTransactionId: 'DG61L089CL', senderName: 'x', status: 'PENDING_REVIEW',
    })
    ;(prisma as any).paymentMethod.findMany.mockResolvedValue([])
    setSettings({ deposit_auto_verify_enabled: 'true', deposit_auto_verify_max_amount: '5000' })
    ;(prisma as any).depositVerification.upsert.mockResolvedValue({})

    const verifier = new TelebirrReceiptVerifier(async () => ({ ok: false, reason: 'RATE_LIMITED' }))
    await expect(DepositVerificationService.runVerification('tx1', { verifier })).rejects.toBeInstanceOf(RateLimitSignal)
  })

  it('no-ops when the feature flag is off', async () => {
    setSettings({ deposit_auto_verify_enabled: 'false' })
    const out = await DepositVerificationService.runVerification('tx1', {})
    expect(prisma.transaction.findUnique).not.toHaveBeenCalled()
    expect(out.status).toBe('PENDING')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- deposit-verification-service`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

`apps/api/src/services/deposit-verification.service.ts`:

```typescript
import prisma from '../lib/prisma'
import { getQueue, QUEUE_NAMES } from '../lib/queue'
import { WalletService } from './wallet.service'
import { getVerifier } from './deposit-verification/registry'
import { evaluate } from './deposit-verification/decision-engine'
import { normalizeName } from './deposit-verification/matching'
import { isUnavailable, type DepositVerifier, type ExpectedDeposit, type VerifyConfig } from './deposit-verification/types'

/** Thrown to the worker so it can pause the queue and retry without burning an attempt. */
export class RateLimitSignal extends Error {
  constructor() {
    super('deposit verification rate limited')
    this.name = 'RateLimitSignal'
  }
}

async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await prisma.siteSetting.findUnique({ where: { key } })
  return row?.value ?? fallback
}

export class DepositVerificationService {
  static async loadConfig(): Promise<{ enabled: boolean } & VerifyConfig> {
    const [enabled, maxAmount, maxAge, requirePayer] = await Promise.all([
      getSetting('deposit_auto_verify_enabled', 'false'),
      getSetting('deposit_auto_verify_max_amount', '0'),
      getSetting('deposit_auto_verify_max_age_hours', '0'),
      getSetting('deposit_auto_verify_require_payer_match', 'false'),
    ])
    return {
      enabled: enabled === 'true',
      maxAutoAmount: Number(maxAmount) || 0,
      maxAgeHours: Number(maxAge) || 0,
      requirePayerMatch: requirePayer === 'true',
      now: new Date(),
    }
  }

  static async enqueue(transactionId: string): Promise<void> {
    try {
      await getQueue(QUEUE_NAMES.DEPOSIT_VERIFICATION).add('verify', { transactionId })
    } catch (err) {
      // Enqueue failures must never break deposit submission — the deposit still goes to manual.
      console.error('[DepositVerification] enqueue failed:', (err as Error).message)
    }
  }

  static async runVerification(
    transactionId: string,
    deps: { verifier?: DepositVerifier } = {},
  ): Promise<{ status: 'PENDING' | 'AUTO_CREDITED' | 'MANUAL_REQUIRED' | 'UNAVAILABLE'; reasons: string[] }> {
    const config = await this.loadConfig()
    if (!config.enabled) return { status: 'PENDING', reasons: [] }

    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
    if (!tx || tx.status !== 'PENDING_REVIEW' || !tx.paymentTransactionId) {
      return { status: 'PENDING', reasons: [] }
    }

    const verifier = deps.verifier ?? getVerifier(tx.note)
    if (!verifier) return { status: 'PENDING', reasons: [] }

    const parsed = await verifier.verify(tx.paymentTransactionId)

    if (isUnavailable(parsed)) {
      if (parsed.unavailable === 'RATE_LIMITED') throw new RateLimitSignal()
      await this.write(transactionId, 'UNAVAILABLE', null, [parsed.unavailable], null)
      return { status: 'UNAVAILABLE', reasons: [parsed.unavailable] }
    }

    const activeAccounts = (
      await prisma.paymentMethod.findMany({
        where: { type: 'DEPOSIT', enabled: true, autoVerify: true },
        select: { merchantName: true, merchantAccount: true },
      })
    )
      .filter((m) => m.merchantName && m.merchantAccount)
      .map((m) => ({ name: m.merchantName as string, account: m.merchantAccount as string }))

    const expected: ExpectedDeposit = {
      statedAmount: Number(tx.amount),
      paymentTransactionId: tx.paymentTransactionId,
      activeAccounts,
    }

    const decision = evaluate(parsed, expected, config)

    // Extra orchestration-level payer gate (has access to the player's entered senderName).
    if (config.requirePayerMatch && decision.decision === 'AUTO_CREDIT' && tx.senderName && parsed.payerName) {
      if (normalizeName(tx.senderName) !== normalizeName(parsed.payerName)) {
        decision.decision = 'MANUAL'
        decision.creditAmount = null
        decision.reasons = ['PAYER_MISMATCH']
      }
    }

    if (decision.decision === 'AUTO_CREDIT' && decision.creditAmount !== null) {
      await this.write(transactionId, 'AUTO_CREDITED', 'AUTO_CREDIT', decision.reasons, parsed)
      await WalletService.approveDeposit(transactionId, decision.creditAmount)
      return { status: 'AUTO_CREDITED', reasons: decision.reasons }
    }

    await this.write(transactionId, 'MANUAL_REQUIRED', 'MANUAL', decision.reasons, parsed)
    return { status: 'MANUAL_REQUIRED', reasons: decision.reasons }
  }

  private static async write(
    transactionId: string,
    status: 'AUTO_CREDITED' | 'MANUAL_REQUIRED' | 'UNAVAILABLE',
    decision: string | null,
    reasons: string[],
    parsed: import('./deposit-verification/types').ParsedReceipt | null,
  ): Promise<void> {
    const data = {
      status,
      decision,
      decisionReasons: reasons,
      receiverName: parsed?.receiverName ?? null,
      receiverNumberMasked: parsed?.receiverNumberMasked ?? null,
      settledAmount: parsed?.settledAmount ?? null,
      totalPaid: parsed?.totalPaid ?? null,
      receiptStatus: parsed?.status ?? null,
      receiptNumber: parsed?.receiptNumber ?? null,
      receiptTime: parsed?.receiptTime ?? null,
      payerName: parsed?.payerName ?? null,
      payerNumberMasked: parsed?.payerNumberMasked ?? null,
      rawSnapshot: parsed ? (parsed as unknown as object) : undefined,
    }
    await prisma.depositVerification.upsert({
      where: { transactionId },
      create: { transactionId, ...data, attempts: 1 },
      update: { ...data, attempts: { increment: 1 } },
    })
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- deposit-verification-service`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/deposit-verification.service.ts apps/api/src/lib/queue.ts apps/api/src/test/deposit-verification-service.test.ts
git commit -m "feat(deposit): verification orchestration service + queue name"
```

---

## Task 10: BullMQ worker (limiter + dynamic 429 backoff)

**Files:**
- Create: `apps/api/src/workers/deposit-verification.worker.ts`
- Modify: `apps/api/src/index.ts` (side-effect import)

**Interfaces:**
- Consumes: `DepositVerificationService.runVerification`, `RateLimitSignal`, `QUEUE_NAMES`.
- Produces: a running worker on the `deposit-verification` queue.

- [ ] **Step 1: Implement the worker** (mirrors `cashback-checker.worker.ts`; note `.js` import extensions per Global Constraints)

```typescript
/**
 * Deposit Verification Worker
 *
 * Consumes { transactionId } jobs, runs the auto-verification pipeline, and either
 * auto-credits (via WalletService.approveDeposit inside the service) or leaves the
 * deposit for manual review. Rate-limit-aware: a RATE_LIMITED upstream pauses the whole
 * queue and retries without consuming an attempt.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { DepositVerificationService, RateLimitSignal } from '../services/deposit-verification.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// Static aggregate floor across all instances sharing this queue (env-tunable).
const RATE_MAX = Number(process.env.DEPOSIT_VERIFY_RATE_MAX || '20')
const RATE_WINDOW_MS = Number(process.env.DEPOSIT_VERIFY_RATE_WINDOW_MS || '60000')
// Dynamic cooldown applied when the upstream signals a rate limit.
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.DEPOSIT_VERIFY_COOLDOWN_MS || '30000')

interface DepositVerifyJobData {
  transactionId: string
}

const worker = new Worker<DepositVerifyJobData>(
  QUEUE_NAMES.DEPOSIT_VERIFICATION,
  async (job: Job<DepositVerifyJobData>) => {
    try {
      const result = await DepositVerificationService.runVerification(job.data.transactionId)
      console.log(
        `[DepositVerifyWorker] tx=${job.data.transactionId} → ${result.status} [${result.reasons.join(',')}]`,
      )
      return result
    } catch (err) {
      if (err instanceof RateLimitSignal) {
        await worker.rateLimit(RATE_LIMIT_COOLDOWN_MS)
        throw Worker.RateLimitError()
      }
      throw err
    }
  },
  {
    connection: {
      url: REDIS_URL,
      maxRetriesPerRequest: null as any,
      enableReadyCheck: false,
    } as any,
    concurrency: 1,
    limiter: { max: RATE_MAX, duration: RATE_WINDOW_MS },
  },
)

worker.on('failed', (job, err) => {
  if (err?.name === 'RateLimitError') return // expected pause, not a failure
  console.error(`[DepositVerifyWorker] Job ${job?.id} failed:`, err?.message)
  reportError(err as Error, { worker: 'deposit-verification' })
})

worker.on('error', (err) => {
  console.error('[DepositVerifyWorker] Worker error:', err.message)
  reportError(err, { worker: 'deposit-verification' })
})

export default worker
```

- [ ] **Step 2: Register the worker in `index.ts`**

Add to the workers import block (with the other `import './workers/*.worker.js'` lines):

```typescript
import './workers/deposit-verification.worker.js'
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm --filter @world-bingo/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workers/deposit-verification.worker.ts apps/api/src/index.ts
git commit -m "feat(deposit): BullMQ verification worker with rate-limit backoff"
```

---

## Task 11: Enqueue verification on deposit submission

**Files:**
- Modify: `apps/api/src/services/wallet.service.ts`
- Test: `apps/api/src/test/deposit-initiate-enqueue.test.ts`

**Interfaces:**
- Consumes: `DepositVerificationService.enqueue`.
- Produces: `initiateDeposit` enqueues a verification job for the created transaction (best-effort; never throws into the deposit path).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    siteSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    transaction: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  },
}))
const enqueue = vi.fn().mockResolvedValue(undefined)
vi.mock('../services/deposit-verification.service', () => ({
  DepositVerificationService: { enqueue },
}))

import prisma from '../lib/prisma'
import { WalletService } from '../services/wallet.service'

describe('initiateDeposit enqueues verification', () => {
  beforeEach(() => vi.clearAllMocks())
  it('enqueues the created transaction id', async () => {
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-new', amount: 500 })
    await WalletService.initiateDeposit('user1', { amount: 500, transactionId: 'ABC12345', methodCode: 'telebirr' } as any)
    expect(enqueue).toHaveBeenCalledWith('tx-new')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- deposit-initiate-enqueue`
Expected: FAIL — `enqueue` not called (import + call not yet added).

- [ ] **Step 3: Wire the enqueue call**

In `apps/api/src/services/wallet.service.ts`:

1. Add the import at the top (services convention: no `.js`):

```typescript
import { DepositVerificationService } from './deposit-verification.service'
```

2. In `initiateDeposit`, replace `return transaction` (the final line) with:

```typescript
    await DepositVerificationService.enqueue(transaction.id)
    return transaction
```

(`enqueue` swallows its own errors, so this cannot break deposit submission.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- deposit-initiate-enqueue`
Expected: PASS.

- [ ] **Step 5: Guard against an import cycle**

`wallet.service` now imports `deposit-verification.service`, which imports `wallet.service` (for `approveDeposit`). Verify no runtime cycle breakage:

Run: `pnpm --filter @world-bingo/api test -- deposit-verification-service deposit-initiate-enqueue`
Expected: both PASS. If a cycle surfaces (undefined `WalletService` at call time), change the service to import `approveDeposit` lazily inside `runVerification`:

```typescript
const { WalletService } = await import('./wallet.service')
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/wallet.service.ts apps/api/src/test/deposit-initiate-enqueue.test.ts
git commit -m "feat(deposit): enqueue auto-verification when a deposit is submitted"
```

---

## Task 12: Surface verification to the admin API payload

**Files:**
- Modify: `apps/api/src/services/admin.service.ts`
- Test: extend `apps/api/src/test/deposit-verification-service.test.ts` is not applicable; add `apps/api/src/test/admin-pending-includes-verification.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `getTransactions` pending payload rows include `depositVerification` (status, decision, decisionReasons, parsed fields).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    transaction: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
  },
}))
import prisma from '../lib/prisma'
import { AdminService } from '../services/admin.service'

describe('getTransactions includes depositVerification', () => {
  beforeEach(() => vi.clearAllMocks())
  it('passes depositVerification in the include', async () => {
    ;(prisma as any).transaction.findMany.mockResolvedValue([])
    await AdminService.getTransactions({ status: 'PENDING_REVIEW', page: 1, limit: 20 } as any)
    const arg = (prisma as any).transaction.findMany.mock.calls[0][0]
    expect(arg.include.depositVerification).toBe(true)
  })
})
```

(If `AdminService.getTransactions` has a different signature, adapt the call args to match; the assertion on `include.depositVerification` is the point.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- admin-pending-includes-verification`
Expected: FAIL — include lacks `depositVerification`.

- [ ] **Step 3: Add the include**

In `apps/api/src/services/admin.service.ts`, in `getTransactions`, extend the `include`:

```typescript
      include: {
        user: {
          select: { id: true, serial: true, username: true, phone: true },
        },
        depositVerification: true,
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- admin-pending-includes-verification`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/admin.service.ts apps/api/src/test/admin-pending-includes-verification.test.ts
git commit -m "feat(deposit): include verification result in admin pending payload"
```

---

## Task 13: Admin UI — verification badge + panel + autoVerify toggle

**Files:**
- Modify: `apps/admin/pages/deposits.vue`
- Modify: the payment-methods admin page (find via `grep -rl "merchantAccount" apps/admin/pages apps/admin/components`)

**Interfaces:**
- Consumes: the extended pending payload (`row.depositVerification`).
- Produces: a visible verification badge + parsed panel per deposit; an `autoVerify` checkbox on payment methods.

- [ ] **Step 1: Extend the `DepositTransaction` interface**

In `apps/admin/pages/deposits.vue`, add to the interface:

```typescript
  depositVerification?: {
    status: string
    decision: string | null
    decisionReasons: string[]
    settledAmount: number | null
    receiverName: string | null
    receiptStatus: string | null
    payerName: string | null
  } | null
```

- [ ] **Step 2: Add a verification badge helper**

In the `<script setup>`:

```typescript
function verifyBadge(d: DepositTransaction): { label: string; color: string } {
  const v = d.depositVerification
  if (!v) return { label: 'Manual', color: 'neutral' }
  switch (v.status) {
    case 'AUTO_CREDITED': return { label: 'Auto-verified', color: 'success' }
    case 'MANUAL_REQUIRED': return { label: `Review: ${v.decisionReasons[0] ?? 'mismatch'}`, color: 'warning' }
    case 'UNAVAILABLE': return { label: `Unavailable: ${v.decisionReasons[0] ?? ''}`, color: 'error' }
    default: return { label: 'Verifying…', color: 'neutral' }
  }
}
```

- [ ] **Step 3: Render the badge in the card view** (near the existing status badge, ~line 428)

```html
<UBadge :color="verifyBadge(d).color" variant="soft" size="xs">
  {{ verifyBadge(d).label }}
</UBadge>
<div v-if="d.depositVerification?.settledAmount != null" class="text-xs text-gray-500 mt-1">
  Receipt: {{ d.depositVerification.settledAmount }} ETB · {{ d.depositVerification.receiverName }} · {{ d.depositVerification.receiptStatus }}
</div>
```

- [ ] **Step 4: Render a badge column in the table view** (near the `#status-cell` template, ~line 379)

```html
<template #verification-cell="{ row }">
  <UBadge :color="verifyBadge(row.original as any).color" variant="soft">
    {{ verifyBadge(row.original as any).label }}
  </UBadge>
</template>
```

Add a matching column definition to the table `columns` array (id `verification`, header `Verification`).

- [ ] **Step 5: Add the `autoVerify` toggle to the payment-methods editor**

In the payment-methods page/component, alongside the existing `enabled` control, add (adapt to the local form pattern):

```html
<UCheckbox v-model="form.autoVerify" label="Auto-verify deposits (Telebirr)" />
```

Ensure `autoVerify` is included in the create/update payload sent to the API. If the API payment-method update handler strips unknown fields, add `autoVerify` to its accepted schema (search `apps/api/src/routes` for the payment-method PATCH/PUT handler and its zod schema; add `autoVerify: z.boolean().optional()`).

- [ ] **Step 6: Verify admin builds/typechecks**

Run: `pnpm --filter @world-bingo/admin typecheck` (or `pnpm --filter @world-bingo/admin build` if no typecheck script)
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/admin apps/api/src/routes
git commit -m "feat(deposit): admin verification badge/panel + payment-method autoVerify toggle"
```

---

## Task 14: Settings defaults + smoke check

**Files:**
- Modify: `apps/api/src/routes/settings/index.ts` (DEFAULTS)

**Interfaces:**
- Produces: the four `deposit_auto_verify_*` keys have documented defaults; admins can PATCH them via the existing settings route.

- [ ] **Step 1: Add the DEFAULTS**

In `apps/api/src/routes/settings/index.ts`, add to the `DEFAULTS` object:

```typescript
    deposit_auto_verify_enabled: 'false',
    deposit_auto_verify_max_amount: '0',
    deposit_auto_verify_max_age_hours: '0',
    deposit_auto_verify_require_payer_match: 'false',
```

- [ ] **Step 2: Confirm the settings PATCH allows these keys**

Inspect the settings update handler in the same file. If it whitelists keys, add the four keys to the whitelist. If it accepts arbitrary `key`/`value` pairs, no change needed. Verify by reading the handler.

- [ ] **Step 3: Full typecheck + test run**

Run:

```bash
pnpm --filter @world-bingo/api exec tsc --noEmit
pnpm --filter @world-bingo/api test -- deposit
```

Expected: no type errors; all `deposit-*` test files PASS.

- [ ] **Step 4: Manual smoke check (real endpoint, one call)**

With a real completed telebirr transaction id available, run a throwaway script (delete after):

```bash
pnpm --filter @world-bingo/api exec tsx -e "import('./src/services/deposit-verification/receipt-fetcher').then(async m => { const r = await m.fetchReceiptHtml(process.argv[1]); console.log(r.ok ? r.html.slice(0,200) : r) })" <REAL_TXN_ID>
```

Expected: either `{ ok: true, html: ... }` (receipt loads → confirm parser labels match; update `LABELS`/fixtures if they differ) or `{ ok:false, reason:'RATE_LIMITED' }` (retry later). This is the step where the synthetic fixture is reconciled against reality — if labels differ, update Task 5's `LABELS` map + fixtures and re-run the parser test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/settings/index.ts
git commit -m "feat(deposit): settings defaults for auto-verify flag, cap, age, payer gate"
```

---

## Rollout checklist (post-implementation, operator actions — not code)

1. Deploy with `deposit_auto_verify_enabled = 'false'` (default). Verify the worker starts (BullMQ dashboard `/admin/queues` shows `deposit-verification`).
2. Enable `autoVerify` on the live Telebirr `PaymentMethod`(s); confirm `merchantName` + `merchantAccount` are the exact receiving account holder name + number.
3. **Shadow:** temporarily set `deposit_auto_verify_enabled = 'true'` with `deposit_auto_verify_max_amount = '0'` → every deposit gets a `DepositVerification` row and badge, but nothing auto-credits (cap 0 ⇒ always OVER_CAP ⇒ manual). Compare the engine's decisions against what clerks actually approve for a few days.
4. When decisions look right, raise `deposit_auto_verify_max_amount` to a low value; increase as confidence grows.
5. Watch reason-code distribution (a spike in `PARSE_FAILED` means the receipt format drifted → update parser).

---

## Self-Review

**Spec coverage:**
- Async worker + reuse of `approveDeposit` → Tasks 9, 10, 11. ✓
- No OCR, reconstruct from id → Tasks 5–8 (fetch official URL + parse). ✓
- Receiver = active `PaymentMethod` (name + masked number), `autoVerify` flag → Tasks 1, 6, 9, 13. ✓
- Credit Settled Amount, exact match, cap → Task 6. ✓
- Ships dark / flag / shadow / cap → Tasks 9, 14 + rollout. ✓
- `DepositVerification` table + `autoVerify` column + 4 settings → Tasks 1, 14. ✓
- Rate-limit handling (static limiter, dynamic 429 backoff, retry classification, concurrency 1) → Tasks 7, 9, 10. ✓
- Threat model (id credential, canonical fetch, id-mismatch guard, receiver gate, optional payer) → Tasks 6, 9. ✓
- Admin surfacing → Tasks 12, 13. ✓
- TDD tests (matching, parser, engine, classifier, verifier, orchestration) → Tasks 4–9. ✓
- English-labels-only parsing → Task 5. ✓

**Placeholder scan:** no TBD/"handle errors"/"similar to"; every code step shows full code. ✓

**Type consistency:** `ParsedReceipt`, `ExpectedDeposit`, `VerifyConfig`, `Decision`, `DepositVerifier`, `evaluate`, `runVerification`, `getVerifier`, `fetchReceiptHtml`, `classifyReceiptResponse`, `parseReceiptHtml`, `RateLimitSignal` are used identically across tasks. ✓

**Known reconciliation point:** the parser `LABELS` map + fixtures are synthetic until Task 14 Step 4 confirms them against a real receipt — called out explicitly rather than hidden.
