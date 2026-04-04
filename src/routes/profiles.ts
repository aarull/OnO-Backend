import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// GET /api/profiles/im-members - Public: list IM member names
router.get('/im-members', async (_req, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, name')
      .eq('role', 'im')
      .order('name');

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch IM members' });
  }
});

// GET /api/profiles/me - Protected: current user's profile
router.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(req.user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

export default router;
