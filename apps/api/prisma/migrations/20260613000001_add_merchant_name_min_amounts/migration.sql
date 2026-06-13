-- Add merchantName field to payment_methods table
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "merchantName" TEXT;

-- Add min deposit and withdrawal site settings (handled in application defaults, no schema change needed)
