import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/audit - List audit entries, optionally filtered by invoice_id
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    let query = supabaseAdmin.from('audit_log').select('*');

    const invoiceId = req.query.invoice_id as string | undefined;
    if (invoiceId) {
      query = query.eq('invoice_id', invoiceId);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// GET /api/audit/:invoiceId - Get audit entries for a specific invoice
router.get('/:invoiceId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('audit_log')
      .select('*')
      .eq('invoice_id', req.params.invoiceId)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

export default router;
