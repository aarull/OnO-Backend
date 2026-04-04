import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Admin client for all database operations (bypasses RLS)
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
