<script setup lang="ts">
const {
  auth,
  locale,
  showDeposit,
  showWithdrawal,
  mobileNavOpen,
  search,
  predictionsEnabled,
  referralsEnabled,
  formattedBalance,
  playerId,
  toggleLocale,
  submitSearch,
  handleLogout,
  openChat,
} = useAppShell()
</script>

<template>
  <div class="ab-shell">
    <!-- ═══════════════ DESKTOP HEADER ═══════════════ -->
    <header class="ab-desktop ab-header">
      <!-- Utility bar -->
      <div class="ab-util">
        <NuxtLink to="/" class="ab-logo" aria-label="AradaBingo home">
          <BrandLogo :height="34" />
        </NuxtLink>

        <div class="ab-search">
          <input
            v-model="search"
            placeholder="Search Games"
            @keyup.enter="submitSearch"
          />
          <button class="ab-search-ico" aria-label="Search" @click="submitSearch">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7" stroke-linecap="round" stroke-linejoin="round" />
              <path d="m20 20-3.2-3.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>

        <div class="ab-spacer" />

        <div class="ab-balance">
          <div class="ab-balance-amt">{{ formattedBalance }} <span>ETB</span></div>
          <div class="ab-balance-id">ID: {{ playerId }}</div>
        </div>

        <template v-if="auth.isAuthenticated">
          <button class="ab-btn-primary" @click="showDeposit = true">Deposit</button>
          <NuxtLink to="/transactions" class="ab-icon-btn" title="Messages">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="m3 7 9 6 9-6" /></svg>
          </NuxtLink>
          <div class="ab-account">
            <button class="ab-icon-btn ab-account-trigger ab-account-round" title="Account">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="8" r="4" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>
            </button>
            <div class="ab-menu">
              <NuxtLink to="/profile" class="ab-menu-item">Profile</NuxtLink>
              <NuxtLink to="/transactions" class="ab-menu-item">History</NuxtLink>
              <NuxtLink to="/wallet" class="ab-menu-item">Wallet</NuxtLink>
              <button class="ab-menu-item" @click="showWithdrawal = true">Withdraw</button>
              <hr />
              <button class="ab-menu-item ab-menu-danger" @click="handleLogout">Logout</button>
            </div>
          </div>
        </template>
        <template v-else>
          <NuxtLink to="/auth/login" class="ab-btn-primary">Login</NuxtLink>
          <NuxtLink to="/auth/register" class="ab-btn-ghost">Register</NuxtLink>
        </template>

        <button class="ab-lang" @click="toggleLocale">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9" stroke-linecap="round" stroke-linejoin="round" /><path stroke-linecap="round" stroke-linejoin="round" d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>
          {{ locale === 'en' ? 'EN' : 'አማ' }}
          <span class="ab-caret">▾</span>
        </button>
      </div>

      <!-- Primary nav -->
      <nav class="ab-nav">
        <NuxtLink to="/" class="ab-nav-link" exact-active-class="ab-nav-active">Home</NuxtLink>
        <NuxtLink to="/games/mini" class="ab-nav-link" active-class="ab-nav-active">Aviator</NuxtLink>
        <NuxtLink to="/games" class="ab-nav-link" exact-active-class="ab-nav-active">Games</NuxtLink>
        <NuxtLink v-if="predictionsEnabled" to="/predictions" class="ab-nav-link" active-class="ab-nav-active">
          Fights<span class="ab-new">NEW</span>
        </NuxtLink>
        <NuxtLink v-else to="/games/live" class="ab-nav-link" active-class="ab-nav-active">
          Virtual Sport<span class="ab-new">NEW</span>
        </NuxtLink>
        <NuxtLink to="/promotions" class="ab-nav-link" active-class="ab-nav-active">Promotions</NuxtLink>
      </nav>
    </header>

    <!-- ═══════════════ MOBILE HEADER ═══════════════ -->
    <header class="ab-mobile ab-header">
      <div class="ab-mtop">
        <button class="ab-micon" aria-label="Menu" @click="mobileNavOpen = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <NuxtLink to="/" class="ab-logo ab-logo-sm" aria-label="AradaBingo home">
          <BrandLogo :height="26" />
        </NuxtLink>
        <NuxtLink to="/search" class="ab-micon" aria-label="Search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" stroke-linecap="round" stroke-linejoin="round" /><path d="m20 20-3.2-3.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </NuxtLink>
        <div class="ab-spacer" />
        <div class="ab-balance ab-balance-sm">
          <div class="ab-balance-amt">{{ formattedBalance }} <span>ETB</span></div>
          <div class="ab-balance-id">ID: {{ playerId }}</div>
        </div>
        <button
          v-if="auth.isAuthenticated"
          class="ab-btn-primary ab-btn-sm"
          @click="showDeposit = true"
        >
          Deposit
        </button>
        <NuxtLink v-else to="/auth/login" class="ab-btn-primary ab-btn-sm">Login</NuxtLink>
      </div>

      <div class="ab-mnav noscroll">
        <NuxtLink to="/" class="ab-mtab" exact-active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
          <span>Home</span>
        </NuxtLink>
        <NuxtLink to="/games/mini" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2-3 3 6 2-4 2 2h7" /><path d="M17 6l4 2-4 2" /></svg>
          <span>Aviator</span>
        </NuxtLink>
        <NuxtLink to="/games" class="ab-mtab" exact-active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
          <span>Games</span>
        </NuxtLink>
        <NuxtLink v-if="predictionsEnabled" to="/predictions" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5 4 9l2.5 2.5M9 4 7 6M14.5 14.5 12 12M17 20l2.5-2.5L17 15M15 20l2-2M4 20l7.5-7.5M14 4l6 6" /></svg>
          <span>Fights</span>
        </NuxtLink>
        <NuxtLink v-if="!predictionsEnabled" to="/games/live" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <span>Virtual</span>
        </NuxtLink>
        <NuxtLink to="/promotions" class="ab-mtab" active-class="ab-mtab-active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8V4M12 8c-2 0-4-1.2-4-2.6S9.5 3 12 4M12 8c2 0 4-1.2 4-2.6S14.5 3 12 4" /></svg>
          <span>Promo</span>
        </NuxtLink>
      </div>
    </header>

    <!-- Mobile slide-in drawer -->
    <Transition
      enter-active-class="ab-drawer-enter"
      leave-active-class="ab-drawer-leave"
    >
      <div v-if="mobileNavOpen" class="ab-drawer-wrap">
        <div class="ab-drawer-scrim" @click="mobileNavOpen = false" />
        <aside class="ab-drawer">
          <div class="ab-drawer-head">
            <span class="ab-logo ab-logo-sm">
              <BrandLogo :height="26" />
            </span>
            <button class="ab-micon" aria-label="Close" @click="mobileNavOpen = false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <div class="ab-drawer-body">
            <template v-if="auth.isAuthenticated">
              <div class="ab-drawer-balance">
                <span>Balance</span>
                <strong>{{ formattedBalance }} ETB</strong>
              </div>
              <button class="ab-drawer-item" @click="showDeposit = true; mobileNavOpen = false">Deposit</button>
              <button class="ab-drawer-item" @click="showWithdrawal = true; mobileNavOpen = false">Withdraw</button>
              <NuxtLink to="/profile" class="ab-drawer-item" @click="mobileNavOpen = false">Profile</NuxtLink>
              <NuxtLink to="/transactions" class="ab-drawer-item" @click="mobileNavOpen = false">History</NuxtLink>
              <NuxtLink v-if="referralsEnabled" to="/refer" class="ab-drawer-item" @click="mobileNavOpen = false">Refer &amp; Earn</NuxtLink>
              <button class="ab-drawer-item" @click="toggleLocale(); mobileNavOpen = false">
                {{ locale === 'en' ? 'Switch to Amharic (አማ)' : 'Switch to English (EN)' }}
              </button>
              <button class="ab-drawer-item ab-drawer-danger" @click="handleLogout">Logout</button>
            </template>
            <template v-else>
              <NuxtLink to="/auth/login" class="ab-btn-primary ab-drawer-cta" @click="mobileNavOpen = false">Login</NuxtLink>
              <NuxtLink to="/auth/register" class="ab-btn-ghost ab-drawer-cta" @click="mobileNavOpen = false">Create Account</NuxtLink>
              <button class="ab-drawer-item" @click="toggleLocale(); mobileNavOpen = false">
                {{ locale === 'en' ? 'Switch to Amharic (አማ)' : 'Switch to English (EN)' }}
              </button>
            </template>
          </div>
        </aside>
      </div>
    </Transition>

    <!-- ═══════════════ PAGE CONTENT ═══════════════ -->
    <main class="ab-main">
      <Transition name="page-fade" mode="out-in">
        <slot />
      </Transition>
    </main>

    <!-- ═══════════════ FOOTER ═══════════════ -->
    <footer class="ab-footer">
      <div class="ab-footer-inner">
        <div class="ab-footer-top">
          <div class="ab-footer-brand">
            <span class="ab-logo">
              <BrandLogo :height="34" />
            </span>
            <p>Ethiopia's premium online bingo and gaming destination. Play responsibly and enjoy the thrill.</p>
          </div>
          <div class="ab-footer-cols">
            <div class="ab-footer-col">
              <h4>Games</h4>
              <NuxtLink to="/games">Bingo</NuxtLink>
              <NuxtLink to="/games">Slots</NuxtLink>
              <NuxtLink to="/games">Fish Games</NuxtLink>
              <NuxtLink to="/games">Arcade</NuxtLink>
            </div>
            <div class="ab-footer-col">
              <h4>Account</h4>
              <NuxtLink to="/wallet">Deposit</NuxtLink>
              <NuxtLink to="/wallet">Withdraw</NuxtLink>
              <NuxtLink to="/profile">My Profile</NuxtLink>
              <NuxtLink to="/transactions">History</NuxtLink>
            </div>
            <div class="ab-footer-col">
              <h4>Support</h4>
              <a href="#" @click.prevent="openChat">Help Center</a>
              <a href="#" @click.prevent="openChat">Contact Us</a>
              <a href="#">Terms</a>
              <a href="#">Privacy Policy</a>
            </div>
          </div>
        </div>
        <div class="ab-footer-bottom">
          <p>Responsible Gaming: AradaBingo is intended for users 18 years and older. Gambling can be addictive — play within your limits. If you or someone you know has a gambling problem, please seek help. © 2026 AradaBingo. All rights reserved.</p>
          <span class="ab-18">18+</span>
        </div>
      </div>
    </footer>

  </div>
</template>
