-- Object path within the "invoices" bucket (e.g. creator_uuid/INV-2026-0001.pdf) for signed URL generation
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_file_path text;
