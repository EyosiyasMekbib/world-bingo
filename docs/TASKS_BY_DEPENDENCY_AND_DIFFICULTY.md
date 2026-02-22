# World Bingo — Tasks Ordered by Dependency & Ranked by Difficulty

> **Generated:** 2026-02-21  
> **Last Updated:** 2026-02-22 (Tier 6 complete — T50, T51, T51b, T51c, T52, T53, T54)  
> **Source:** [ATOMIC_TASK_BREAKDOWN.md](./ATOMIC_TASK_BREAKDOWN.md)
>
> Every task is placed in a **dependency tier**. Tasks within a tier can be done in parallel.
> A task in Tier N can only begin after **all** of its listed dependencies in earlier tiers are complete.

---

## 📊 Progress Summary

| Tier | Tasks | Done | Remaining |
|------|-------|------|-----------|
| **Tier 0** — Foundation | 6 | ✅ 6 | 0 |
| **Tier 1** — Core Fixes | 7 | ✅ 7 | 0 |
| **Tier 2** — Service Layer | 10 | ✅ 10 | 0 |
| **Tier 3** — Game Engine | 12 | ✅ 11 | 1 (T35 — infra) |
| **Tier 4** — Player UI & Admin | 9 | ✅ 9 | 0 |
| **Tier 5** — Live Game & Workers | 5 | ✅ 5 | 0 |
| **Tier 6** — Manual Payment & Testing | 7 | ✅ 7 | 0 |
| **Tier 7** — QA & Growth | 5 | 0 | 5 |
| **Tier 8** — Advanced Features | 1 | 0 | 1 |
| **Total** | **62** | **55 (89%)** | **7 (11%)** |

**Next up: Tier 7** — Admin E2E tests (T55), Load testing (T56), Referral program (T57), i18n Amharic (T58), Progressive jackpot (T59)

---

## Legend

| Symbol | Meaning |
|--------|---------|
| 🟢 | **Easy** — Straightforward, low risk, mostly wiring existing patterns |
| 🟡 | **Medium** — Requires design decisions, new modules, or multi-file changes |
| 🔴 | **Hard** — Complex concurrency, distributed systems, or cross-cutting concerns |
| ⚫ | **Very Hard** — Significant architecture, new domain, or 3rd-party integration |
| ⏱️ `Xh` | Estimated effort |
| `→ [X.X]` | Depends on task X.X |

---

## Tier 0 — Foundation (No Dependencies) ✅ COMPLETE

> All 6 tasks completed on **2026-02-22**.

| # | Task | Difficulty | ⏱️ | Package | Status |
|---|------|------------|-----|---------|--------|
| **T1** | 0.2 — Auth: Login by username OR phone | 🟢 Easy | 1h | `api`, `shared-types` | ✅ Done |
| **T2** | 0.1 — Wallet: `SELECT FOR UPDATE` row-locking | 🟡 Medium | 2h | `api` | ✅ Done |
| **T3** | 2.4 — Database index optimization | 🟢 Easy | 1h | `api/prisma` | ✅ Done |
| **T4** | 2.5 — Rate limiting & security hardening | 🟡 Medium | 2h | `api` | ✅ Done |
| **T5** | 6.3 — Environment config (`.env.example`) | 🟢 Easy | 1h | root | ✅ Done |
| **T6** | 6.2 — Dockerfiles for api/web/admin | 🟡 Medium | 3h | root | ✅ Done |

---

## Tier 1 — Core Fixes (Depends on Tier 0) ✅ COMPLETE

> All 7 tasks completed on **2026-02-22**. Tests: 26/26 ✅, TypeScript: zero errors ✅.

| # | Task | Difficulty | ⏱️ | Package | Status |
|---|------|------------|-----|---------|--------|
| **T7** | 0.3 — Auth: Refresh token flow | 🟡 Medium | 3h | `api`, `shared-types`, `web` | ✅ Done |
| **T8** | 0.4 — Fix GameEntry schema for multi-cartela | 🟡 Medium | 2h | `api/prisma`, `shared-types` | ✅ Done |
| **T9** | 1.1.1 — File upload: Backend storage module | 🟡 Medium | 2h | `api` | ✅ Done |
| **T10** | 1.4.1 — Notification: DB model + migration | 🟢 Easy | 1h | `api/prisma` | ✅ Done |
| **T11** | 1.4.3 — Notification types enum | 🟢 Easy | 0.5h | `shared-types` | ✅ Done |
| **T12** | 1.6.1 — Admin auth: Role check + persistence | 🟢 Easy | 1h | `admin` | ✅ Done |
| **T13** | 1.6.8 — Admin profile: Change password API | 🟢 Easy | 1h | `api`, `admin` | ✅ Done |

---

## Tier 2 — Service Layer (Depends on Tier 1) ✅ COMPLETE

> New services and core business logic that build on the schema and auth fixes.
> All 10 tasks completed on **2026-02-22**. Tests: 73/73 ✅, TypeScript: zero errors ✅.

| # | Task | Difficulty | ⏱️ | Package | Status / Dependencies |
|---|------|------------|-----|---------|----------------------|
| **T14** | 0.5 — Move game state to Redis | 🔴 Hard | 4h | `api` | ✅ Done |
| **T15** | 1.2 — Withdrawal route: Complete flow | 🟡 Medium | 2h | `api` | ✅ Done |
| **T16** | 1.1.2 — Deposit route: Handle file upload | 🟡 Medium | 1.5h | `api` | ✅ Done |
| **T17** | 1.4.2 — Notification service | 🟡 Medium | 2h | `api` | ✅ Done |
| **T18** | 1.4.4 — Socket events for notifications | 🟢 Easy | 0.5h | `shared-types` | ✅ Done |
| **T19** | 1.3.1 — Refund service | 🔴 Hard | 2h | `api` | ✅ Done |
| **T20** | 1.4.6 — Notification API routes | 🟢 Easy | 1h | `api` | ✅ Done |
| **T21** | 1.6.2 — Admin dashboard: Wire to live API | 🟢 Easy | 1h | `admin` | ✅ Done |
| **T22** | 3.3 — Payment gateway abstraction interface | 🟡 Medium | 2h | `api` | ✅ Done |
| **T23** | 6.1 — CI/CD pipeline (GitHub Actions) | 🟡 Medium | 4h | root | ✅ Done |

---

## Tier 3 — Game Engine & Integration (Depends on Tier 2) ✅ COMPLETE (except T35)

> All 11 code tasks completed on **2026-02-22**. T35 (production DB provisioning) is infrastructure/manual.
> New tests: 91/91 ✅ (+18 for T24/T25/T26), TypeScript: zero errors ✅.

| # | Task | Difficulty | ⏱️ | Package | Status |
|---|------|------------|-----|---------|--------|
| **T24** | 0.6 — Robust game engine (Redlock + recovery) | 🔴 Hard | 3h | `api` | ✅ Done |
| **T25** | 1.3.2 — Game cancellation trigger | 🟡 Medium | 1.5h | `api` | ✅ Done |
| **T26** | 1.3.3 — Auto-cancel on insufficient players | 🟡 Medium | 1.5h | `api` | ✅ Done |
| **T27** | 1.4.5 — Integrate notifications into all flows | 🟡 Medium | 2h | `api` | ✅ Done |
| **T28** | 1.5.1 — Pinia game store | 🟡 Medium | 3h | `web` | ✅ Done |
| **T29** | 1.1.3 — Frontend: Deposit form with file picker | 🟡 Medium | 2h | `web` | ✅ Done |
| **T30** | 1.1.4 — Admin: View receipt images | 🟢 Easy | 1h | `admin` | ✅ Done |
| **T31** | 1.6.3 — Admin: Pending deposits page wiring | 🟡 Medium | 2h | `admin` | ✅ Done |
| **T32** | 1.6.4 — Admin: Withdrawals management wiring | 🟡 Medium | 2h | `admin` | ✅ Done |
| **T33** | 1.6.5 — Admin: Orders/history wiring | 🟢 Easy | 1h | `admin` | ✅ Done |
| **T34** | 2.2 — WebSocket Redis adapter | 🔴 Hard | 3h | `api` | ✅ Done |
| **T35** | 6.4 — Production database provisioning | 🟡 Medium | 2h | infra | ⏸️ Skipped (manual infra) |

---

## Tier 4 — Player-Facing UI & Admin Tools (Depends on Tier 3) ✅ COMPLETE

> All 9 tasks completed on **2026-02-22**.

| # | Task | Difficulty | ⏱️ | Package | Status |
|---|------|------------|-----|---------|--------|
| **T36** | 1.5.2 — Lobby page: Real-time game list | 🟡 Medium | 2h | `web` | ✅ Done |
| **T37** | 1.5.3 — Cartela selection page | 🟡 Medium | 3h | `web` | ✅ Done |
| **T38** | 1.5.5 — Wallet UI (deposit + withdraw modals) | 🟡 Medium | 3h | `web` | ✅ Done |
| **T39** | 1.4.7 — Frontend: Notification bell component | 🟡 Medium | 2h | `web` | ✅ Done |
| **T40** | 1.5.6 — Navigation & layout polish | 🟢 Easy | 2h | `web` | ✅ Done |
| **T41** | 1.3.4 — Admin: Cancel game button | 🟢 Easy | 1h | `admin` | ✅ Done |
| **T42** | 1.6.6 — Admin: Game management page | 🟡 Medium | 3h | `admin` | ✅ Done |
| **T43** | 1.6.7 — Admin: User management page | 🟡 Medium | 3h | `admin`, `api` | ✅ Done |
| **T44** | 2.1.1 — BullMQ: Queue infrastructure setup | 🟡 Medium | 1.5h | `api` | ✅ Done |

---

## Tier 5 — Live Game & Background Workers (Depends on Tier 4) ✅ COMPLETE

> All 5 tasks completed on **2026-02-22**. Tests: 142/142 ✅.

| # | Task | Difficulty | ⏱️ | Package | Status |
|---|------|------------|-----|---------|--------|
| **T45** | 1.5.4 — Live game play page | 🔴 Hard | 5h | `web` | ✅ Done |
| **T46** | 2.1.2 — BullMQ: Refund worker | 🟡 Medium | 1.5h | `api` | ✅ Done |
| **T47** | 2.1.3 — BullMQ: Notification worker | 🟡 Medium | 1.5h | `api` | ✅ Done |
| **T48** | 2.1.4 — BullMQ: Game engine worker | 🔴 Hard | 2h | `api` | ✅ Done |
| **T49** | 2.1.5 — BullMQ: Dashboard (`/admin/queues`) | 🟢 Easy | 1h | `api` | ✅ Done |

---

## Tier 6 — Manual Payment Hardening & Testing (Depends on Tier 5)

> Manual deposit/withdrawal flow enhancement and test coverage. No Chapa or Telebirr API integration.

| # | Task | Difficulty | ⏱️ | Package | Dependencies |
|---|------|------------|-----|---------|--------------|
| **T50** | 3.1 — Deposit form: Add TeleBirr transaction fields (Transaction ID, Name, Account Number) | 🟡 Medium | 3h | `api`, `web`, `shared-types` | → T22 (gateway abstraction), → T29 (deposit UI) |
| **T51** | 3.2 — Admin deposit verification: Cross-check receipt vs form data | 🟡 Medium | 2h | `admin`, `api` | → T30 (receipt viewer), → T31 (deposits page) |
| **T51b** | 3.3 — Admin withdrawal fulfillment enhancement | 🟢 Easy | 1h | `admin` | → T32 (withdrawals page) |
| **T51c** | 3.4 — Stale request & edge case handling (15-min deadline, decline reasons) | 🟡 Medium | 2h | `api`, `web`, `admin` | → T50, → T51 |
| **T52** | 2.3 — Prometheus + Grafana monitoring | 🟡 Medium | 4h | `api`, `infra` | → T6 (Docker), → T44 (queues to monitor) |
| **T53** | 5.1 — API integration tests | 🔴 Hard | 6h | `api` | → T24, → T19, → T17, → T15 (all services must be complete) |
| **T54** | 5.2 — Web app E2E tests (Playwright) | 🔴 Hard | 6h | `web` | → T45 (live game page), → T38 (wallet UI) |

---

## Tier 7 — QA & Growth (Depends on Tier 6)

> Polish, testing, and growth features. System is feature-complete before this tier.

| # | Task | Difficulty | ⏱️ | Package | Dependencies |
|---|------|------------|-----|---------|--------------|
| **T55** | 5.3 — Admin app E2E tests | 🟡 Medium | 3h | `admin` | → T42, → T43 (all admin pages done) |
| **T56** | 5.4 — Load testing (k6/Artillery) | 🟡 Medium | 3h | `infra` | → T34 (WS Redis adapter), → T48 (game engine worker) |
| **T57** | 4.1 — Referral program | 🟡 Medium | 4h | `api`, `web`, `shared-types` | → T7 (auth), → T2 (wallet locking) |
| **T58** | 4.2 — i18n Amharic support | 🟡 Medium | 6h | `web`, `admin`, `ui` | → T40 (navigation finalized), → T45 (all pages exist) |
| **T59** | 4.4 — Progressive jackpot | 🔴 Hard | 4h | `api`, `web` | → T24 (game engine), → T2 (wallet locking) |

---

## Tier 8 — Advanced Features (Depends on Tier 7)

> Complex new game modes. Only after core is battle-tested.

| # | Task | Difficulty | ⏱️ | Package | Dependencies |
|---|------|------------|-----|---------|--------------|
| **T60** | 4.3 — Tournament mode | ⚫ Very Hard | 8h | `api`, `web`, `shared-types` | → T24 (game engine), → T48 (game worker), → T45 (play page), → T59 (jackpot optional) |

---

## Dependency Graph (Visual)

```
TIER 0 ✅ (no deps)
├── T1  Auth: login fix ─────────────────────────────────────────────────┐
├── T2  Wallet: row-locking ─────────────────────────────────────────────┤
├── T3  DB indexes ──────────────────────────────────────────────────────┤
├── T4  Rate limiting ───────────────────────────────────────────────────┤
├── T5  Env config ──────────────────────────────────────────────────────┤
└── T6  Dockerfiles ─────────────────────────────────────────────────────┤
                                                                         │
TIER 1 ✅ (foundation fixes)                                             │
├── T7  Refresh tokens ──────── T1 ──────────────────────────────────────┤
├── T8  Multi-cartela schema ── T2 ──────────────────────────────────────┤
├── T9  Storage module ──────── T2 ──────────────────────────────────────┤
├── T10 Notification model ──── T3 ──────────────────────────────────────┤
├── T11 Notification enums ──── T10 ─────────────────────────────────────┤
├── T12 Admin auth ──────────── T1 ──────────────────────────────────────┤
└── T13 Change password ─────── T7 ──────────────────────────────────────┤
                                                                         │
TIER 2 (services) — ALL ✅ COMPLETE                                      │
├── T14 Redis game state ────── T8 ✅──────────────────────────────────────┤
├── T15 Withdrawal route ────── T2, T7 ✅─────────────────────────────────┤
├── T16 Deposit file upload ─── T9 ✅────────────────────────────────────┤
├── T17 Notification service ── T10, T11 ✅──────────────────────────────┤
├── T18 Socket events ──────── T11 ✅────────────────────────────────────┤
├── T19 Refund service ──────── T2, T8 ✅────────────────────────────────┤
├── T20 Notification routes ─── T17 ✅──────────────────────────────────┤
├── T21 Admin dash wiring ───── T12 ✅──────────────────────────────────┤
├── T22 Payment abstraction ─── T9 ✅────────────────────────────────────┤
└── T23 CI/CD ───────────────── T6 ✅────────────────────────────────────┤
                                                                         │
TIER 3 (game engine + integration) — ALL ✅ COMPLETE (T35 skipped)       │
├── T24 Game engine (Redlock) ─ T14 ✅──────────────────────────────────┤
├── T25 Game cancel trigger ─── T19 ✅──────────────────────────────────┤
├── T26 Auto-cancel ─────────── T24, T25 ✅──────────────────────────────┤
├── T27 Notifications in flows─ T17, T19 ✅──────────────────────────────┤
├── T28 Pinia game store ────── T7, T8 ✅────────────────────────────────┤
├── T29 Deposit form (web) ──── T16 ✅──────────────────────────────────┤
├── T30 Admin receipt viewer ── T16 ✅──────────────────────────────────┤
├── T31 Admin deposits page ─── T30, T21 ✅──────────────────────────────┤
├── T32 Admin withdrawals ───── T15, T21 ✅──────────────────────────────┤
├── T33 Admin orders ────────── T21 ✅──────────────────────────────────┤
├── T34 WS Redis adapter ───── T14 ✅────────────────────────────────────┤
└── T35 Prod database ──────── T3, T6 — ⏸️ skipped (manual infra) ───────┤
                                                                         │
TIER 4 (player UI + admin tools) — ALL ✅ COMPLETE                       │
├── T36 Lobby page ──────────── T28 ✅──────────────────────────────────┤
├── T37 Cartela selection ───── T28, T8 ✅───────────────────────────────┤
├── T38 Wallet UI (web) ─────── T29, T15 ✅─────────────────────────────┤
├── T39 Notification bell ───── T20, T18 ✅─────────────────────────────┤
├── T40 Nav & layout polish ─── T39, T38 ✅─────────────────────────────┤
├── T41 Admin cancel game btn ─ T25, T42 ✅─────────────────────────────┤
├── T42 Admin game mgmt page ── T24, T21 ✅─────────────────────────────┤
├── T43 Admin user mgmt page ── T21, T7 ✅──────────────────────────────┤
└── T44 BullMQ queue setup ──── T14 ✅──────────────────────────────────┤
                                                                         │
TIER 5 (live game + workers) — ALL ✅ COMPLETE                           │
├── T45 Live game play page ─── T36, T37, T24, T28 ✅───────────────────┤
├── T46 Refund worker ──────── T44, T19 ✅──────────────────────────────┤
├── T47 Notification worker ── T44, T17 ✅──────────────────────────────┤
├── T48 Game engine worker ─── T44, T24 ✅──────────────────────────────┤
└── T49 BullMQ dashboard ───── T44 ✅───────────────────────────────────┤
                                                                         │
TIER 6 (manual payment hardening + testing)                             │
├── T50 Deposit form fields ──── T22, T29 ────────────────────────────────┤
├── T51 Admin deposit verify ── T30, T31 ─────────────────────────────────┤
├── T51b Admin withdrawal ───── T32 ──────────────────────────────────────┤
├── T51c Stale/edge cases ───── T50, T51 ─────────────────────────────────┤
├── T52 Prometheus/Grafana ─── T6, T44 ──────────────────────────────────┤
├── T53 API integration tests─ T24, T19, T17, T15 ───────────────────────┤
└── T54 Web E2E tests ──────── T45, T38 ─────────────────────────────────┤
                                                                         │
TIER 7 (QA + growth)                                                     │
├── T55 Admin E2E tests ────── T42, T43 ─────────────────────────────────┤
├── T56 Load testing ────────── T34, T48 ────────────────────────────────┤
├── T57 Referral program ───── T7, T2 ───────────────────────────────────┤
├── T58 i18n Amharic ────────── T40, T45 ────────────────────────────────┤
└── T59 Progressive jackpot ── T24, T2 ──────────────────────────────────┤
                                                                         │
TIER 8 (advanced)                                                        │
└── T60 Tournament mode ────── T24, T48, T45 ────────────────────────────┘
```

---

## All 60 Tasks: Sorted by Difficulty

### 🟢 Easy (14 tasks — ~13.5h total)

| # | Task | ⏱️ | Tier | Status |
|---|------|----|------|--------|
| T1 | Auth: Login by username OR phone | 1h | 0 | ✅ Done |
| T3 | Database index optimization | 1h | 0 | ✅ Done |
| T5 | Environment config `.env.example` | 1h | 0 | ✅ Done |
| T10 | Notification DB model + migration | 1h | 1 | ✅ Done |
| T11 | Notification types enum | 0.5h | 1 | ✅ Done |
| T12 | Admin auth: Role check | 1h | 1 | ✅ Done |
| T13 | Admin change password API | 1h | 1 | ✅ Done |
| T18 | Socket events for notifications | 0.5h | 2 | ✅ Done |
| T20 | Notification API routes | 1h | 2 | ✅ Done |
| T21 | Admin dashboard: Wire to API | 1h | 2 | ✅ Done |
| T30 | Admin: Receipt image viewer | 1h | 3 | ✅ Done |
| T33 | Admin: Orders/history wiring | 1h | 3 | ✅ Done |
| T40 | Navigation & layout polish | 2h | 4 | ✅ Done |
| T41 | Admin: Cancel game button | 1h | 4 | ✅ Done |
| T49 | BullMQ dashboard | 1h | 5 | ✅ Done |
| T51b | Admin withdrawal fulfillment enhancement | 1h | 6 | ✅ Done |

### 🟡 Medium (36 tasks — ~86h total)

| # | Task | ⏱️ | Tier | Status |
|---|------|----|------|--------|
| T2 | Wallet: `SELECT FOR UPDATE` locking | 2h | 0 | ✅ Done |
| T4 | Rate limiting & security hardening | 2h | 0 | ✅ Done |
| T6 | Dockerfiles | 3h | 0 | ✅ Done |
| T7 | Auth: Refresh token flow | 3h | 1 | ✅ Done |
| T8 | Fix GameEntry for multi-cartela | 2h | 1 | ✅ Done |
| T9 | File upload: Storage module | 2h | 1 | ✅ Done |
| T15 | Withdrawal route completion | 2h | 2 | ✅ Done |
| T16 | Deposit route: File upload | 1.5h | 2 | ✅ Done |
| T17 | Notification service | 2h | 2 | ✅ Done |
| T19 | Refund service | 2h | 2 | ✅ Done |
| T22 | Payment gateway abstraction | 2h | 2 | ✅ Done |
| T23 | CI/CD pipeline | 4h | 2 | ✅ Done |
| T25 | Game cancellation trigger | 1.5h | 3 | ✅ Done |
| T26 | Auto-cancel insufficient players | 1.5h | 3 | ✅ Done |
| T27 | Integrate notifications into flows | 2h | 3 | ✅ Done |
| T28 | Pinia game store | 3h | 3 | ✅ Done |
| T29 | Frontend: Deposit form | 2h | 3 | ✅ Done |
| T31 | Admin: Pending deposits wiring | 2h | 3 | ✅ Done |
| T32 | Admin: Withdrawals wiring | 2h | 3 | ✅ Done |
| T35 | Production database | 2h | 3 | ⏸️ Skipped (infra) |
| T36 | Lobby page: Real-time | 2h | 4 | ✅ Done |
| T37 | Cartela selection page | 3h | 4 | ✅ Done |
| T38 | Wallet UI (web) | 3h | 4 | ✅ Done |
| T39 | Notification bell component | 2h | 4 | ✅ Done |
| T42 | Admin: Game management page | 3h | 4 | ✅ Done |
| T43 | Admin: User management page | 3h | 4 | ✅ Done |
| T44 | BullMQ queue infrastructure | 1.5h | 4 | ✅ Done |
| T46 | BullMQ: Refund worker | 1.5h | 5 | ✅ Done |
| T47 | BullMQ: Notification worker | 1.5h | 5 | ✅ Done |
| T50 | Deposit form: TeleBirr transaction fields | 3h | 6 | ✅ Done |
| T51 | Admin deposit verification enhancement | 2h | 6 | ✅ Done |
| T51c | Stale request & edge case handling | 2h | 6 | ✅ Done |
| T52 | Prometheus + Grafana monitoring | 4h | 6 | ✅ Done |
| T55 | Admin E2E tests | 3h | 7 | ❌ Todo |
| T56 | Load testing | 3h | 7 | ❌ Todo |
| T57 | Referral program | 4h | 7 | ❌ Todo |
| T58 | i18n Amharic support | 6h | 7 | ❌ Todo |

### 🔴 Hard (10 tasks — ~39h total)

| # | Task | ⏱️ | Tier | Status |
|---|------|----|------|--------|
| T14 | Move game state to Redis | 4h | 2 | ✅ Done |
| T24 | Game engine with Redlock | 3h | 3 | ✅ Done |
| T34 | WebSocket Redis adapter | 3h | 3 | ✅ Done |
| T45 | Live game play page | 5h | 5 | ✅ Done |
| T48 | BullMQ: Game engine worker | 2h | 5 | ✅ Done |
| T53 | API integration tests | 6h | 6 | ✅ Done |
| T54 | Web E2E tests (Playwright) | 6h | 6 | ✅ Done |
| T59 | Progressive jackpot | 4h | 7 | ❌ Todo |

### ⚫ Very Hard (1 task — ~8h total)

| # | Task | ⏱️ | Tier | Status |
|---|------|----|------|--------|
| T60 | Tournament mode | 8h | 8 | ❌ |

---

## Critical Path (Longest Dependency Chain)

The **critical path** — the longest chain that determines minimum project duration:

```
T2 ✅ (locking, 2h)
  → T8 (multi-cartela, 2h)
    → T14 (Redis game state, 4h)
      → T24 (game engine, 3h)
        → T44 (BullMQ setup, 1.5h)
          → T48 (game worker, 2h)
            → T56 (load testing, 3h)
              → T60 (tournament mode, 8h)

Remaining critical path: ~23.5h of sequential work
```

For the **MVP-only critical path** (through live game play):

```
T2 ✅ → T8 ✅ → T14 ✅ → T24 ✅
                                ↓
T1 ✅ → T7 ✅ → T28 ✅ → T36 ✅ → T45 ✅
                                ↑
                          T37 ✅ ←── T28 ✅

MVP critical path: ✅ COMPLETE
```

---

## Quick Start: What to Work on RIGHT NOW

Tiers 0–5 are **complete**. Tier 6 is next. Work in this order:

1. ~~**T1–T49**~~ ✅ All done
2. **T50** — Deposit form: Add TeleBirr fields (3h) � ← enhances deposit UX
3. **T51** — Admin deposit verification enhancement (2h) 🟡 ← receipt cross-check
4. **T51b** — Admin withdrawal fulfillment enhancement (1h) � ← simple polish
5. **T51c** — Stale request & edge case handling (2h) 🟡 ← 15-min deadline, decline reasons
6. **T53** — API integration tests (6h) 🔴 ← unlocks now (all services complete)
7. **T54** — Web E2E tests (6h) 🔴 ← unlocks now (T45 complete)
8. **T52** — Prometheus + Grafana monitoring (4h) 🟡 ← observability

**The MVP is now feature-complete. Remaining work is payment flow polish, testing, and observability.**
**No Chapa or Telebirr API integration is planned — all payments are manual receipt-based.**

---

## Progress Log

| Date | Tier | Tasks Completed | Notes |
|------|------|----------------|-------|
| 2026-02-22 | 0 | T1, T2, T3, T4, T5, T6 | All Tier 0 tasks complete. Prisma migration `20260221210704_t2_wallet_locking_t3_indexes` applied. `@fastify/helmet` installed. |
| 2026-02-22 | 1 | T7, T8, T9, T10, T11, T12, T13 | All Tier 1 tasks complete. Refresh token flow, multi-cartela schema, storage module, notification model/enum, admin auth, change-password API. |
| 2026-02-22 | 2 | T14, T15, T16, T17, T18, T19, T20, T21, T22, T23 | All Tier 2 tasks complete. Redis game-state module, refund service, file upload deposit route, notification service + routes, payment gateway abstraction, CI/CD pipeline. Tests: 73/73 ✅. |
| 2026-02-22 | 3 | T24, T25, T26, T27, T28, T29, T30, T31, T32, T33, T34 | All Tier 3 code tasks complete (T35 skipped — manual infra). Redlock game engine (`lib/game-engine.ts`), cancel/auto-cancel game logic, notification integration, Pinia game store, deposit form, admin deposits/withdrawals/orders pages. Tests: 91/91 ✅ (+18 new). |
| 2026-02-22 | 4 | T36, T37, T38, T39, T40, T41, T42, T43, T44 | All Tier 4 tasks complete. Real-time lobby, cartela selection, wallet UI modals, notification bell (`NotificationBell.vue`), polished header+layout+auth-middleware, admin game/user management pages, BullMQ queue factory (`lib/queue.ts`). |
| 2026-02-22 | 5 | T45, T46, T47, T48, T49 | All Tier 5 tasks complete. Live game play page (`pages/quick/[gameId]/play.vue`), game engine worker (`workers/game-engine.worker.ts`), BullMQ dashboard (`/admin/queues` via `@bull-board/fastify`). GameService.startGame() now enqueues via BullMQ instead of setTimeout. Tests: 142/142 ✅. |
| 2026-02-22 | 6 | T50, T51, T51b, T51c, T52, T53, T54 | All Tier 6 tasks complete. TeleBirr deposit fields (DB migration + shared-types + DepositModal), admin deposit cross-check UI (Txn ID / Sender Name / late-submission badge / predefined decline reasons), admin withdrawal stats + improved UX, Prometheus+Grafana monitoring stack, 15 API integration tests (106/106 ✅), Playwright E2E specs. Also fixed pre-existing bug: withdrawal rejection now uses WITHDRAWAL_PROCESSED notification type. |
