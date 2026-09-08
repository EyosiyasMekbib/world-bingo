/** The bucket the deposit_amount_entered event has always sent. Pure. */
export function amountBucket(amount: number): '<500' | '500-1000' | '1000-5000' | '5000+' {
  const n = Number(amount)
  if (!(n >= 500)) return '<500'
  if (n < 1000) return '500-1000'
  if (n < 5000) return '1000-5000'
  return '5000+'
}
