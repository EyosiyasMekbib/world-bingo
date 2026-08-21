# Segment-targeted bonus rules — design

**Status:** Designed, not implemented.
**Date:** 2026-08-21
**Builds on:** [2026-08-20-deposit-bonus-design.md](2026-08-20-deposit-bonus-design.md)

Deposit bonus rules currently apply to every player. This adds optional targeting: a rule can
be scoped to a CRM segment, and the admin sees the projected cost before switching it on.

---

## 1. What this is not

Three adjacent features were considered and deliberately excluded:

- **Player-facing eligibility.** `GET /promotions` still returns active rules globally, with no
  per-player "you qualify for this" signal. A targeted rule is invisible to non-members until
  they deposit and simply don't receive it.
- **An enforced spend cap.** The projection is advisory. There is no `maxTotalPayout` that halts
  granting once a rule has paid out N birr, the way `Campaign.maxTotalBonus` does.
- **Live membership.** Covered in §3 — membership is frozen, not re-evaluated.

Each is a reasonable follow-up. None is in scope.

---

## 2. Data model

```prisma
model BonusRule {
  // ...existing fields unchanged...
  isSegmentScoped Boolean           @default(false)
  segmentId       String?
  segment         Segment?          @relation(fields: [segmentId], references: [id], onDelete: SetNull)
  segmentName     String?
  memberCount     Int?
  members         BonusRuleMember[]
}

model BonusRuleMember {
  ruleId String
  userId String
  rule   BonusRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)
  user   User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([ruleId, userId])
  @@map("bonus_rule_members")
}
```

`Segment` gains the matching back-relation (`bonusRules BonusRule[]`), and `User` gains
`bonusRuleMemberships BonusRuleMember[]`, as Prisma requires for both relations.

`@@id([ruleId, userId])` is both the uniqueness guarantee and the index the hot path uses — the
grant-time question is always "is this user in this rule", which that composite key answers with a
single lookup. No separate surrogate id.

`memberCount` is null for unscoped rules, where it has no meaning — it is not zero, which would be
indistinguishable from a scoped rule whose segment matched nobody.

### Why `isSegmentScoped` exists alongside `segmentId`

Gating on `segmentId != null` would be the obvious design and it is wrong. `segmentId` is a nullable
FK; deleting a segment nulls it; a rule that was targeted at 40 whales would silently become a rule
that pays **every player on the platform**. That is the same class of failure the `Campaign` model
already guards against — its schema comment notes that compiling from the live `Segment` row would
let "editing the segment after approval silently retarget a running campaign."

So targeting is gated on a non-nullable boolean that no cascade can flip. `segmentId` and
`segmentName` are provenance only: which segment this cohort came from, for display and audit.
`segmentName` is denormalized for the same reason `Campaign` denormalizes `createdByUsername` —
the admin screen should still read "Whale" after someone deletes the segment, not an unresolvable
UUID.

---

## 3. Membership is frozen

The member list is materialized once, at rule creation, and never changes.

The alternative — re-checking membership on each deposit — was considered and rejected. It reads
better in the abstract ("a bonus for whales should follow whoever is currently a whale"), but it
makes the rule's audience unknowable: an operator switching on a 50-birr daily bonus cannot say who
it will pay or what it will cost, because both drift with the metrics rollup.

The cost of freezing is real and permanent, and is stated here rather than discovered later:

- A player who churns the day after the rule is created keeps qualifying for its entire life.
- A player who becomes a whale the following week never qualifies, no matter how long the rule runs.
- A rule targeting "New players" pays a cohort that is, by the end of the rule's window, no longer new.

Operators change a rule's audience by creating a new rule. Which leads to:

### Targeting is immutable after creation

`isSegmentScoped`, `segmentId`, and the member rows cannot be edited. Threshold, reward, validity and
dates all remain editable. This keeps the frozen-cohort guarantee honest — a mutable audience is just
live membership with extra steps — and removes any re-materialization path, along with the question
of what happens to players who were mid-qualification when the audience changed.

---

## 4. Materialization

At creation, when a segment is chosen: compile it through the existing `compileSegment`, query
`PlayerMetrics`, and write the member rows via batched `createMany`, inside the same transaction that
creates the rule. `memberCount` is set from the actual number of rows inserted, so every later display
is exact rather than a re-estimate that could drift from what the rule will really pay.

Players with no `PlayerMetrics` row — a brand-new account that has not yet been picked up by the
rollup worker — do not match any segment and are not members. This is consistent with how segments
already behave everywhere else in the CRM.

A segment resolving to zero players is rejected at creation with an explanatory error rather than
silently producing a rule that can never pay anyone.

**Scale caveat.** Materialization is synchronous. At thousands to tens of thousands of players the
batched insert is a few hundred milliseconds to a few seconds, which is acceptable for a deliberate
admin action. At hundreds of thousands it becomes a slow request and should move to a worker with a
`MATERIALIZING` rule state, mirroring how `crm-campaign.worker` handles campaign drains. That
threshold is not reached today; the constraint is recorded so the decision is revisited rather than
rediscovered.

---

## 5. Grant-time evaluation

`DepositBonusService.evaluateAndGrant` gains one query, not one per rule:

```typescript
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

// inside the existing per-rule loop, before the threshold check:
if (rule.isSegmentScoped && !memberOf.has(rule.id)) continue
```

Rules with `isSegmentScoped: false` take exactly the path they take today. The feature is additive:
every existing rule keeps working untouched, and the migration needs no backfill beyond the column
defaults.

---

## 6. Cost projection

On the admin bonus-rule form, once a segment is selected:

```
Segment: Whale (avgDailyDeposit >= 1000)
Matching players:      1,240
Max reward per player:    50 ETB
Max exposure per day:  62,000 ETB
```

The count comes from the existing `POST /admin/crm/segments/count`, which already compiles a rule set
and counts matches — no new counting logic. The reward arithmetic is:

| Reward type | Max per player |
|---|---|
| `FIXED` | `rewardValue` |
| `PERCENTAGE` with `maxReward` | `maxReward` |
| `PERCENTAGE` without `maxReward` | unbounded |

The third row is shown as **"uncapped"**, not as a number. A percentage reward with no ceiling has no
worst case to display, and inventing one would understate the exposure the projection exists to reveal.

The projection is explicitly a worst case: it assumes every matched player crosses the threshold in
the same period. The UI says so, because a number this large is misleading without it.

After creation the projection is replaced by the exact materialized `memberCount`.

---

## 7. Testing

**Materialization**
- The member rows written are exactly the users the segment matches — verified against a
  `compileSegment` query, not against the count alone.
- A zero-player segment is rejected at creation.
- `memberCount` equals the number of rows actually inserted.

**Grant-time**
- A member of a scoped rule receives the bonus.
- A non-member does not, under otherwise identical deposit conditions.
- An unscoped rule (`isSegmentScoped: false`) still pays a player who is in no segment at all —
  the backward-compatibility case.
- **Deleting the targeted segment does not turn the rule global.** This is the specific failure
  `isSegmentScoped` exists to prevent, so it gets a test that deletes the segment row and asserts a
  non-member still receives nothing.

**Projection**
- `FIXED`, capped `PERCENTAGE`, and uncapped `PERCENTAGE` each produce the right per-player figure,
  with the uncapped case reporting unbounded rather than a number.

---

## 8. Out of scope

Named so "we forgot" and "we decided against" stay distinguishable:

- Player-facing eligibility display (§1).
- An enforced per-rule spend cap (§1).
- Live/re-evaluated membership (§3).
- Editing a rule's audience after creation (§3).
- Worker-based materialization for very large segments (§4).
