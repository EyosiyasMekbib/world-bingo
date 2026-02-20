# World Bingo — UI/UX & Frontend Design Specification

> **Reference System Analysis:** 2026-02-20

---

## 1. Design Principles

1. **Dark-first, high contrast**: The gambling/gaming context demands a dark theme. Players may play for extended sessions — dark reduces eye strain.
2. **Instant feedback**: Every tap/click must have immediate visual feedback. No dead zones.
3. **Money is always visible**: The wallet balance must be visible at all times from within a game.
4. **Real-time state honesty**: Timers, player counts, and numbers must update live — never stale.
5. **Mobile-first layout**: Most Ethiopian players are on mobile; design for 375px width first.

---

## 2. Design Token System

### 2.1 Color Palette

```css
/* === SEMANTIC COLOR SYSTEM === */
:root {
  /* --- Surfaces --- */
  --surface-base:       #0a0f1e;   /* Page background — deepest layer */
  --surface-raised:     #111827;   /* Cards, modals */
  --surface-overlay:    #1c2537;   /* Hover states, inputs */
  --surface-border:     #1e2d4a;   /* Subtle dividers */

  /* --- Primary Brand (Gold) --- */
  --brand-primary:      #f59e0b;   /* CTAs: Join, Deposit, Start Play */
  --brand-primary-dim:  #d97706;   /* Hover/active state */
  --brand-primary-glow: rgba(245,158,11,0.3); /* Button glow effect */

  /* --- Accent (Cyan) --- */
  --accent-primary:     #06b6d4;   /* Active numbers, highlights, selected */
  --accent-dim:         #0891b2;   /* Hover state */
  --accent-glow:        rgba(6,182,212,0.25); /* Number ball glow */

  /* --- Semantic Status --- */
  --status-success:     #10b981;   /* Win, Refunded, Completed */
  --status-error:       #ef4444;   /* Loss, Cancelled, Rejected */
  --status-warning:     #f59e0b;   /* Pending */
  --status-info:        #3b82f6;   /* General info */

  /* --- Text --- */
  --text-primary:       #f1f5f9;   /* Main readable text */
  --text-secondary:     #94a3b8;   /* Labels, captions */
  --text-disabled:      #475569;   /* Disabled states */
  --text-on-brand:      #000000;   /* Text on gold buttons */

  /* --- Game Specific --- */
  --cartela-unmarked-bg:  #1e2d4a;
  --cartela-marked-bg:    #0891b2;
  --cartela-marked-text:  #ffffff;
  --cartela-free-bg:      #f59e0b;
  --cartela-free-text:    #000000;
  --number-called-glow:   rgba(6,182,212,0.6);
  --winner-glow:          rgba(245,158,11,0.8);
}
```

### 2.2 Typography

```css
/* Import */
@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&display=swap');

:root {
  /* Rajdhani: Numeric/Game UI elements (bold, slightly condensed — feels sporty) */
  --font-game:   'Rajdhani', sans-serif;

  /* Nunito: Body copy, labels, navigation (friendly, rounded) */
  --font-body:   'Nunito', sans-serif;

  /* Scale */
  --text-xs:    0.75rem;    /* 12px — tiny labels */
  --text-sm:    0.875rem;   /* 14px — captions */
  --text-base:  1rem;       /* 16px — default body */
  --text-lg:    1.125rem;   /* 18px — emphasized body */
  --text-xl:    1.25rem;    /* 20px — heading small */
  --text-2xl:   1.5rem;     /* 24px — heading medium */
  --text-3xl:   1.875rem;   /* 30px — heading large */
  --text-4xl:   2.25rem;    /* 36px — hero display */
  --text-game:  3rem;       /* 48px — called number display */
  --text-bingo: 4rem;       /* 64px — BINGO! headline */
}
```

### 2.3 Spacing & Layout

```css
:root {
  --space-1:   4px;
  --space-2:   8px;
  --space-3:   12px;
  --space-4:   16px;
  --space-5:   20px;
  --space-6:   24px;
  --space-8:   32px;
  --space-10:  40px;
  --space-12:  48px;
  --space-16:  64px;

  --radius-sm:  6px;
  --radius-md:  12px;
  --radius-lg:  16px;
  --radius-xl:  24px;
  --radius-full: 9999px;

  --shadow-card:   0 4px 24px rgba(0, 0, 0, 0.4);
  --shadow-modal:  0 20px 60px rgba(0, 0, 0, 0.6);
  --shadow-glow-gold: 0 0 24px rgba(245, 158, 11, 0.4);
  --shadow-glow-cyan: 0 0 24px rgba(6, 182, 212, 0.4);
}
```

### 2.4 Animation Tokens

```css
:root {
  --duration-instant:  100ms;
  --duration-fast:     200ms;
  --duration-normal:   350ms;
  --duration-slow:     500ms;
  --duration-xslow:    800ms;

  --ease-out:        cubic-bezier(0.16, 1, 0.3, 1);     /* Snappy exit */
  --ease-bounce:     cubic-bezier(0.34, 1.56, 0.64, 1); /* Ball bounce */
  --ease-linear:     linear;
}
```

---

## 3. Screen Designs

### 3.1 Authentication Screen (`/auth`)

```
┌─────────────────────────────────┐
│         [World Bingo Logo]      │  ← Animated logo entrance
│         WORLD BINGO             │
│                                 │
│   ┌─────────┐ ┌─────────────┐   │
│   │  PHONE  │ │  USERNAME   │   │  ← Tab switcher
│   └─────────┘ └─────────────┘   │
│                                 │
│   ┌─────────────────────────┐   │
│   │ Username                │   │
│   └─────────────────────────┘   │
│   ┌─────────────────────────┐   │
│   │ Password            👁  │   │
│   └─────────────────────────┘   │
│                                 │
│   □ Remember me                 │
│                                 │
│   ┌─────────────────────────┐   │
│   │       SIGN IN           │   │  ← Gold button with glow
│   └─────────────────────────┘   │
│                                 │
│   Don't have an account?        │
│   [Sign Up]                     │
└─────────────────────────────────┘

Key behaviors:
- Background: Animated particle/dot grid with subtle motion
- Logo animates down from top on load (300ms ease-out)
- Form fields slide up staggered (100ms delay each)
- Password field has show/hide toggle
- Error state: field border turns red, message appears below
- Loading state: button shows spinner, disabled
```

### 3.2 Lobby Screen (`/`)

```
┌─────────────────────────────────────┐
│ [☰]   WORLD BINGO   [🔔] [¥350.00] │  ← Header
├─────────────────────────────────────┤
│                                     │
│   QUICK BINGO ROOMS                 │  ← Section heading
│                                     │
│ ┌─────────────────────────────────┐ │
│ │           10 BIRR               │ │  ← Game Card
│ │  ─────────────────────────────  │ │
│ │  👥 3 Players   ⏱ 01:45        │ │
│ │                                  │ │
│ │          [ JOIN GAME ]           │ │  ← Gold CTA
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │           20 BIRR               │ │
│ │  ─────────────────────────────  │ │
│ │  👥 7 Players   ⏱ 00:30        │ │
│ │                                  │ │
│ │          [ JOIN GAME ]           │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │           50 BIRR               │ │
│ │  ─────────────────────────────  │ │
│ │  👥 2 Players   ⏱ 02:15        │ │
│ │                                  │ │
│ │          [ JOIN GAME ]           │ │
│ └─────────────────────────────────┘ │
│                                     │
└─────────────────────────────────────┘

Key behaviors:
- Player count and countdown update in real-time (WebSocket)
- Cards have subtle entry animation (fade + slide up, staggered)
- Countdown timer pulses red when < 30 seconds
- "JOIN GAME" button has gold glow on hover
```

### 3.3 Cartela Selection Screen (`/quick/[gameId]`)

```
┌─────────────────────────────────────┐
│ [←]    SELECT CARTELAS    [¥350.00] │
├─────────────────────────────────────┤
│                                     │
│  Game: 10 Birr   Cartela: 10 Birr  │
│  ▶ Total: 20 Birr (2 selected)      │
│                                     │
├─────────────────────────────────────┤
│                                     │
│  [1] [2] [3] [4] [5] [6] [7] [8]  │  ← Cartela number grid
│  [9] [10][11][12][13][14][15][16]  │    Squares, ~40x40px each
│  [17][18][19][20][21][22][23][24]  │    Selected = cyan border + fill
│  [25][26][27][28][29][30]...       │
│                                     │
│  (scroll down for more)             │
│                                     │
├─────────────────────────────────────┤
│  ┌───────────────────────────────┐  │
│  │       START PLAY (20 Birr)    │  │  ← Disabled until 1 selected
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘

Key behaviors:
- Selected cartelas highlighted with cyan glow and checkmark
- Taken (by other players) cartelas shown grayed out, not clickable
- Total cost in CTA button updates dynamically
- CTA disabled (gray) if no cartelas selected or insufficient balance
- Tap a cartela: shows a mini preview of the actual 5×5 grid
```

### 3.4 Live Game Screen (`/quick/[gameId]/play`)

```
┌─────────────────────────────────────┐
│ [←]    10 Birr BINGO    [BINGO!🔕] │
├─────────────────────────────────────┤
│                                     │
│    CURRENT BALL                     │
│  ╔═══════════════╗                  │
│  ║       N       ║                  │  ← Column letter
│  ║      42       ║                  │  ← Big number display
│  ╚═══════════════╝                  │     Animated bounce-in
│                                     │
│  Called: 5 · N42 · B3 · ...        │  ← Previous numbers scroll
│                                     │
├─────────────────────────────────────┤
│           MY CARTELAS               │
│                                     │
│          CARTELA #1                 │
│  ┌────────────────────────────────┐ │
│  │    B    I    N    G    O       │ │
│  │ [ 5][ ·][32][46][61]          │ │  ← Called numbers highlighted cyan
│  │ [ 3][20][35][ ·][69]          │ │    (or auto-marked)
│  │ [ ·][28][★ ][53][74]          │ │  ← ★ = FREE space (gold)
│  │ [14][24][39][48][ ·]          │ │
│  │ [ 1][16][44][60][75]          │ │
│  └────────────────────────────────┘ │
│                                     │
│          CARTELA #2                 │
│  ┌────────────────────────────────┐ │
│  │ ...                            │ │
│  └────────────────────────────────┘ │
│                                     │
│  ┌────────────────────────────────┐ │
│  │         🏆 BINGO! 🏆          │ │  ← Appears when pattern complete
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘

Key behaviors:
- Called number animates in with bounce effect + glow
- Audio: ball "thunk" sound when number called
- Matching numbers on cartela auto-highlight (cell flips/fills cyan)
- BINGO! button becomes active (gold pulse) when pattern detected
- Full-screen confetti explosion on winner declaration
- Loser: gentle fade + "Better luck next time" toast
```

### 3.5 Wallet Modal

```
┌─────────────────────────────────────┐
│ ✕               WALLET              │
├─────────────────────────────────────┤
│                                     │
│         YOUR BALANCE                │
│         ETB 350.00                  │  ← Large, prominent
│                                     │
│  ┌──────────────┐ ┌──────────────┐  │
│  │   DEPOSIT    │ │   WITHDRAW   │  │
│  └──────────────┘ └──────────────┘  │
│                                     │
├─────────────────────────────────────┤
│  TRANSACTION HISTORY                │
│                                     │
│  BET       -10.00  2/20  ✅         │
│  REFUND   +10.00  2/20  ✅         │
│  DEPOSIT  +200.00 2/19  ✅         │
│  ...                                │
└─────────────────────────────────────┘

DEPOSIT VIEW:
┌─────────────────────────────────────┐
│ ✕              DEPOSIT              │
├─────────────────────────────────────┤
│  Amount (min 25 Birr)               │
│  ┌─────────────────────────────┐    │
│  │ ETB _______                 │    │
│  └─────────────────────────────┘    │
│  [+50] [+100] [+200] [+500]         │  ← Quick add chips
│                                     │
│  Payment Method                     │
│  ◉ Telebirr   ○ CBE Birr           │
│                                     │
│  Send to: 09XXXXXXXX               │
│  [? How to deposit video]           │
│                                     │
│  Upload Receipt                     │
│  ┌─────────────────────────────┐    │
│  │    📎 Drop image here       │    │
│  └─────────────────────────────┘    │
│                                     │
│  [ SUBMIT DEPOSIT REQUEST ]         │
└─────────────────────────────────────┘
```

### 3.6 Sidebar Navigation

```
┌──────────────────────────┐
│ MENU                   ✕ │
├──────────────────────────┤
│                          │
│  [👤] georgianna.bode99  │
│  ETB 350.00              │
│                          │
├──────────────────────────┤
│                          │
│  💰  Wallet              │
│  📋  Game History        │
│  🔔  Notifications       │
│  ⚙️   Settings           │
│                          │
├──────────────────────────┤
│                          │
│  🔓  Logout              │
│                          │
└──────────────────────────┘
```

---

## 4. Component Library

### 4.1 `<GameRoomCard>` Component

```tsx
interface GameRoomCardProps {
  ticketPrice: number;
  playerCount: number;
  minPlayers: number;
  secondsRemaining: number;
  onJoin: () => void;
  isJoining: boolean;
}

// States:
// - Default: dark card, gold join button
// - Hover: subtle scale(1.02), border glow
// - Timer < 30s: countdown flashes red
// - Joining: button shows spinner
// - Full: join button disabled
```

### 4.2 `<CartelaGrid>` Component

```tsx
interface CartelaGridProps {
  cartela: {
    B: number[], I: number[],
    N: (number | 'FREE')[],
    G: number[], O: number[]
  };
  calledNumbers: Set<number>;
  isWinner?: boolean;
  size?: 'sm' | 'md' | 'lg';  // sm for selection screen, lg for game screen
}

// Cell states:
// - Unmarked: dark background, white number
// - Called: cyan fill, white number, subtle glow
// - FREE space: gold fill, star icon
// - Winner row: gold border animation
```

### 4.3 `<BingoBall>` Component

```tsx
interface BingoBallProps {
  number: number;
  column: 'B' | 'I' | 'N' | 'G' | 'O';
  isAnimating: boolean;
}

// Animation sequence on new ball:
// 1. Ball enters from top (translateY: -200px → 0)
// 2. Bounce at bottom (scale: 1.15 → 1)
// 3. Cyan glow radiates out
// 4. Column letter pulses
// Duration: 800ms total
```

### 4.4 `<CountdownTimer>` Component

```tsx
interface CountdownTimerProps {
  secondsRemaining: number;
  totalSeconds: number;
  size?: 'sm' | 'lg';
}

// Visual:
// - Circular progress ring behind number
// - Color: cyan when > 30s, gold when 10–30s, red when < 10s
// - Pulses at < 10 seconds
// - Digit flip animation on each second change
```

### 4.5 `<WalletBalance>` Component

```tsx
// Always visible in header
// - Animates (count-up) when balance changes
// - Green flash on increase, red flash on decrease
// - Tap to open wallet modal
```

---

## 5. Key Interaction Animations

### 5.1 Bingo Number Called
```css
@keyframes ball-enter {
  0%   { transform: translateY(-200px) scale(0.5); opacity: 0; }
  60%  { transform: translateY(10px) scale(1.1); opacity: 1; }
  80%  { transform: translateY(-5px) scale(0.97); }
  100% { transform: translateY(0) scale(1); opacity: 1; }
}

@keyframes number-glow-pulse {
  0%, 100% { box-shadow: 0 0 20px var(--accent-glow); }
  50%       { box-shadow: 0 0 40px var(--accent-glow), 0 0 80px var(--accent-glow); }
}
```

### 5.2 Card Cell Marked
```css
@keyframes cell-mark {
  0%   { transform: scale(1); background: var(--cartela-unmarked-bg); }
  50%  { transform: scale(1.2); background: var(--accent-primary); }
  100% { transform: scale(1); background: var(--cartela-marked-bg); }
}
```

### 5.3 BINGO! Victory Screen
```css
/* Full-screen overlay */
@keyframes bingo-banner {
  0%   { transform: scale(0.5) rotate(-5deg); opacity: 0; }
  60%  { transform: scale(1.1) rotate(2deg); opacity: 1; }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}

/* Particle confetti: use canvas or CSS keyframe combination */
```

### 5.4 Game Card Hover
```css
.game-card {
  transition: transform var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.game-card:hover {
  transform: translateY(-4px) scale(1.01);
  box-shadow: var(--shadow-card), 0 0 30px var(--brand-primary-glow);
}
```

### 5.5 Balance Counter Animation
```tsx
// Use requestAnimationFrame to count from oldBalance to newBalance
// Duration: 500ms, easeOut
// Flash green/red background for 800ms
```

---

## 6. Responsive Breakpoints

```css
/* Mobile first */
--bp-sm:  480px;   /* Large phones */
--bp-md:  768px;   /* Tablets */
--bp-lg:  1024px;  /* Small laptops */
--bp-xl:  1280px;  /* Desktops */

/* Layout shifts: */
/* < 768px: Single column, bottom-anchored CTAs, full-width modals */
/* 768–1024px: Two column lobby, slide-in sidebar */
/* > 1024px: Three column lobby, persistent sidebar */
```

---

## 7. Audio Design

| Event | Sound |
|---|---|
| Number called | Satisfying "thunk" ball sound |
| Card cell marked | Soft "click" |
| BINGO! earned | Fanfare / celebration jingle |
| Game cancelled | Subtle "whoosh" descend |
| Deposit approved | Cash register "ching" |
| Win notification | Ascending chime |

- All sounds web-Audio-API based (no large audio file downloads)
- Global mute toggle in header (persisted to localStorage)

---

## 8. Accessibility (A11y)

| Requirement | Implementation |
|---|---|
| Color contrast | All text ≥ 4.5:1 ratio against backgrounds |
| Keyboard navigation | Tab order logical; Enter/Space for buttons |
| Screen reader support | Semantic HTML, `aria-live` for called numbers |
| Focus indicators | Visible ring on all interactive elements |
| Motion preference | `prefers-reduced-motion` disables animations |
| Error messages | Descriptive, linked to offending field via `aria-describedby` |

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 9. Error States

| Scenario | UI Treatment |
|---|---|
| Insufficient balance to join | Toast: "Insufficient balance. [Deposit Now]" |
| Cartela already taken | Cell grays out instantly; toast "Cartela taken" |
| Network disconnection in game | Banner at top: "Reconnecting..." with spinner |
| Game cancelled mid-join | Redirect to lobby + toast "Game cancelled. Refunded 10.00 Birr" |
| Invalid BINGO claim | Brief red flash on BINGO button; toast "Not a valid Bingo!" |
| Login failed | Inline error below fields |
| Upload failed | Error in upload zone, retry button |

---

## 10. Admin Panel Design Spec

### Admin Dashboard Layout
```
┌────────────────────────────────────────────────────────────────┐
│  WORLD BINGO ADMIN              [⚙] Admin Name   [Logout]      │
├──────────────┬─────────────────────────────────────────────────┤
│              │                                                  │
│  [Dashboard] │   📊 TODAY'S OVERVIEW                           │
│  [Payments]  │   ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  [Games]     │   │ ₿12,500  │ │  ₿4,200  │ │  Active  │       │
│  [Users]     │   │ Deposits │ │Withdrawals│ │  Games:5 │       │
│  [Reports]   │   └──────────┘ └──────────┘ └──────────┘       │
│              │                                                  │
│              │   📋 PENDING PAYMENTS (8)                       │
│              │   ┌──────────────────────────────────────────┐  │
│              │   │ User    │ Type    │ Amount │ Time  │ Act │  │
│              │   │ john... │ DEPOSIT │ 200.00 │ 5m ago│ ✅✗ │  │
│              │   │ mary... │ DEPOSIT │  50.00 │ 12m   │ ✅✗ │  │
│              │   └──────────────────────────────────────────┘  │
│              │   [View Receipt] button on each row              │
└──────────────┴─────────────────────────────────────────────────┘
```
