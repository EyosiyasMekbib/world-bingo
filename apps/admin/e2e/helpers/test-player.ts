/**
 * A player account for admin fixtures.
 *
 * These suites used to create one with `POST /auth/register`. That route is
 * gone: players sign in with a Firebase SMS code and have no password, so
 * nothing a test can call from here will mint an account (see
 * docs/firebase-auth.md).
 *
 * Supply one instead. The quickest way, against a deployment with a Firebase
 * **test phone number** configured:
 *
 *   1. Sign in on the player app with that number and its fixed code.
 *   2. Copy `user.id` and `accessToken` from the `/auth/phone` response
 *      (dev tools → Network).
 *   3. Export them before running the suite:
 *
 *        E2E_PLAYER_USER_ID=…  E2E_PLAYER_ACCESS_TOKEN=…  pnpm test:e2e
 *
 * The access token is good for 15 minutes, which is a suite's worth of runtime;
 * re-copy it if a run outlives it. Without both vars the fixtures skip rather
 * than fail, so a run on a deployment with no Firebase project configured does
 * not look like a regression.
 */
export interface PlayerFixture {
    userId: string
    accessToken: string
}

export function testPlayer(): PlayerFixture | null {
    const userId = process.env.E2E_PLAYER_USER_ID
    const accessToken = process.env.E2E_PLAYER_ACCESS_TOKEN
    if (!userId || !accessToken) return null
    return { userId, accessToken }
}

/** Reason string for `test.skip(...)`, so every suite says the same thing. */
export const NO_PLAYER_FIXTURE =
    'set E2E_PLAYER_USER_ID and E2E_PLAYER_ACCESS_TOKEN — players sign in by SMS and cannot be created from a test (see docs/firebase-auth.md)'
