import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const uploadsRoot = path.join(__dirname, '..', '..', 'data', 'uploads');

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadsRoot, req.workspaceId, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});
