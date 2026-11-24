import { z } from 'zod';

export const idSchema = z.string().uuid();
export const urlSchema = z.string().max(2048).refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Use an http:// or https:// URL without credentials.');
