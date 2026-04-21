import { Router, Response } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../lib/supabase.js';
import { AuthenticatedRequest, UserProfile } from '../middleware/auth.js';
import { appendInvoiceToSheet } from '../services/googleSheets.js';

const router = Router();

const INVOICE_BUCKET = 'invoices';
const MAX_PDF_BYTES = 15 * 1024 * 1024;
type InvoiceRow = {
  id: string;
  creator_id: string;
  assigned_im: string | null;
  invoice_file_path?: string | null;
  invoice_file_url?: string | null;
};

function canAccessInvoice(user: UserProfile, invoice: InvoiceRow): boolean {
  if (user.role === 'accounts' || user.role === 'auditor') return true;
  if (user.role === 'creator' && invoice.creator_id === user.id) return true;
  if (
    user.role === 'im' &&
    invoice.assigned_im &&
    user.im_member_name &&
    invoice.assigned_im === user.im_member_name
  ) {
    return true;
  }
  return false;
}

/**
 * `invoice_file_url` may hold a raw object path or a legacy public object URL.
 * Falls back to `invoice_file_path` when `invoice_file_url` is empty (current uploads).
 */
function resolveStoragePathFromInvoiceFileUrl(
  invoice: InvoiceRow,
): string | null {
  const stored =
    optionalText(invoice.invoice_file_url) ?? optionalText(invoice.invoice_file_path);
  if (!stored) return null;

  if (!stored.startsWith('http://') && !stored.startsWith('https://')) {
    return stored;
  }

  try {
    const u = new URL(stored);
    const segments = u.pathname.split('/').filter(Boolean);
    const bucketIdx = segments.indexOf(INVOICE_BUCKET);
    if (bucketIdx >= 0 && bucketIdx < segments.length - 1) {
      return decodeURIComponent(segments.slice(bucketIdx + 1).join('/'));
    }
  } catch {
    /* fall through */
  }

  return `${invoice.creator_id}/${invoice.id}.pdf`;
}

async function storageObjectExists(path: string): Promise<boolean> {
  const lastSlash = path.lastIndexOf('/');
  const folder = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

  const { data: items, error } = await supabaseAdmin.storage
    .from(INVOICE_BUCKET)
    .list(folder, { limit: 10000 });

  if (error || !items) return false;
  return items.some((o) => o.name === fileName);
}

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES },
  fileFilter: (_req, file, cb) => {
    const looksPdf =
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/x-pdf' ||
      /\.pdf$/i.test(file.originalname);
    if (looksPdf) cb(null, true);
    else cb(new Error('Only PDF uploads are allowed'));
  },
});

const invoiceMultipartParser = pdfUpload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'invoiceFile', maxCount: 1 },
  { name: 'invoice_pdf', maxCount: 1 },
]);

function optionalText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function parseAmount(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseGst(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  return false;
}

function parseNonNegativeNumber(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function fetchInvoiceByIdOrNumber(identifier: string): Promise<{
  invoice: any | null;
  error: { message: string } | null;
}> {
  // 1) Try UUID/primary key match
  const first = await supabaseAdmin.from('invoices').select('*').eq('id', identifier).maybeSingle();
  if (first.data) return { invoice: first.data, error: null };
  if (first.error && first.error.code !== 'PGRST116') {
    return { invoice: null, error: { message: first.error.message } };
  }

  // 2) Fallback to invoice_number match
  const second = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('invoice_number', identifier)
    .maybeSingle();
  if (second.data) return { invoice: second.data, error: null };
  if (second.error && second.error.code !== 'PGRST116') {
    return { invoice: null, error: { message: second.error.message } };
  }

  return { invoice: null, error: null };
}

/** Applies optional invoice field updates from the body when a creator resubmits after rejection. */
function applyCreatorResubmitFieldUpdates(
  body: Record<string, unknown>,
  updateData: Record<string, unknown>,
): { error?: string } {
  if ('campaign' in body) {
    const c = optionalText(body.campaign);
    if (c) updateData.campaign = c;
  }
  if ('amount' in body) {
    const a = parseAmount(body.amount);
    if (a == null) return { error: 'Invalid amount' };
    updateData.amount = a;
  }
  if ('gst' in body) {
    updateData.gst = parseGst(body.gst);
  }
  if ('assigned_im' in body || 'assignedIm' in body) {
    const im = optionalText(body.assigned_im ?? body.assignedIm);
    if (im) updateData.assigned_im = im;
  }
  if ('account_no' in body || 'accountNo' in body) {
    updateData.account_no = optionalText(body.account_no ?? body.accountNo);
  }
  if ('ifsc' in body || 'ifsc_code' in body || 'ifscCode' in body) {
    updateData.ifsc = optionalText(body.ifsc ?? body.ifsc_code ?? body.ifscCode);
  }
  if ('account_holder_name' in body || 'accountHolderName' in body) {
    updateData.account_holder_name = optionalText(
      body.account_holder_name ?? body.accountHolderName,
    );
  }
  if ('pan_number' in body || 'panNumber' in body) {
    updateData.pan_number = optionalText(body.pan_number ?? body.panNumber);
  }
  if ('gst_number' in body || 'gstNumber' in body) {
    updateData.gst_number = optionalText(body.gst_number ?? body.gstNumber);
  }

  const bank = body.bank_details;
  if (bank && typeof bank === 'object' && !Array.isArray(bank)) {
    const b = bank as Record<string, unknown>;
    if ('account_no' in b || 'accountNo' in b) {
      updateData.account_no = optionalText(b.account_no ?? b.accountNo);
    }
    if ('ifsc' in b || 'ifsc_code' in b || 'ifscCode' in b) {
      updateData.ifsc = optionalText(b.ifsc ?? b.ifsc_code ?? b.ifscCode);
    }
    if ('account_holder_name' in b || 'accountHolderName' in b) {
      updateData.account_holder_name = optionalText(
        b.account_holder_name ?? b.accountHolderName,
      );
    }
  }

  return {};
}

function getUploadedPdf(req: AuthenticatedRequest): Express.Multer.File | undefined {
  const raw = req.files;
  if (!raw || Array.isArray(raw)) return undefined;
  const files = raw as Record<string, Express.Multer.File[] | undefined>;
  return files.file?.[0] ?? files.invoiceFile?.[0] ?? files.invoice_pdf?.[0];
}

function parseMultipartIfNeeded(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('multipart/form-data')) {
      resolve();
      return;
    }
    invoiceMultipartParser(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// GET /api/invoices - List invoices based on role
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    let query = supabaseAdmin.from('invoices').select('*');

    if (user.role === 'creator') {
      query = query.eq('creator_id', user.id);
    } else if (user.role === 'im') {
      query = query.eq('assigned_im', user.im_member_name);
    }
    // accounts role sees all invoices

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const normalized = (data ?? []).map((row: any) => {
      if (!row || typeof row !== 'object') return row;

      // Expected new shape: { id: uuid, invoice_number: 'INV-YYYY-NNNN', ... }
      if (typeof row.invoice_number === 'string' && uuidLike.test(String(row.id))) {
        return row;
      }

      // Back-compat for older/alternate shapes:
      // - id is display invoice number (INV-...), uuid lives in `uuid` or `invoice_id`
      // - OR id is uuid, display lives in `invoice_number` already
      const candidateUuid =
        typeof row.uuid === 'string'
          ? row.uuid
          : typeof row.invoice_id === 'string'
            ? row.invoice_id
            : typeof row.invoice_uuid === 'string'
              ? row.invoice_uuid
              : null;

      if (typeof row.id === 'string' && /^INV-\d{4}-\d{4,}$/.test(row.id) && candidateUuid) {
        return {
          ...row,
          id: candidateUuid,
          invoice_number: row.id,
        };
      }

      // If we have a uuid id but no invoice_number column, expose the existing `id` as-is
      // and leave invoice_number undefined (caller can handle it).
      return row;
    });

    res.json(normalized);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// GET /api/invoices/:id/file-url — signed URL (1h) for private bucket; body: { signed_url }
router.get('/:id/file-url', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const invoiceId = req.params.id;

    const { data: invoice, error } = await supabaseAdmin
      .from('invoices')
      .select(
        'id, creator_id, assigned_im, invoice_file_path, invoice_file_url',
      )
      .eq('id', invoiceId)
      .single();

    if (error || !invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const row = invoice as InvoiceRow;
    if (!canAccessInvoice(user, row)) {
      res.status(403).json({ error: 'You do not have access to this invoice file' });
      return;
    }

    const storagePath = resolveStoragePathFromInvoiceFileUrl(row);
    if (!storagePath) {
      res.status(404).json({ error: 'Invoice file not found' });
      return;
    }

    const exists = await storageObjectExists(storagePath);
    if (!exists) {
      res.status(404).json({ error: 'Invoice file not found' });
      return;
    }

    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from(INVOICE_BUCKET)
      .createSignedUrl(storagePath, 3600);

    if (signError || !signed?.signedUrl) {
      res.status(500).json({
        error: signError?.message || 'Failed to generate signed URL',
      });
      return;
    }

    res.json({ signed_url: signed.signedUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create download link' });
  }
});

// GET /api/invoices/:id - Get single invoice
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;

    const { invoice, error } = await fetchInvoiceByIdOrNumber(String(req.params.id));
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const row = invoice as InvoiceRow;
    if (!canAccessInvoice(user, row)) {
      res.status(403).json({ error: 'You do not have access to this invoice' });
      return;
    }

    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST /api/invoices - Create new invoice (creator only)
// Supports application/json or multipart/form-data (PDF field: "invoice_pdf", "file", or "invoiceFile")
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await parseMultipartIfNeeded(req, res);

    const user = req.user!;

    if (user.role !== 'creator') {
      res.status(403).json({ error: 'Only creators can submit invoices' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const pdfFile = getUploadedPdf(req);
    const hasPdf = Boolean(pdfFile?.buffer?.length);

    const campaign = optionalText(body.campaign);
    const amount = parseAmount(body.amount);
    const assigned_im = optionalText(body.assigned_im ?? body.assignedIm);
    let account_no = optionalText(body.account_no ?? body.accountNo);
    let ifsc = optionalText(body.ifsc ?? body.ifsc_code ?? body.ifscCode);
    let account_holder_name = optionalText(body.accountHolderName ?? body.account_holder_name);
    let pan_number = optionalText(body.panNumber ?? body.pan_number);

    // Optional nested bank details payload (frontend autofill use case)
    const bank = body.bank_details;
    if (bank && typeof bank === 'object' && !Array.isArray(bank)) {
      const b = bank as Record<string, unknown>;
      account_no = account_no ?? optionalText(b.account_no ?? b.accountNo);
      ifsc = ifsc ?? optionalText(b.ifsc ?? b.ifsc_code ?? b.ifscCode);
      account_holder_name =
        account_holder_name ?? optionalText(b.account_holder_name ?? b.accountHolderName);
      pan_number = pan_number ?? optionalText(b.pan_number ?? b.panNumber);
    }
    const gst_number = optionalText(body.gstNumber ?? body.gst_number);
    const gst = parseGst(body.gst);
    const commission_rate = parseNonNegativeNumber(body.commission_rate ?? body.commissionRate);
    const commission_amount = Math.max(
      0,
      parseAmount(body.commission_amount ?? body.commissionAmount) ?? 0,
    );

    if (!campaign || amount == null || !assigned_im) {
      res.status(400).json({
        error: 'Missing required fields: campaign, amount, assigned_im',
      });
      return;
    }

    if (!hasPdf && (!account_no || !ifsc)) {
      res.status(400).json({
        error:
          'Missing required fields: account_no, ifsc (or upload a PDF invoice so banking/tax fields are optional)',
      });
      return;
    }

    // Generate invoice ID: INV-{year}-{padded_number}
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;

    const { data: lastInvoice } = await supabaseAdmin
      .from('invoices')
      .select('id')
      .like('id', `${prefix}%`)
      .order('id', { ascending: false })
      .limit(1);

    let nextNumber = 1;
    if (lastInvoice && lastInvoice.length > 0) {
      const lastId = lastInvoice[0].id;
      const lastNumber = parseInt(lastId.replace(prefix, ''), 10);
      nextNumber = lastNumber + 1;
    }

    const invoiceId = `${prefix}${String(nextNumber).padStart(4, '0')}`;

    let invoice_file_path: string | null = null;

    if (hasPdf && pdfFile) {
      const storagePath = `${user.id}/${invoiceId}.pdf`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from(INVOICE_BUCKET)
        .upload(storagePath, pdfFile.buffer, {
          contentType: 'application/pdf',
          upsert: false,
        });

      if (uploadError) {
        res.status(500).json({ error: uploadError.message });
        return;
      }

      invoice_file_path = storagePath;
    }

    const { data: invoice, error } = await supabaseAdmin
      .from('invoices')
      .insert({
        id: invoiceId,
        creator_id: user.id,
        creator_name: user.name,
        campaign,
        amount,
        gst,
        account_no: account_no ?? null,
        ifsc: ifsc ?? null,
        assigned_im,
        account_holder_name: account_holder_name ?? null,
        pan_number: pan_number ?? null,
        gst_number: gst_number ?? null,
        commission_rate,
        commission_amount,
        invoice_file_path: invoice_file_path,
        invoice_file_url: invoice_file_path,
        status: 'submitted',
      })
      .select()
      .single();

    if (error) {
      if (hasPdf && invoice_file_path) {
        await supabaseAdmin.storage.from(INVOICE_BUCKET).remove([invoice_file_path]);
      }
      res.status(500).json({ error: error.message });
      return;
    }

    await supabaseAdmin.from('audit_log').insert({
      invoice_id: invoiceId,
      action: 'Submitted',
      done_by: user.name,
    });

    res.status(201).json(invoice);
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'PDF exceeds maximum allowed size' });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message === 'Only PDF uploads are allowed') {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// PATCH /api/invoices/:id/status - Update invoice status
router.patch('/:id/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const invoiceIdentifier = String(req.params.id);
    const {
      status,
      rejection_note,
      note,
      tds_deducted,
      tds_amount,
      final_payable_amount,
      amount,
    } = req.body;

    if (!status) {
      res.status(400).json({ error: 'Status is required' });
      return;
    }

    // Fetch current invoice
    const { invoice, error: fetchError } = await fetchInvoiceByIdOrNumber(invoiceIdentifier);
    if (fetchError) {
      res.status(500).json({ error: fetchError.message });
      return;
    }

    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const invoiceId = String((invoice as any).id);

    // Role-based status transition checks
    if (user.role === 'im') {
      if (invoice.assigned_im !== user.im_member_name) {
        res.status(403).json({ error: 'This invoice is not assigned to you' });
        return;
      }

      const allowedStatuses = ['im_review', 'im_approved', 'rejected', 'audit_cleared'];
      if (!allowedStatuses.includes(status)) {
        res.status(403).json({ error: `IM can only set status to: ${allowedStatuses.join(', ')}` });
        return;
      }

      if (status === 'audit_cleared') {
        if (invoice.status !== 'payer_rejected_im') {
          res.status(400).json({
            error:
              'IM can only set audit cleared when the invoice was returned by payer for IM correction (payer_rejected_im)',
          });
          return;
        }
      }
    } else if (user.role === 'accounts' || user.role === 'auditor') {
      const accountsAllowedStatuses = [
        'audit_cleared',
        'audit_rejected',
        'released',
        'partially_paid',
        'payer_rejected_audit',
        'payer_rejected_im',
      ] as const;
      if (!accountsAllowedStatuses.includes(status)) {
        res.status(403).json({
          error: `You can only set status to: ${accountsAllowedStatuses.join(', ')}`,
        });
        return;
      }

      if (
        status === 'released' ||
        status === 'payer_rejected_audit' ||
        status === 'payer_rejected_im'
      ) {
        const canReleaseFrom = invoice.status === 'audit_cleared' || invoice.status === 'partially_paid';
        if (status === 'released' ? !canReleaseFrom : invoice.status !== 'audit_cleared') {
          if (status === 'released') {
            res.status(400).json({
              error: 'Can only release invoices that are audit cleared or partially paid',
            });
          } else {
            res.status(400).json({
              error: 'Payer rejection is only allowed when the invoice is audit cleared',
            });
          }
          return;
        }
      } else if (status === 'audit_cleared' || status === 'audit_rejected') {
        const canAudit =
          invoice.status === 'im_approved' || invoice.status === 'payer_rejected_audit';
        if (!canAudit) {
          res.status(400).json({
            error:
              'Audit clear or reject is only allowed when the invoice is IM-approved or returned by payer audit (payer_rejected_audit)',
          });
          return;
        }
      }
    } else if (user.role === 'creator') {
      if (invoice.creator_id !== user.id) {
        res.status(403).json({ error: 'You do not have access to this invoice' });
        return;
      }

      const creatorAllowedStatuses = ['submitted'] as const;
      if (!creatorAllowedStatuses.includes(status)) {
        res.status(403).json({
          error: `Creators can only set status to: ${creatorAllowedStatuses.join(', ')}`,
        });
        return;
      }

      if (invoice.status !== 'rejected') {
        res.status(400).json({
          error: 'Creators can only resubmit (set to submitted) when the invoice is rejected',
        });
        return;
      }
    } else {
      res.status(403).json({ error: 'You do not have permission to change invoice status' });
      return;
    }

    // Build update payload
    const updateData: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };

    // If a new base amount is provided, always recompute derived accounting fields
    // server-side to avoid stale/incorrect totals.
    if ('amount' in (req.body as Record<string, unknown>)) {
      const nextAmount = parseAmount((req.body as Record<string, unknown>).amount);
      if (nextAmount == null) {
        res.status(400).json({ error: 'Invalid amount' });
        return;
      }

      updateData.amount = nextAmount;

      const tdsEnabled =
        typeof tds_deducted === 'boolean'
          ? tds_deducted
          : (invoice as any).tds_deducted === true;

      // Prefer a persisted explicit gst_amount if present; otherwise infer from boolean gst.
      const existingGstAmountRaw = (invoice as any).gst_amount;
      const existingGstAmount =
        typeof existingGstAmountRaw === 'number' && Number.isFinite(existingGstAmountRaw)
          ? existingGstAmountRaw
          : null;

      const gstEnabled = (invoice as any).gst === true;
      const gstAmount = existingGstAmount ?? (gstEnabled ? nextAmount * 0.18 : 0);

      const computedTdsAmount = tdsEnabled ? nextAmount * 0.01 : 0;
      const computedFinalPayable = nextAmount + gstAmount - computedTdsAmount;

      updateData.tds_amount = computedTdsAmount;
      updateData.final_payable_amount = computedFinalPayable;
    }

    if (
      (status === 'rejected' ||
        status === 'audit_rejected' ||
        status === 'payer_rejected_audit' ||
        status === 'payer_rejected_im') &&
      rejection_note
    ) {
      updateData.rejection_note = rejection_note;
    }

    if (status === 'audit_cleared') {
      updateData.rejection_note = null;
      if (user.role === 'accounts' || user.role === 'auditor') {
        updateData.tds_deducted = tds_deducted;
        // Keep accepting these fields for backward compatibility, but if `amount` was provided
        // the computed values above win (accounting accuracy).
        if (!('amount' in (req.body as Record<string, unknown>))) {
          updateData.tds_amount = tds_amount;
          updateData.final_payable_amount = final_payable_amount;
        }
      }
      if (user.role === 'im' && typeof amount === 'number' && Number.isFinite(amount)) {
        updateData.amount = amount;
      }
    }

    if (
      user.role === 'creator' &&
      status === 'submitted' &&
      invoice.status === 'rejected' &&
      invoice.creator_id === user.id
    ) {
      updateData.rejection_note = null;
      const body = req.body as Record<string, unknown>;
      const fieldErr = applyCreatorResubmitFieldUpdates(body, updateData);
      if (fieldErr.error) {
        res.status(400).json({ error: fieldErr.error });
        return;
      }
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('invoices')
      .update(updateData)
      .eq('id', invoiceId)
      .select()
      .single();

    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    // Build audit action text
    const actionMap: Record<string, string> = {
      submitted: 'Resubmitted after rejection',
      im_review: 'Marked as IM Review',
      im_approved: 'IM Approved',
      rejected: 'Rejected',
      audit_cleared: 'Audit Cleared',
      audit_rejected: 'Audit Rejected',
      released: 'Payment Released',
      payer_rejected_audit: 'Payer Rejected (Audit)',
      payer_rejected_im: 'Payer Rejected (IM)',
    };

    await supabaseAdmin.from('audit_log').insert({
      invoice_id: invoiceId,
      action: actionMap[status] || `Status changed to ${status}`,
      done_by: user.name,
      note: rejection_note || note || null,
    });

    if (status === 'audit_cleared' && updated) {
      try {
        void appendInvoiceToSheet(updated as Record<string, unknown>).catch((err: unknown) => {
          console.error('[googleSheets] appendInvoiceToSheet failed:', err);
        });
      } catch (err) {
        console.error('[googleSheets] appendInvoiceToSheet failed (sync):', err);
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update invoice status' });
  }
});

async function releasePaymentController(req: AuthenticatedRequest, res: Response) {
  try {
    const user = req.user!;
    if (user.role !== 'accounts' && user.role !== 'auditor') {
      res.status(403).json({ error: 'You do not have permission to release payments' });
      return;
    }

    const invoiceIdentifier = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const amountReleased = parseAmount(body.amount_released ?? body.amountReleased);
    const reason = optionalText(body.reason);
    const note = optionalText(body.note);

    if (amountReleased == null || amountReleased <= 0) {
      res.status(400).json({ error: 'amount_released must be a positive number' });
      return;
    }
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }

    const { invoice, error: fetchError } = await fetchInvoiceByIdOrNumber(invoiceIdentifier);
    if (fetchError) {
      res.status(500).json({ error: fetchError.message });
      return;
    }
    if (!invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const invoiceId = String((invoice as any).id);
    const currentStatus = String((invoice as any).status ?? '');
    if (currentStatus !== 'audit_cleared' && currentStatus !== 'partially_paid') {
      res.status(400).json({
        error: 'Can only release payments for invoices that are audit cleared or partially paid',
      });
      return;
    }

    const finalPayableRaw = (invoice as any).final_payable_amount;
    const finalPayable =
      typeof finalPayableRaw === 'number'
        ? finalPayableRaw
        : typeof finalPayableRaw === 'string'
          ? Number(finalPayableRaw)
          : NaN;
    if (!Number.isFinite(finalPayable) || finalPayable <= 0) {
      res.status(400).json({ error: 'final_payable_amount is missing or invalid on this invoice' });
      return;
    }

    const amountPaidRaw = (invoice as any).amount_paid;
    const currentPaid =
      typeof amountPaidRaw === 'number'
        ? amountPaidRaw
        : typeof amountPaidRaw === 'string'
          ? Number(amountPaidRaw)
          : 0;
    if (!Number.isFinite(currentPaid) || currentPaid < 0) {
      res.status(400).json({ error: 'amount_paid is invalid on this invoice' });
      return;
    }

    const nextPaid = currentPaid + amountReleased;

    const history = Array.isArray((invoice as any).payment_history)
      ? ((invoice as any).payment_history as unknown[])
      : [];
    const entry = {
      date: new Date().toISOString(),
      amount: amountReleased,
      reason,
      note: note ?? null,
      sender: 'payer' as const,
    };
    const nextHistory = [...history, entry];

    const nextStatus = nextPaid >= finalPayable ? 'released' : 'partially_paid';

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('invoices')
      .update({
        amount_paid: nextPaid,
        payment_history: nextHistory,
        status: nextStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', invoiceId)
      .select()
      .single();

    if (updateError || !updated) {
      res.status(500).json({ error: updateError?.message || 'Failed to update invoice' });
      return;
    }

    await supabaseAdmin.from('audit_log').insert({
      invoice_id: invoiceId,
      action: nextStatus === 'released' ? 'Payment Released' : 'Partial Payment Released',
      done_by: user.name,
      note: `${reason}${note ? ` — ${note}` : ''}`,
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to release payment' });
  }
}

// PATCH /api/invoices/:id/release - Release (partial/full) payment (accounts/auditor only)
router.patch('/:id/release', releasePaymentController);

// POST /api/invoices/:id/release - Release (partial/full) payment (accounts/auditor only)
router.post('/:id/release', releasePaymentController);

// PATCH /api/invoices/:id/reminder - Send reminder (creator only)
router.patch('/:id/reminder', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const invoiceIdentifier = String(req.params.id);

    if (user.role !== 'creator') {
      res.status(403).json({ error: 'Only creators can send reminders' });
      return;
    }

    // Verify the invoice exists and belongs to the creator
    const { invoice, error: fetchError } = await fetchInvoiceByIdOrNumber(invoiceIdentifier);
    if (fetchError) {
      res.status(500).json({ error: fetchError.message });
      return;
    }

    if (!invoice || invoice.creator_id !== user.id) {
      res.status(404).json({ error: 'Invoice not found or not yours' });
      return;
    }

    const invoiceId = String((invoice as any).id);

    // Check last reminder via audit_log
    const { data: lastReminder } = await supabaseAdmin
      .from('audit_log')
      .select('created_at')
      .eq('invoice_id', invoiceId)
      .eq('action', 'Reminder sent')
      .order('created_at', { ascending: false })
      .limit(1);

    if (lastReminder && lastReminder.length > 0) {
      const lastSent = new Date(lastReminder[0].created_at);
      const hoursSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        res.status(429).json({ error: 'Reminder already sent within the last 24 hours' });
        return;
      }
    }

    // Insert audit entry for reminder
    await supabaseAdmin.from('audit_log').insert({
      invoice_id: invoiceId,
      action: 'Reminder sent',
      done_by: user.name,
    });

    res.json({ message: 'Reminder sent successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

export default router;
