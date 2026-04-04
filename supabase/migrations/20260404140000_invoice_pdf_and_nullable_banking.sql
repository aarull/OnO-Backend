-- PDF attachment + allow invoice rows without banking details when a file is attached (run in Supabase SQL editor or via CLI)
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_file_url text;

ALTER TABLE public.invoices
  ALTER COLUMN account_no DROP NOT NULL,
  ALTER COLUMN ifsc DROP NOT NULL;
