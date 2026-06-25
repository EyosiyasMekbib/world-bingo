/** Fixed-width deployment code: exactly 3 lowercase-alphanumeric chars. */
export const DEPLOYMENT_CODE_LENGTH = 3
const MAX_ACCOUNT_LENGTH = 40 // GASea: 3–40 alphanumeric username

const CODE_RE = /^[a-z0-9]{3}$/

export function isValidDeploymentCode(code: string): boolean {
  return CODE_RE.test(code)
}

/** Prepend the deployment code to an account. Throws if the result is invalid. */
export function namespaceAccount(depCode: string, account: string): string {
  if (!isValidDeploymentCode(depCode)) {
    throw new Error(
      `Invalid deployment code: "${depCode}" (must be 3 lowercase alphanumeric chars)`,
    )
  }
  const ns = depCode + account
  if (ns.length > MAX_ACCOUNT_LENGTH) {
    throw new Error(`Namespaced account "${ns}" exceeds ${MAX_ACCOUNT_LENGTH} chars`)
  }
  return ns
}

/** Split a namespaced account into its deployment code and bare account. */
export function parseNamespacedAccount(namespaced: string): { depCode: string; account: string } {
  if (namespaced.length <= DEPLOYMENT_CODE_LENGTH) {
    throw new Error(`Namespaced account "${namespaced}" is too short to contain a deployment code`)
  }
  return {
    depCode: namespaced.slice(0, DEPLOYMENT_CODE_LENGTH),
    account: namespaced.slice(DEPLOYMENT_CODE_LENGTH),
  }
}
