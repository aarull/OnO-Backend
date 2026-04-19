-- Partial payments support:
-- - Track cumulative amount paid
-- - Track payment history as JSONB array
-- - Allow new status 'partially_paid' when status is an enum

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS amount_paid numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_history jsonb NOT NULL DEFAULT '[]'::jsonb;

-- If `status` is backed by a Postgres enum type, add the new value.
DO $$
DECLARE
  status_udt_name text;
BEGIN
  SELECT c.udt_name
    INTO status_udt_name
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'invoices'
    AND c.column_name = 'status'
    AND c.data_type = 'USER-DEFINED'
  LIMIT 1;

  IF status_udt_name IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = status_udt_name
        AND e.enumlabel = 'partially_paid'
    ) THEN
      EXECUTE format('ALTER TYPE %I ADD VALUE %L', status_udt_name, 'partially_paid');
    END IF;
  END IF;
END $$;

