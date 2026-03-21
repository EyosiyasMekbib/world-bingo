<template>
  <!-- Auth layout — intentionally no header/nav, no session data shown -->
  <div class="auth-layout">
    <!-- Decorative background orbs -->
    <div class="orb orb-1" aria-hidden="true" />
    <div class="orb orb-2" aria-hidden="true" />
    <div class="orb orb-3" aria-hidden="true" />

    <!-- Centered card slot -->
    <main class="auth-main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.auth-layout {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  background: var(--surface-base, #0a0f1e);
  padding: 1.5rem;
}

/* Decorative soft gradient orbs */
.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  pointer-events: none;
  z-index: 0;
}
.orb-1 {
  width: 500px; height: 500px;
  top: -180px; left: -120px;
  background: radial-gradient(circle, rgba(245,158,11,0.12) 0%, transparent 70%);
}
.orb-2 {
  width: 400px; height: 400px;
  bottom: -150px; right: -100px;
  background: radial-gradient(circle, rgba(6,182,212,0.1) 0%, transparent 70%);
}
.orb-3 {
  width: 300px; height: 300px;
  top: 40%; left: 60%;
  background: radial-gradient(circle, rgba(139,92,246,0.07) 0%, transparent 70%);
}

.auth-main {
  position: relative;
  z-index: 10;
  width: 100%;
  max-width: 420px;
  animation: auth-slide-up 0.4s var(--ease-out, cubic-bezier(0.16,1,0.3,1)) both;
}

@keyframes auth-slide-up {
  from { opacity: 0; transform: translateY(24px); }
  to   { opacity: 1; transform: translateY(0); }
}
</style>
