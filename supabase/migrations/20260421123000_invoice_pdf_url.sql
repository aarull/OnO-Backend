-- Persist generated invoice PDF URL (public URL)
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS pdf_url text;

