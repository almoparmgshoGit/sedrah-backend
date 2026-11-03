import { Request } from 'express';
import { env } from '../config/env';
import { pool } from '../config/db';

export const UPLOAD_CATEGORIES = ['chats', 'companies', 'receipts', 'profiles', 'sounds', 'documents', 'general'];
export const SENSITIVE_UPLOAD_CATEGORIES = ['receipts', 'chats', 'profiles', 'documents'];
const STAFF_ROLES = ['admin', 'super_admin', 'support', 'moderator', 'owner'];

const UPLOAD_PATH = new RegExp(`^/uploads/(${UPLOAD_CATEGORIES.join('|')})/([^/\\\\?#]+)$`);

// Never derived from the Host header in production, so a forged header cannot redirect stored file links
export const getPublicServerUrl = (req: Request): string => {
  if (env.PUBLIC_SERVER_URL) return env.PUBLIC_SERVER_URL.replace(/\/+$/, '');
  if (env.NODE_ENV === 'production') return 'https://sedrah.tech';
  return `${req.protocol}://${req.get('host')}`;
};

const parseUploadPath = (raw: string): { category: string; filename: string } | null => {
  let pathname: string;
  try {
    pathname = decodeURI(new URL(raw, 'http://uploads.invalid').pathname);
  } catch {
    return null;
  }
  const match = pathname.match(UPLOAD_PATH);
  if (!match || match[2].startsWith('.') || match[2].includes(':')) return null;
  return { category: match[1], filename: match[2] };
};

/**
 * Client-supplied file links are rebuilt on our own server URL, so a foreign host can never be stored.
 * Returns null when empty and false when the value is not a link to an uploaded file.
 */
export const normalizeUploadUrl = (raw: unknown, req: Request): string | null | false => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return false;
  const parsed = parseUploadPath(raw.trim());
  if (!parsed) return false;
  return `${getPublicServerUrl(req)}/uploads/${parsed.category}/${parsed.filename}`;
};

/**
 * Same as normalizeUploadUrl, but the file must also belong to this user. Referencing a file grants
 * access to it, so users must not be able to attach files they did not upload.
 */
export const resolveUserUpload = async (
  raw: unknown,
  req: Request,
  userId: string,
  existingUrl?: string | null
): Promise<string | null | false> => {
  const url = normalizeUploadUrl(raw, req);
  if (!url) return url;

  const filename = parseUploadPath(url)!.filename;
  const existing = existingUrl ? parseUploadPath(existingUrl) : null;
  if (existing?.filename === filename) return url;

  const owned = await pool.query('SELECT 1 FROM uploaded_files WHERE filename = $1 AND user_id = $2', [filename, userId]);
  return owned.rows.length > 0 ? url : false;
};

export const recordUpload = async (filename: string, category: string, userId: string): Promise<void> => {
  await pool.query(
    'INSERT INTO uploaded_files (filename, category, user_id) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING',
    [filename, category, userId]
  );
};

// A sensitive file is readable by staff, its uploader, or the parties of the record that references it
export const canAccessUpload = async (userId: string, filename: string): Promise<boolean> => {
  const userRes = await pool.query('SELECT role, status FROM users WHERE id = $1', [userId]);
  const user = userRes.rows[0];
  if (!user || user.status === 'banned' || user.status === 'inactive') return false;
  if (STAFF_ROLES.includes(user.role)) return true;

  // Stored links may hold the raw or the URL-encoded file name
  const refs = [`/${filename}`, `/${encodeURIComponent(filename)}`];
  const refersTo = (column: string) => `(strpos(${column}, $3) > 0 OR strpos(${column}, $4) > 0)`;

  const result = await pool.query(
    `SELECT 1 WHERE
       EXISTS (SELECT 1 FROM uploaded_files WHERE filename = $2 AND user_id = $1)
       OR EXISTS (SELECT 1 FROM users WHERE id = $1 AND ${refersTo('avatar')})
       OR EXISTS (
         SELECT 1 FROM bookings b
         LEFT JOIN packages p ON b.package_id = p.id
         LEFT JOIN companies co ON p.company_id = co.id
         LEFT JOIN documents d ON d.booking_id = b.id
         LEFT JOIN trip_stages ts ON ts.booking_id = b.id
         WHERE (b.user_id = $1 OR co.user_id = $1)
           AND (${refersTo('b.receipt_url')} OR ${refersTo('d.file_url')} OR ${refersTo('ts.document_url')} OR ${refersTo('ts.details')})
       )
       OR EXISTS (
         SELECT 1 FROM chats c
         LEFT JOIN companies co ON c.company_id = co.id
         LEFT JOIN messages m ON m.chat_id = c.id
         WHERE (c.user_id = $1 OR co.user_id = $1)
           AND (${refersTo('c.attachment_url')} OR ${refersTo('m.image_uri')})
       )`,
    [userId, filename, refs[0], refs[1]]
  );
  return result.rows.length > 0;
};
