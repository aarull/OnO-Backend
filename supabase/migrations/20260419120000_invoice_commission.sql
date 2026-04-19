-- Agency commission persisted on invoice rows
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS commission_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_amount numeric NOT NULL DEFAULT 0;
