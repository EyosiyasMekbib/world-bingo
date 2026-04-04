# Promotion Banners Design

## Goal

Add two small informational banners on the home page — one for the active cashback promotion, one for the first deposit bonus — displayed between the hero section and the game list, visible to all visitors.

## Architecture

A new public API route `GET /promotions` returns the active cashback promotion details and the configured first deposit bonus amount from site settings. The web app fetches this once on home page mount, stores the result in a Pinia store (`store/promotions.ts`), and two new banner components (`CashbackBanner.vue`, `FirstDepositBanner.vue`) read from that store reactively.

**Tech Stack:** Fastify v5, Prisma 5, Nuxt 3, Vue 3, Pinia, Tailwind CSS, `@nuxtjs/i18n`

---

## API

### `GET /promotions` (public, no auth required)

**Response:**
```ts
{
  cashback: {
    name: string
    refundType: 'PERCENTAGE' | 'FIXED'
    refundValue: number
    frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  } | null  // null if no active promotion exists

  firstDepositBonus: number | null  // null if site setting not configured
}
```

- `cashback`: the first active cashback promotion from the DB (`isActive: true`), or `null`
- `firstDepositBonus`: value of `siteSetting` with key `first_deposit_bonus_amount`, parsed as a number, or `null`

---

## Frontend

### New Files

**`apps/web/store/promotions.ts`**
- State: `cashback: CashbackPromo | null`, `firstDepositBonus: number | null`
- Action: `fetch()` — calls `GET /promotions`, sets state; silently ignores errors (leaves state as `null`)

**`apps/web/components/CashbackBanner.vue`**
- Reads `cashback` from promotions store
- Renders nothing if `cashback` is `null`
- Displays: amber-accented horizontal strip with 💰 icon and localized text interpolating `refundValue`, `refundType`, `frequency`
- Example: "Get 10% cashback on your weekly losses"

**`apps/web/components/FirstDepositBanner.vue`**
- Reads `firstDepositBonus` from promotions store
- Renders nothing if `firstDepositBonus` is `null`
- Displays: amber-accented horizontal strip with 🎁 icon and localized text interpolating the bonus amount
- Example: "Get 50 ETB bonus on your first deposit"

### Modified Files

**`apps/web/pages/index.vue`**
- Import and call `promotionsStore.fetch()` in `onMounted`
- Render `<CashbackBanner />` and `<FirstDepositBanner />` between the hero section and the game list

**`apps/web/locales/en.json`**
```json
"promo": {
  "cashback_percentage": "Get {value}% cashback on your {frequency} losses",
  "cashback_fixed": "Get {value} ETB cashback on your {frequency} losses",
  "first_deposit": "Get {amount} ETB bonus on your first deposit",
  "frequency_daily": "daily",
  "frequency_weekly": "weekly",
  "frequency_monthly": "monthly"
}
```

**`apps/web/locales/am.json`**
- Amharic equivalents for all keys above

---

## Banner UI

- Full-width horizontal strip
- Background: amber-50 (`bg-amber-50`), border: amber-200 (`border border-amber-200`), text: amber-900 (`text-amber-900`)
- Padding: `px-4 py-2`, rounded: `rounded-lg`
- Icon + text in a single row (`flex items-center gap-2`)
- Two banners stack vertically with `gap-2` between them in a wrapping `div`
- If both banners have no data, the wrapping `div` renders nothing

---

## Error Handling

- `GET /promotions` failure → both banners remain hidden; no error shown to user
- Banners default hidden (state is `null`) until fetch completes
- No loading skeleton

---

## Testing

- Unit test for the new API route: returns correct shape when active promo + setting exist; returns `null` fields when neither exist
- Unit test for `promotions` store: `fetch()` sets state correctly; ignores errors gracefully
