-- Last payment UTR from release modal (for internal records)
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS last_payment_utr text;
