import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/creators/last-payout - Most recent successful payout details for creator
router.get('/last-payout', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    if (user.role !== 'creator') {
      res.status(403).json({ error: 'Only creators can access last payout details' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('account_holder_name, account_no, ifsc, pan_number, updated_at, created_at, status')
      .eq('creator_id', user.id)
      .eq('status', 'released')
      .order('updated_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const last = data?.[0];
    if (!last) {
      res.json({
        account_holder_name: null,
        account_no: null,
        ifsc: null,
        pan_number: null,
      });
      return;
    }

    res.json({
      account_holder_name: last.account_holder_name ?? null,
      account_no: last.account_no ?? null,
      ifsc: last.ifsc ?? null,
      pan_number: last.pan_number ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch last payout details' });
  }
});

export default router;

