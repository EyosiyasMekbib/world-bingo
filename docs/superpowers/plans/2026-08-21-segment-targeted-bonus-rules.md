# Segment-Targeted Bonus Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deposit bonus rule target a frozen cohort of players resolved from a CRM segment, and show the admin the projected cost before the rule is switched on.

**Architecture:** `BonusRule` gains a `BonusRuleMember` join table materialized once at creation from the segment's compiled `PlayerMetrics` query. Grant-time evaluation gates on a non-nullable `isSegmentScoped` boolean plus one batched membership lookup per deposit. The admin form reuses the existing `POST /admin/crm/segments/count` endpoint for its projection.

**Tech Stack:** Fastify v5, Prisma 5 / PostgreSQL, Zod, Vitest, Nuxt 3 (`@nuxt/ui`).

**Spec:** [docs/superpowers/specs/2026-08-21-segment-targeted-bonus-rules-design.md](../specs/2026-08-21-segment-targeted-bonus-rules-design.md)

## Global Constraints

- **Grant-time gating reads `isSegmentScoped`, never `segmentId`.** `segmentId` is a nullable FK with `onDelete: SetNull`; gating on it would silently turn a targeted rule global the moment someone deletes the segment. This is the single most important invariant in this plan.
- Membership is **frozen**: materialized once at rule creation, never recomputed. `isSegmentScoped`, `segmentId`, and the member rows are **immutable after creation** — `BonusRuleService.update` must reject or ignore them.
- `memberCount` is `null` for unscoped rules (not `0` — zero would be indistinguishable from a scoped rule whose segment matched nobody).
- A segment resolving to **zero players is rejected at creation** with an explanatory error.
- Money math uses `Decimal` from `@prisma/client/runtime/library`.
- Test command: `pnpm --filter @world-bingo/api test` (Vitest, sequential, real Postgres via `DATABASE_URL_TEST`). New tables must be added to `cleanDb()` in `apps/api/src/test/setup.ts`.
- Real-DB suites touching `BonusService` call `expectInvariantClean()` in `afterEach` (from `./setup`) — keep this passing.
- Per project memory: `apps/admin` typecheck is red by default and `pnpm lint` does not check TypeScript. Verify by grepping the touched files for their own errors, not by trusting exit codes.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | `BonusRule` targeting columns + `BonusRuleMember` model |
| `apps/api/prisma/migrations/<ts>_add_bonus_rule_segment_targeting/migration.sql` | The migration |
| `apps/api/src/services/bonus-rule.service.ts` | Materialization at create; guard against mutating targeting on update |
| `apps/api/src/services/deposit-bonus.service.ts` | Membership gate in `evaluateAndGrant` |
| `apps/api/src/routes/admin/index.ts` | Accept `segmentId` on create |
| `apps/admin/composables/useAdminApi.ts` | Pass `segmentId`; expose segment list + count |
| `apps/admin/pages/bonus-rules/index.vue` | Segment picker + cost projection |
| `apps/api/src/test/bonus-rule-segment.test.ts` | New: materialization + immutability |
| `apps/api/src/test/deposit-bonus.service.test.ts` | Extend: membership gating |

---

## Task 1: Schema + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_bonus_rule_segment_targeting/migration.sql`
- Modify: `apps/api/src/test/setup.ts`

**Interfaces:**
- Produces: `BonusRule.isSegmentScoped`, `.segmentId`, `.segmentName`, `.memberCount`; `BonusRuleMember` model with composite PK `[ruleId, userId]`. Tasks 2, 3, 4 depend on these exact names.

- [ ] **Step 1: Add the columns and model to `schema.prisma`**

In `model BonusRule`, after `isActive`:

```prisma
  isSegmentScoped Boolean           @default(false)
  segmentId       String?
  segment         Segment?          @relation(fields: [segmentId], references: [id], onDelete: SetNull)
  segmentName     String?
  memberCount     Int?
  members         BonusRuleMember[]
```

Add the model after `model BonusGrant`:

```prisma
/// A bonus rule's frozen target cohort. Materialized once when the rule is
/// created and never recomputed — see the design spec §3. The composite
/// primary key is also the index the hot path uses: grant-time asks only
/// "is this user in this rule", which [ruleId, userId] answers directly.
model BonusRuleMember {
  ruleId String
  userId String
  rule   BonusRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  user   User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([ruleId, userId])
  @@map("bonus_rule_members")
}
```

Add the back-relations Prisma requires — in `model Segment`: `bonusRules BonusRule[]`; in `model User`: `bonusRuleMemberships BonusRuleMember[]`.

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @world-bingo/api exec prisma migrate dev --name add_bonus_rule_segment_targeting --create-only`

Rename the generated folder to a date-prefixed name matching this repo's convention (compare against `20260821000000_add_bonus_grants`). No hand-editing of the SQL is needed — there is no backfill: existing rules get `isSegmentScoped = false` from the column default, which is exactly the "applies to everyone" behavior they have today.

- [ ] **Step 3: Apply it**

Run: `pnpm --filter @world-bingo/api exec prisma migrate dev`
Expected: applies cleanly, Prisma Client regenerates.

Then apply to the test database the same way the earlier bonus migration did — read `apps/api/prisma/migrations/` history and `.superpowers/sdd/2026-08-20-deposit-bonuses/task-1-report.md` for the working commands and the known test-DB migration-history drift workaround.

- [ ] **Step 4: Add the new table to `cleanDb()`**

In `apps/api/src/test/setup.ts`, add immediately **before** the existing `await prisma.bonusGrant.deleteMany()`:

```typescript
    await prisma.bonusRuleMember.deleteMany()
```

It must precede `bonusRule.deleteMany()` (FK), and going before `bonusGrant` keeps it grouped with the other bonus tables.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @world-bingo/api typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/test/setup.ts
git commit -m "feat(bonus): add segment targeting columns and BonusRuleMember table"
```

---

## Task 2: Materialization in `BonusRuleService.create`

**Files:**
- Modify: `apps/api/src/services/bonus-rule.service.ts`
- Test: `apps/api/src/test/bonus-rule-segment.test.ts` (create)

**Interfaces:**
- Consumes: schema from Task 1; `compileSegment` from `../player-crm/segment-compiler`; `parseSegmentRuleSet` — check its exact export location by reading `apps/api/src/services/player-crm/segment.service.ts`'s imports before writing code.
- Produces: `CreateBonusRuleInput` gains `segmentId?: string | null`. `BonusRuleService.create` materializes members. Task 4 depends on the input field name.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/bonus-rule-segment.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { BonusRuleService } from '../services/bonus-rule.service'
import { SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'

const BASE = {
    name: 'Targeted daily',
    type: 'DAILY_DEPOSIT' as const,
    threshold: 500,
    rewardType: 'FIXED' as const,
    rewardValue: 50,
    validityHours: 24,
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: '2027-01-01T00:00:00Z',
}

async function makePlayer(username: string, phone: string, lifetimeDeposits: number) {
    const user = await prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: {} } },
    })
    await prisma.playerMetrics.create({
        data: { userId: user.id, lifetimeDeposits, registeredAt: new Date(), username, phone },
    })
    return user
}

async function makeSegment(name: string, minDeposits: number) {
    return prisma.segment.create({
        data: {
            name,
            rules: {
                version: SEGMENT_RULESET_VERSION,
                root: {
                    kind: 'group',
                    op: 'AND',
                    children: [{ kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: minDeposits }],
                },
            },
        },
    })
}

describe('BonusRuleService.create — segment targeting', () => {
    it('materializes exactly the matching players and records the count', async () => {
        const rich = await makePlayer('seg_rich', '+251900001001', 5000)
        const poor = await makePlayer('seg_poor', '+251900001002', 10)
        const segment = await makeSegment('Big depositors', 1000)

        const rule = await BonusRuleService.create({ ...BASE, segmentId: segment.id })

        expect(rule.isSegmentScoped).toBe(true)
        expect(rule.segmentId).toBe(segment.id)
        expect(rule.segmentName).toBe('Big depositors')
        expect(rule.memberCount).toBe(1)

        const members = await prisma.bonusRuleMember.findMany({ where: { ruleId: rule.id } })
        expect(members.map((m) => m.userId)).toEqual([rich.id])
        expect(members.map((m) => m.userId)).not.toContain(poor.id)
    })

    it('leaves an unscoped rule global, with memberCount null and no member rows', async () => {
        await makePlayer('seg_any', '+251900001003', 5000)

        const rule = await BonusRuleService.create(BASE)

        expect(rule.isSegmentScoped).toBe(false)
        expect(rule.segmentId).toBeNull()
        expect(rule.memberCount).toBeNull()
        expect(await prisma.bonusRuleMember.count({ where: { ruleId: rule.id } })).toBe(0)
    })

    it('rejects a segment that matches nobody, and creates no rule', async () => {
        await makePlayer('seg_small', '+251900001004', 10)
        const segment = await makeSegment('Impossible', 999_999)

        await expect(BonusRuleService.create({ ...BASE, segmentId: segment.id })).rejects.toThrow(
            /matches no players/i,
        )
        expect(await prisma.bonusRule.count()).toBe(0)
    })

    it('rejects a segmentId that does not exist', async () => {
        await expect(
            BonusRuleService.create({ ...BASE, segmentId: '00000000-0000-0000-0000-000000000000' }),
        ).rejects.toThrow(/segment not found/i)
    })
})
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @world-bingo/api test bonus-rule-segment`
Expected: FAIL — `segmentId` is not accepted, `isSegmentScoped` undefined.

- [ ] **Step 3: Implement**

In `bonus-rule.service.ts`, add `segmentId?: string | null` to `CreateBonusRuleInput`, and replace `create` with:

```typescript
    /**
     * Creates a rule and, when a segment is given, materializes its frozen
     * member cohort in the same transaction. Membership is resolved exactly
     * once here and never recomputed — see the design spec §3.
     */
    static async create(input: CreateBonusRuleInput): Promise<BonusRule> {
        const data = {
            name: input.name,
            type: input.type,
            threshold: input.threshold,
            rewardType: input.rewardType,
            rewardValue: input.rewardValue,
            maxReward: input.maxReward ?? null,
            validityHours: input.validityHours,
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
        }

        if (!input.segmentId) {
            return prisma.bonusRule.create({ data })
        }

        const segment = await prisma.segment.findUnique({ where: { id: input.segmentId } })
        if (!segment) throw new Error('Segment not found')

        const where = compileSegment(parseSegmentRuleSet(segment.rules))
        const matches = await prisma.playerMetrics.findMany({ where, select: { userId: true } })
        if (matches.length === 0) {
            throw new Error(`Segment "${segment.name}" matches no players — this rule could never pay anyone`)
        }

        return prisma.$transaction(async (tx) => {
            const rule = await tx.bonusRule.create({
                data: {
                    ...data,
                    isSegmentScoped: true,
                    segmentId: segment.id,
                    segmentName: segment.name,
                    memberCount: matches.length,
                },
            })

            // Batched: a large segment is tens of thousands of rows, and a single
            // createMany with that many values risks exceeding Postgres's bind
            // parameter limit.
            const CHUNK = 5_000
            for (let i = 0; i < matches.length; i += CHUNK) {
                await tx.bonusRuleMember.createMany({
                    data: matches.slice(i, i + CHUNK).map((m) => ({ ruleId: rule.id, userId: m.userId })),
                    skipDuplicates: true,
                })
            }

            return rule
        })
    }
```

Add the imports at the top — verify the exact module paths and export names by reading `apps/api/src/services/player-crm/segment.service.ts`'s own import block first:

```typescript
import { compileSegment } from './player-crm/segment-compiler'
```

`parseSegmentRuleSet` may come from `@world-bingo/shared-types` rather than the compiler module — check before writing it.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @world-bingo/api test bonus-rule-segment`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bonus-rule.service.ts apps/api/src/test/bonus-rule-segment.test.ts
git commit -m "feat(bonus): materialize a frozen member cohort when a rule targets a segment"
```

---

## Task 3: Targeting is immutable on update

**Files:**
- Modify: `apps/api/src/services/bonus-rule.service.ts`
- Test: `apps/api/src/test/bonus-rule-segment.test.ts`

**Interfaces:**
- Consumes: Task 2's `create`.

- [ ] **Step 1: Write the failing test**

Append to `bonus-rule-segment.test.ts`:

```typescript
describe('BonusRuleService.update — targeting is immutable', () => {
    it('updates editable fields without disturbing the frozen cohort', async () => {
        const user = await makePlayer('seg_upd', '+251900001005', 5000)
        const segment = await makeSegment('Editable', 1000)
        const rule = await BonusRuleService.create({ ...BASE, segmentId: segment.id })

        const updated = await BonusRuleService.update(rule.id, { threshold: 900, isActive: false })

        expect(Number(updated.threshold)).toBe(900)
        expect(updated.isActive).toBe(false)
        expect(updated.isSegmentScoped).toBe(true)
        expect(updated.segmentId).toBe(segment.id)
        expect(updated.memberCount).toBe(1)
        const members = await prisma.bonusRuleMember.findMany({ where: { ruleId: rule.id } })
        expect(members.map((m) => m.userId)).toEqual([user.id])
    })

    it('refuses to retarget a rule at a different segment', async () => {
        await makePlayer('seg_a', '+251900001006', 5000)
        const segment = await makeSegment('Original', 1000)
        const other = await makeSegment('Other', 1)
        const rule = await BonusRuleService.create({ ...BASE, segmentId: segment.id })

        await expect(
            BonusRuleService.update(rule.id, { segmentId: other.id } as never),
        ).rejects.toThrow(/cannot be changed/i)

        const unchanged = await prisma.bonusRule.findUniqueOrThrow({ where: { id: rule.id } })
        expect(unchanged.segmentId).toBe(segment.id)
    })
})
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @world-bingo/api test bonus-rule-segment -- -t "immutable"`
Expected: FAIL — the retarget attempt does not throw.

- [ ] **Step 3: Implement**

In `update`, add as the very first statement in the method body:

```typescript
        // Targeting is frozen at creation (design spec §3). A mutable audience is
        // just live membership with extra steps, and would silently strand players
        // who were mid-qualification when it changed.
        if ('segmentId' in input || 'isSegmentScoped' in input || 'memberCount' in input) {
            throw new Error("A rule's segment targeting cannot be changed after creation — create a new rule instead")
        }
```

Widen `update`'s parameter type so those keys are rejectable at runtime rather than merely absent from the type:

```typescript
    static async update(
        id: string,
        input: Partial<CreateBonusRuleInput> & { isActive?: boolean },
    ): Promise<BonusRule> {
```

`CreateBonusRuleInput` already carries `segmentId` after Task 2, so `'segmentId' in input` is reachable and type-legal.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @world-bingo/api test bonus-rule-segment`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bonus-rule.service.ts apps/api/src/test/bonus-rule-segment.test.ts
git commit -m "feat(bonus): reject attempts to retarget a bonus rule after creation"
```

---

## Task 4: Membership gate in `evaluateAndGrant`

**Files:**
- Modify: `apps/api/src/services/deposit-bonus.service.ts`
- Test: `apps/api/src/test/deposit-bonus.service.test.ts`

**Interfaces:**
- Consumes: Task 1's schema, Task 2's `create`.

- [ ] **Step 1: Write the failing tests**

Read `deposit-bonus.service.test.ts` first for its existing `makeUser`/`approvedDeposit` helpers and reuse them. Add:

```typescript
describe('DepositBonusService.evaluateAndGrant — segment targeting', () => {
    it('grants to a member of the targeted cohort', async () => {
        const user = await makeUser('segmember', '+251900002001')
        await prisma.playerMetrics.create({
            data: { userId: user.id, lifetimeDeposits: 5000, registeredAt: new Date() },
        })
        const segment = await prisma.segment.create({
            data: {
                name: 'Members',
                rules: {
                    version: SEGMENT_RULESET_VERSION,
                    root: { kind: 'group', op: 'AND', children: [{ kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: 1000 }] },
                },
            },
        })
        await BonusRuleService.create({
            name: 'Targeted', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24,
            startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
            segmentId: segment.id,
        })

        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(user.id, 600, day)
        const result = await prisma.$transaction((tx) =>
            DepositBonusService.evaluateAndGrant(tx, user.id, day, day),
        )

        expect(result.daily).toHaveLength(1)
        expect(result.daily[0].amount.toNumber()).toBe(50)
    })

    it('does not grant to a non-member, under identical deposit conditions', async () => {
        const member = await makeUser('segin', '+251900002002')
        const outsider = await makeUser('segout', '+251900002003')
        await prisma.playerMetrics.createMany({
            data: [
                { userId: member.id, lifetimeDeposits: 5000, registeredAt: new Date() },
                { userId: outsider.id, lifetimeDeposits: 5, registeredAt: new Date() },
            ],
        })
        const segment = await prisma.segment.create({
            data: {
                name: 'Members2',
                rules: {
                    version: SEGMENT_RULESET_VERSION,
                    root: { kind: 'group', op: 'AND', children: [{ kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: 1000 }] },
                },
            },
        })
        await BonusRuleService.create({
            name: 'Targeted2', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24,
            startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
            segmentId: segment.id,
        })

        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(outsider.id, 600, day)
        const result = await prisma.$transaction((tx) =>
            DepositBonusService.evaluateAndGrant(tx, outsider.id, day, day),
        )

        expect(result.daily).toHaveLength(0)
        expect(result.weekly).toHaveLength(0)
    })

    it('deleting the targeted segment does NOT turn the rule global', async () => {
        // The specific failure `isSegmentScoped` exists to prevent: segmentId is
        // nulled by the FK's SetNull, so gating on it would make this rule pay
        // everyone. Gating on isSegmentScoped must keep the outsider excluded.
        const outsider = await makeUser('segdel', '+251900002004')
        await prisma.playerMetrics.create({
            data: { userId: outsider.id, lifetimeDeposits: 5, registeredAt: new Date() },
        })
        const insider = await makeUser('segdel2', '+251900002005')
        await prisma.playerMetrics.create({
            data: { userId: insider.id, lifetimeDeposits: 5000, registeredAt: new Date() },
        })
        const segment = await prisma.segment.create({
            data: {
                name: 'ToDelete',
                rules: {
                    version: SEGMENT_RULESET_VERSION,
                    root: { kind: 'group', op: 'AND', children: [{ kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: 1000 }] },
                },
            },
        })
        const rule = await BonusRuleService.create({
            name: 'Targeted3', type: 'DAILY_DEPOSIT', threshold: 500, rewardType: 'FIXED',
            rewardValue: 50, validityHours: 24,
            startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z',
            segmentId: segment.id,
        })

        await prisma.segment.delete({ where: { id: segment.id } })
        const after = await prisma.bonusRule.findUniqueOrThrow({ where: { id: rule.id } })
        expect(after.segmentId).toBeNull()          // FK nulled it
        expect(after.isSegmentScoped).toBe(true)    // targeting survives
        expect(after.segmentName).toBe('ToDelete')  // provenance survives

        const day = new Date('2026-08-20T10:00:00Z')
        await approvedDeposit(outsider.id, 600, day)
        const result = await prisma.$transaction((tx) =>
            DepositBonusService.evaluateAndGrant(tx, outsider.id, day, day),
        )
        expect(result.daily).toHaveLength(0)
    })
})
```

Add whatever imports these need (`BonusRuleService`, `SEGMENT_RULESET_VERSION`) to the file's existing import block.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @world-bingo/api test deposit-bonus.service -- -t "segment targeting"`
Expected: FAIL — the non-member is granted, because no gate exists yet.

- [ ] **Step 3: Implement**

In `evaluateAndGrant`, immediately after the existing `const rules = await tx.bonusRule.findMany(...)` and before `const result = ...`:

```typescript
        // Membership is gated on isSegmentScoped, NOT on segmentId: segmentId is a
        // nullable FK that a segment deletion sets to null, which would silently
        // turn a targeted rule into one that pays every player. One batched query
        // covers every scoped rule rather than one lookup per rule.
        const scoped = rules.filter((r) => r.isSegmentScoped)
        const memberOf = scoped.length
            ? new Set(
                  (
                      await tx.bonusRuleMember.findMany({
                          where: { userId, ruleId: { in: scoped.map((r) => r.id) } },
                          select: { ruleId: true },
                      })
                  ).map((m) => m.ruleId),
              )
            : new Set<string>()
```

Then as the first statement inside the `for (const rule of rules)` loop:

```typescript
            if (rule.isSegmentScoped && !memberOf.has(rule.id)) continue
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @world-bingo/api test deposit-bonus.service`
Expected: PASS — the new tests plus every pre-existing test in the file (unscoped rules must still behave exactly as before).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deposit-bonus.service.ts apps/api/src/test/deposit-bonus.service.test.ts
git commit -m "feat(bonus): only grant a segment-scoped rule to its frozen cohort"
```

---

## Task 5: Admin API — accept `segmentId` on create

**Files:**
- Modify: `apps/api/src/routes/admin/index.ts`
- Test: `apps/api/src/test/admin-bonus-rules.test.ts`

**Interfaces:**
- Consumes: Task 2's `CreateBonusRuleInput.segmentId`.

- [ ] **Step 1: Write the failing test**

Read `admin-bonus-rules.test.ts` for its existing auth/`app.inject` fixture, then add a test that `POST /admin/bonus-rules` with a `segmentId` returns a rule with `isSegmentScoped: true` and a correct `memberCount`, and that omitting `segmentId` still returns `isSegmentScoped: false`. Follow that file's existing assertion style.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @world-bingo/api test admin-bonus-rules`
Expected: FAIL — `segmentId` is stripped by the Zod schema, so `isSegmentScoped` is false.

- [ ] **Step 3: Implement**

Add to `bonusRuleFields`:

```typescript
    segmentId: z.string().uuid().nullable().optional(),
```

Because `bonusRuleUpdateSchema` is `bonusRuleFields.partial()`, `segmentId` becomes accepted on PATCH too — Task 3's service-level guard is what rejects it, and it will surface as a 500. Make it a clean 400 by stripping it in the PATCH handler before calling the service:

```typescript
        f.patch('/bonus-rules/:id', async (req: any, reply) => {
            const parsed = bonusRuleUpdateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            if (parsed.data.segmentId !== undefined) {
                return reply.status(400).send({
                    error: "A rule's segment targeting cannot be changed after creation — create a new rule instead",
                })
            }
            // ...existing destructure and update call unchanged...
        })
```

Pass `segmentId` through in the POST handler's destructure and its `BonusRuleService.create({ ... })` call.

Map creation failures to 400 rather than 500, since "segment matches nobody" and "segment not found" are both user errors:

```typescript
        f.post('/bonus-rules', async (req: any, reply) => {
            const parsed = bonusRuleCreateSchema.safeParse(req.body)
            if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
            try {
                return await BonusRuleService.create({ ...parsed.data, type: parsed.data.type as any, rewardType: parsed.data.rewardType as any })
            } catch (err: any) {
                if (/segment/i.test(err?.message ?? '')) return reply.status(400).send({ error: err.message })
                throw err
            }
        })
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @world-bingo/api test admin-bonus-rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/index.ts apps/api/src/test/admin-bonus-rules.test.ts
git commit -m "feat(bonus): accept segmentId when creating a bonus rule"
```

---

## Task 6: Admin UI — segment picker and cost projection

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts`
- Modify: `apps/admin/pages/bonus-rules/index.vue`

**Interfaces:**
- Consumes: Task 5's `segmentId` on `POST /admin/bonus-rules`; the existing `getSegments()` and `countSegmentRules(rules)` methods already in `useAdminApi.ts`.

No live browser verification is available in this environment (no dev server). Verify statically and say so in the report — this matches how the existing bonus-rules page was built.

- [ ] **Step 1: Extend the composable**

Add `segmentId?: string | null` to `createBonusRule`'s body type. `getSegments()` and `countSegmentRules()` already exist — reuse them, do not add duplicates.

- [ ] **Step 2: Add segment state to the page**

In `bonus-rules/index.vue`'s `<script setup>`:

```typescript
const segments = ref<any[]>([])
const projecting = ref(false)
const projectedCount = ref<number | null>(null)

const segmentOptions = computed(() => [
  { label: 'All players (no targeting)', value: '' },
  ...segments.value.map((s: any) => ({ label: s.name, value: s.id })),
])

const maxPerPlayer = computed<number | null>(() =>
  form.rewardType === 'FIXED' ? form.rewardValue : (form.maxReward ?? null)
)

const maxExposure = computed<number | null>(() =>
  projectedCount.value !== null && maxPerPlayer.value !== null
    ? projectedCount.value * maxPerPlayer.value
    : null
)

async function refreshProjection() {
  if (!form.segmentId) { projectedCount.value = null; return }
  const seg = segments.value.find((s: any) => s.id === form.segmentId)
  if (!seg) { projectedCount.value = null; return }
  projecting.value = true
  try {
    const res = await countSegmentRules(seg.rules)
    projectedCount.value = res.count
  } catch {
    projectedCount.value = null
  } finally {
    projecting.value = false
  }
}

watch(() => form.segmentId, refreshProjection)
```

Add `segmentId: ''` to the `form` reactive object, and load `segments.value = await getSegments()` in the existing `onMounted`.

- [ ] **Step 3: Add the form field and projection panel**

Inside the create modal, after the Type field:

```html
<UFormField label="Target Segment">
  <USelect v-model="form.segmentId" :options="segmentOptions" value-key="value" label-key="label" class="w-full" />
</UFormField>

<div v-if="form.segmentId" class="rounded-xl border border-(--surface-border) p-3 text-sm space-y-1">
  <div v-if="projecting" class="text-white/40">Calculating…</div>
  <template v-else-if="projectedCount !== null">
    <div class="flex justify-between"><span class="text-white/50">Matching players</span><span class="text-white font-medium">{{ projectedCount.toLocaleString() }}</span></div>
    <div class="flex justify-between">
      <span class="text-white/50">Max reward per player</span>
      <span class="text-white font-medium">{{ maxPerPlayer !== null ? `${maxPerPlayer} ETB` : 'uncapped' }}</span>
    </div>
    <div class="flex justify-between">
      <span class="text-white/50">Max exposure per period</span>
      <span class="text-white font-medium">{{ maxExposure !== null ? `${maxExposure.toLocaleString()} ETB` : 'uncapped' }}</span>
    </div>
    <p v-if="projectedCount === 0" class="text-red-400 pt-1">This segment matches no players — the rule could never pay anyone.</p>
    <p v-else class="text-white/30 pt-1 text-xs">Worst case: assumes every matched player crosses the threshold in the same period.</p>
  </template>
</div>
```

The "uncapped" branch is required by the spec: a `PERCENTAGE` reward with no `maxReward` has no worst case, and showing a number there would understate the exposure the projection exists to reveal.

- [ ] **Step 4: Send it and reset it**

In `create()`, pass `segmentId: form.segmentId || null` in the request body, and add `form.segmentId = ''` plus `projectedCount.value = null` to the post-success reset block.

- [ ] **Step 5: Show targeting on the rule cards**

In the rule list, next to the existing Daily/Weekly badge:

```html
<UBadge v-if="rule.isSegmentScoped" color="info" variant="soft" :label="`${rule.segmentName ?? 'Segment'} · ${rule.memberCount ?? 0}`" />
```

- [ ] **Step 6: Verify statically**

Run: `pnpm --filter @world-bingo/admin exec vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -i "bonus-rules\|useAdminApi"`
Expected: no NEW errors beyond the two pre-existing `USelect` ones this page already inherits from `cashback/index.vue` (compare the count before and after your change rather than expecting empty output).

- [ ] **Step 7: Commit**

```bash
git add apps/admin/composables/useAdminApi.ts apps/admin/pages/bonus-rules/index.vue
git commit -m "feat(bonus): admin can target a bonus rule at a segment and see projected cost"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 Data model, `isSegmentScoped` rationale | Task 1 |
| §3 Frozen membership; immutable targeting | Tasks 2, 3 |
| §4 Materialization, zero-segment rejection, batching | Task 2 |
| §5 Grant-time evaluation | Task 4 |
| §6 Cost projection, uncapped handling | Task 6 |
| §7 Testing — materialization | Task 2 |
| §7 Testing — grant-time, incl. segment-deletion case | Task 4 |
| §7 Testing — projection math | Task 6 (computed properties; no automated test, consistent with this page having none) |
| §8 Out of scope | No task implements player-facing eligibility, spend caps, live membership, audience editing, or worker-based materialization — confirmed absent by omission |

**Placeholder scan:** no "TBD"/"TODO"/"add error handling". Two tasks direct the implementer to *read a file first* (Task 2's `parseSegmentRuleSet` import path, Task 5's test fixture style) — these are scoped investigation steps with a named target, not unresolved requirements.

**Type consistency:** `isSegmentScoped`, `segmentId`, `segmentName`, `memberCount`, `BonusRuleMember{ruleId,userId}` are defined in Task 1 and used verbatim in Tasks 2-6. `CreateBonusRuleInput.segmentId` is introduced in Task 2 and consumed by Task 5. `memberOf`/`scoped` are local to Task 4.
