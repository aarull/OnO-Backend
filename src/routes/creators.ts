import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// POST /api/creators/register — Supabase Auth + public.user_roles (no JWT required)
router.post('/register', async (req: Request, res: Response) => {
  try {
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

    // Strict service-role admin client (bypass RLS and standard auth restrictions)
    const localAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data, error: signUpError } = await localAdmin.auth.admin.createUser({
      email: emailNorm,
      password,
      user_metadata: { full_name: nameTrimmed },
      email_confirm: true,
    });

    if (signUpError) {
      console.error('creator register createUser error:', signUpError);
      res.status(400).json({ error: signUpError.message });
      return;
    }
    if (!data?.user?.id) {
      // Extremely defensive: Supabase returned no error but also no user.
      res.status(500).json({ error: 'Internal Server Error' });
      return;
    }

    const userId = data.user.id;

    const { error: roleError } = await localAdmin
      .from('user_roles')
      .insert([{ user_id: userId, email: emailNorm, role: 'creator' }]);

    if (roleError) {
      console.error('creator register user_roles insert error:', roleError);
      // Best-effort rollback to avoid orphaned auth users
      try {
        await localAdmin.auth.admin.deleteUser(userId);
      } catch (rollbackErr) {
        console.error('creator register rollback deleteUser error:', rollbackErr);
      }
      res.status(400).json({ error: roleError.message });
      return;
    }

    res.status(201).json({
      message: 'Creator registered successfully',
      user: { id: userId, email: emailNorm, fullName: nameTrimmed },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : undefined;
    res.status(500).json({ error: msg || 'Internal Server Error' });
  }
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

