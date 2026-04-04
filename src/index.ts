import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth.js';
import authRouter from './routes/auth.js';
import healthRouter from './routes/health.js';
import invoicesRouter from './routes/invoices.js';
import auditRouter from './routes/audit.js';
import profilesRouter from './routes/profiles.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRouter);
app.use('/api/health', healthRouter);
app.use('/api/invoices', authMiddleware, invoicesRouter);
app.use('/api/audit', authMiddleware, auditRouter);
app.use('/api/profiles', profilesRouter);

// Start server
app.listen(PORT, () => {
  console.log(`InvoFlow server running on port ${PORT}`);
});
