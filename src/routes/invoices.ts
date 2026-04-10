import { Router, Response } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../lib/supabase.js';
import { AuthenticatedRequest, UserProfile } from '../middleware/auth.js';

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
  if (user.role === 'accounts') return true;
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

    res.json(data);
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

    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    const invoice = data as InvoiceRow;
    if (!canAccessInvoice(user, invoice)) {
      res.status(403).json({ error: 'You do not have access to this invoice' });
      return;
    }

    res.json(data);
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
    const account_no = optionalText(body.account_no ?? body.accountNo);
    const ifsc = optionalText(body.ifsc);
    const account_holder_name = optionalText(
      body.accountHolderName ?? body.account_holder_name,
    );
    const pan_number = optionalText(body.panNumber ?? body.pan_number);
    const gst_number = optionalText(body.gstNumber ?? body.gst_number);
    const gst = parseGst(body.gst);

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
    const invoiceId = req.params.id;
    const { status, rejection_note, note } = req.body;

    if (!status) {
      res.status(400).json({ error: 'Status is required' });
      return;
    }

    // Fetch current invoice
    const { data: invoice, error: fetchError } = await supabaseAdmin
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();

    if (fetchError || !invoice) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    // Role-based status transition checks
    if (user.role === 'im') {
      if (invoice.assigned_im !== user.im_member_name) {
        res.status(403).json({ error: 'This invoice is not assigned to you' });
        return;
      }

      const allowedStatuses = ['im_review', 'im_approved', 'rejected'];
      if (!allowedStatuses.includes(status)) {
        res.status(403).json({ error: `IM can only set status to: ${allowedStatuses.join(', ')}` });
        return;
      }
    } else if (user.role === 'accounts') {
      const accountsAllowedStatuses = ['audit_cleared', 'audit_rejected', 'released'] as const;
      if (!accountsAllowedStatuses.includes(status)) {
        res.status(403).json({
          error: `Accounts can only set status to: ${accountsAllowedStatuses.join(', ')}`,
        });
        return;
      }

      if (status === 'released') {
        if (invoice.status !== 'audit_cleared') {
          res.status(400).json({
            error: 'Can only release invoices that are audit cleared',
          });
          return;
        }
      } else if (status === 'audit_cleared' || status === 'audit_rejected') {
        if (invoice.status !== 'im_approved') {
          res.status(400).json({
            error: 'Audit actions are only allowed after IM approval',
          });
          return;
        }
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

    if ((status === 'rejected' || status === 'audit_rejected') && rejection_note) {
      updateData.rejection_note = rejection_note;
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
      im_review: 'Marked as IM Review',
      im_approved: 'IM Approved',
      rejected: 'Rejected',
      audit_cleared: 'Audit Cleared',
      audit_rejected: 'Audit Rejected',
      released: 'Payment Released',
    };

    await supabaseAdmin.from('audit_log').insert({
      invoice_id: invoiceId,
      action: actionMap[status] || `Status changed to ${status}`,
      done_by: user.name,
      note: rejection_note || note || null,
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update invoice status' });
  }
});

// PATCH /api/invoices/:id/reminder - Send reminder (creator only)
router.patch('/:id/reminder', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const invoiceId = req.params.id;

    if (user.role !== 'creator') {
      res.status(403).json({ error: 'Only creators can send reminders' });
      return;
    }

    // Verify the invoice exists and belongs to the creator
    const { data: invoice, error: fetchError } = await supabaseAdmin
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('creator_id', user.id)
      .single();

    if (fetchError || !invoice) {
      res.status(404).json({ error: 'Invoice not found or not yours' });
      return;
    }

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
