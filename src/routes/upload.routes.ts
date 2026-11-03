import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { authenticate, AuthRequest } from '../middlewares/security.middleware';
import { getPublicServerUrl, recordUpload } from '../utils/uploadAccess';

const router = Router();

const baseUploadDir = path.join(__dirname, '../../uploads');

const AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

// Extension stored for each accepted type. SVG is excluded because it can carry scripts.
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/x-png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  // Some devices send no real type; the extension check still applies
  'application/octet-stream': '.png',
};

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp', '.pdf', ...AUDIO_EXTENSIONS];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const category = (req.query.category as string) || 'general';
    const subFolder = ['chats', 'companies', 'receipts', 'profiles', 'sounds', 'documents'].includes(category) ? category : 'general';
    const uploadDir = path.join(baseUploadDir, subFolder);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const randomPrefix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const originalExt = path.extname(file.originalname).toLowerCase();
    const category = (req.query.category as string) || '';
    let safeExt = ALLOWED_EXTENSIONS.includes(originalExt) ? originalExt : (MIME_EXTENSIONS[file.mimetype.toLowerCase()] || '.png');
    if (category === 'sounds') {
      safeExt = AUDIO_EXTENSIONS.includes(originalExt) ? originalExt : '.mp3';
    }
    const baseName = path.basename(file.originalname, originalExt).replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_');
    cb(null, `${randomPrefix}-${baseName || (category === 'sounds' ? 'sound' : 'file')}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB limit
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const category = (req.query.category as string) || '';
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();

    // إذا كان المجلد المستهدف هو قسم الصوتيات (sounds)، لا نقبل أي شيء غير الملفات الصوتية حصراً
    if (category === 'sounds') {
      const isAudio = AUDIO_MIME_TYPES.includes(mime) || AUDIO_EXTENSIONS.includes(ext) || mime.startsWith('audio/');
      if (isAudio && (AUDIO_EXTENSIONS.includes(ext) || ext === '.mp3')) {
        cb(null, true);
      } else {
        cb(new Error('الملف المرفوع غير صالح! قسم النغمات يقبل الملفات الصوتية (MP3, WAV, OGG, M4A) فقط ولا يقبل الصور أو المستندات.'));
      }
      return;
    }

    // Both must pass: a declared type alone cannot smuggle a file such as x.html
    const isAllowedMime = Boolean(MIME_EXTENSIONS[mime]);
    const isAllowedExt = ALLOWED_EXTENSIONS.includes(ext) || (!ext && mime !== 'application/octet-stream');

    if (isAllowedMime && isAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مدعوم، يُسمح بالصور و PDF والملفات الصوتية فقط'));
    }
  }
});

const uploadHandler = (req: any, res: any, next: any) => {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'خطأ في معالجة الملف' });
    }
    if (req.files && req.files.length > 0) {
      req.file = req.files[0];
    }
    next();
  });
};

router.post('/', authenticate, uploadHandler, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'لم يتم إرسال أي ملف' });
      return;
    }
    const category = (req.query.category as string) || 'general';
    const subFolder = ['chats', 'companies', 'receipts', 'profiles', 'sounds', 'documents'].includes(category) ? category : 'general';
    const filename = req.file.filename;

    await recordUpload(filename, subFolder, String(req.user!.id));

    const fileUrl = `${getPublicServerUrl(req)}/uploads/${subFolder}/${filename}`;

    res.status(201).json({ success: true, url: fileUrl, filename });
  } catch (error: any) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'فشل رفع الملف' });
  }
});

router.post('/base64', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { image, originalName } = req.body;
    if (!image || typeof image !== 'string') {
      res.status(400).json({ error: 'البيانات غير صالحة' });
      return;
    }

    // Size limit check on base64 payload (50MB chars limit ~ 35MB file)
    if (image.length > 50 * 1024 * 1024) {
      res.status(400).json({ error: 'حجم الملف يتجاوز الحد المسموح (35 ميجابايت)' });
      return;
    }

    const category = (req.query.category as string) || 'general';
    const subFolder = ['chats', 'companies', 'receipts', 'profiles', 'sounds', 'documents'].includes(category) ? category : 'general';
    const uploadDir = path.join(baseUploadDir, subFolder);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const matches = image.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      res.status(400).json({ error: 'صيغة الصورة غير صالحة' });
      return;
    }

    const mime = matches[1].toLowerCase();
    const ext = MIME_EXTENSIONS[mime];

    if (!ext) {
      res.status(400).json({ error: 'نوع الملف غير مدعوم، يُسمح بالصور و PDF فقط' });
      return;
    }

    const buffer = Buffer.from(matches[2], 'base64');

    if (buffer.length > 10 * 1024 * 1024) {
      res.status(400).json({ error: 'حجم الملف يتجاوز الحد المسموح (10 ميجابايت)' });
      return;
    }

    const randomPrefix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    // The stored extension always comes from the validated type, never from the client's file name
    const cleanName = typeof originalName === 'string' ? originalName : '';
    const safeBaseName = path.basename(cleanName, path.extname(cleanName)).replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_') || 'upload';
    const filename = `${randomPrefix}-${safeBaseName}${ext}`;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, buffer);
    await recordUpload(filename, subFolder, String(req.user!.id));

    const fileUrl = `${getPublicServerUrl(req)}/uploads/${subFolder}/${filename}`;

    res.status(201).json({ success: true, url: fileUrl });
  } catch (error: any) {
    console.error('Error uploading base64 image:', error);
    res.status(500).json({ error: 'فشل رفع الصورة' });
  }
});

export default router;
