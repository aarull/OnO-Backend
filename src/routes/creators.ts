import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// POST /api/creators/register — Supabase Auth + public.user_roles (no JWT required)
router.post('/register', async (req: Request, res: Response) => {
  const { email, password, fullName } = req.body ?? {};

  if (!email || !password || !fullName) {
    res.status(400).json({ error: 'email, password, and fullName are required' });
    return;
  }
  if (typeof email !== 'string' || typeof password !== 'string' || typeof fullName !== 'string') {
    res.status(400).json({ error: 'email, password, and fullName must be strings' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  const emailNorm = email.trim().toLowerCase();
  const nameTrimmed = fullName.trim();
  if (!emailNorm || !nameTrimmed) {
    res.status(400).json({ error: 'email and fullName cannot be empty' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: emailNorm,
    password,
    email_confirm: true,
    user_metadata: { full_name: nameTrimmed },
  });

  if (error || !data?.user?.id) {
    const msg = error?.message ?? 'Failed to create user';
    const lower = msg.toLowerCase();
    const status =
      lower.includes('already') || lower.includes('registered') || lower.includes('exists') ? 409 : 400;
    res.status(status).json({ error: msg });
    return;
  }

  const userId = data.user.id;

  const { error: roleError } = await supabaseAdmin.from('user_roles').insert({
    user_id: userId,
    email: emailNorm,
    role: 'creator',
  });

  if (roleError) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    console.error('user_roles insert failed:', roleError);
    res.status(500).json({ error: roleError.message });
    return;
  }

  res.status(201).json({
    message: 'Creator registered successfully',
    user: { id: userId, email: emailNorm, fullName: nameTrimmed },
  });
});

// GET /api/creators/last-payout - Most recent successful payout details for creator
router.get('/last-payout', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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

