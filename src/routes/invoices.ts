import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

function optionalText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
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

// GET /api/invoices/:id - Get single invoice
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) {
      res.status(404).json({ error: 'Invoice not found' });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST /api/invoices - Create new invoice (creator only)
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;

    if (user.role !== 'creator') {
      res.status(403).json({ error: 'Only creators can submit invoices' });
      return;
    }

    const { campaign, amount, gst, account_no, ifsc, assigned_im } = req.body;

    const account_holder_name = optionalText(
      req.body.accountHolderName ?? req.body.account_holder_name,
    );
    const pan_number = optionalText(req.body.panNumber ?? req.body.pan_number);
    const gst_number = optionalText(req.body.gstNumber ?? req.body.gst_number);

    if (!campaign || amount == null || !account_no || !ifsc || !assigned_im) {
      res.status(400).json({ error: 'Missing required fields: campaign, amount, account_no, ifsc, assigned_im' });
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

    const { data: invoice, error } = await supabaseAdmin
      .from('invoices')
      .insert({
        id: invoiceId,
        creator_id: user.id,
        creator_name: user.name,
        campaign,
        amount,
        gst: gst ?? false,
        account_no,
        ifsc,
        assigned_im,
        account_holder_name,
        pan_number,
        gst_number,
        status: 'submitted',
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    // Insert audit log entry
    await supabaseAdmin.from('audit_log').insert({
      invoice_id: invoiceId,
      action: 'Submitted',
      done_by: user.name,
    });

    res.status(201).json(invoice);
  } catch (err) {
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
      if (status !== 'released') {
        res.status(403).json({ error: 'Accounts can only set status to: released' });
        return;
      }

      if (invoice.status !== 'im_approved') {
        res.status(400).json({ error: 'Can only release invoices that are IM approved' });
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

    if (status === 'rejected' && rejection_note) {
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
