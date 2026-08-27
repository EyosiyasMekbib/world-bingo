-- AlterEnum
-- Alone in its own migration: Postgres will not let a value added to an enum be
-- USED in the same transaction that adds it, and Prisma wraps each migration in
-- one. Anything referencing this value therefore belongs in a later migration.
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_STATUS_CHANGED';
