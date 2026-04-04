-- Optional payee / tax identity fields (run in Supabase SQL editor or via supabase db push)
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS account_holder_name text,
  ADD COLUMN IF NOT EXISTS pan_number text,
  ADD COLUMN IF NOT EXISTS gst_number text;
