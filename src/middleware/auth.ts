import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: 'creator' | 'im' | 'accounts';
  im_member_name: string | null;
}

export interface AuthenticatedRequest extends Request {
  user?: UserProfile;
}

const JWT_SECRET = process.env.JWT_SECRET || 'invoflow-secret-key-change-in-production';

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserProfile;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function generateToken(user: UserProfile): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
}
