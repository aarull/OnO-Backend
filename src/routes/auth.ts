import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '../lib/supabase.js';
import { generateToken, UserProfile } from '../middleware/auth.js';

const router = Router();

// POST /api/auth/signup
router.post('/signup', async (req: Request, res: Response) => {
  const { name, email, password, role, im_member_name } = req.body;

  // Validate
  if (!name || !email || !password || !role) {
    res.status(400).json({ error: 'Name, email, password, and role are required' });
    return;
  }
  if (!['creator', 'im', 'accounts'].includes(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  // Check if email already exists
  const { data: existing } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  if (existing) {
    res.status(400).json({ error: 'Email already registered' });
    return;
  }

  // Hash password
  const password_hash = await bcrypt.hash(password, 10);

  // Generate UUID
  const id = crypto.randomUUID();

  // Insert profile
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .insert({ id, name, email, password_hash, role, im_member_name: im_member_name || null })
    .select('id, name, email, role, im_member_name')
    .single();

  if (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account' });
    return;
  }

  const token = generateToken(profile as UserProfile);
  res.json({ token, user: profile });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('id, name, email, role, im_member_name, password_hash')
    .eq('email', email)
    .single();

  if (error || !profile) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const valid = await bcrypt.compare(password, profile.password_hash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const { password_hash, ...userProfile } = profile;
  const token = generateToken(userProfile as UserProfile);
  res.json({ token, user: userProfile });
});

export default router;
