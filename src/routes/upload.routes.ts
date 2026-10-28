import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { authenticate, AuthRequest } from '../middlewares/security.middleware';

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

const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/x-png',
  'image/pjpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
];

const ALLOWED_MIME_TYPES = [
  ...IMAGE_MIME_TYPES,
  'application/pdf',
  'application/octet-stream',
  ...AUDIO_MIME_TYPES,
];

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.bmp', '.svg', '.pdf', ...AUDIO_EXTENSIONS];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const category = (req.query.category as string) || 'general';
    const subFolder = ['chats', 'companies', 'receipts', 'profiles', 'sounds'].includes(category) ? category : 'general';
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
    let safeExt = (originalExt && originalExt.length < 10) ? originalExt : '.png';
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

    const isImage = mime.startsWith('image/') || IMAGE_MIME_TYPES.includes(mime) || ALLOWED_EXTENSIONS.includes(ext);
    const isPdf = mime.includes('pdf') || ext === '.pdf';
    const isAllowed = isImage || isPdf || ALLOWED_MIME_TYPES.includes(mime) || ALLOWED_EXTENSIONS.includes(ext) || mime === 'application/octet-stream';

    if (isAllowed) {
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

router.post('/', authenticate, uploadHandler, (req: AuthRequest, res: Response): void => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'لم يتم إرسال أي ملف' });
      return;
    }
    const category = (req.query.category as string) || 'general';
    const subFolder = ['chats', 'companies', 'receipts', 'profiles', 'sounds'].includes(category) ? category : 'general';
    const filename = req.file.filename;

    const host = req.get('host') || `${req.hostname || 'localhost'}:${process.env.PORT || 5000}`;
    const protocol = req.protocol || 'http';
    const fileUrl = `${protocol}://${host}/uploads/${subFolder}/${filename}`;

    res.status(201).json({ success: true, url: fileUrl, filename });
  } catch (error: any) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: error.message || 'فشل رفع الملف' });
  }
});

router.post('/base64', authenticate, (req: AuthRequest, res: Response): void => {
  try {
    const { image, originalName } = req.body;
    if (!image || typeof image !== 'string') {
      res.status(400).json({ error: 'البيانات غير صالحة' });
      return;
    }

    // Size limit check on base64 payload (15MB chars limit ~ 11MB file)
    if (image.length > 15 * 1024 * 1024) {
      res.status(400).json({ error: 'حجم الملف يتجاوز الحد المسموح (10 ميجابايت)' });
      return;
    }

    const category = (req.query.category as string) || 'general';
    const subFolder = ['chats', 'companies', 'receipts', 'profiles', 'sounds'].includes(category) ? category : 'general';
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
    const isImage = mime.startsWith('image/') || IMAGE_MIME_TYPES.includes(mime);
    const isPdf = mime.includes('pdf');

    if (!isImage && !isPdf && !ALLOWED_MIME_TYPES.includes(mime)) {
      res.status(400).json({ error: 'نوع الملف غير مدعوم، يُسمح بالصور و PDF فقط' });
      return;
    }

    let ext = 'png';
    if (mime.includes('pdf')) ext = 'pdf';
    else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
    else if (mime.includes('png')) ext = 'png';
    else if (mime.includes('webp')) ext = 'webp';
    else if (mime.includes('gif')) ext = 'gif';
    else if (mime.includes('svg')) ext = 'svg';
    const buffer = Buffer.from(matches[2], 'base64');

    if (buffer.length > 10 * 1024 * 1024) {
      res.status(400).json({ error: 'حجم الملف يتجاوز الحد المسموح (10 ميجابايت)' });
      return;
    }

    const randomPrefix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safeBaseName = originalName ? path.basename(originalName).replace(/[^a-zA-Z0-9_\u0600-\u06FF.-]/g, '_') : `upload.${ext}`;
    const filename = `${randomPrefix}-${safeBaseName}`;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, buffer);

    const host = req.get('host') || `${req.hostname || 'localhost'}:${process.env.PORT || 5000}`;
    const protocol = req.protocol || 'http';
    const fileUrl = `${protocol}://${host}/uploads/${subFolder}/${filename}`;

    res.status(201).json({ success: true, url: fileUrl });
  } catch (error: any) {
    console.error('Error uploading base64 image:', error);
    res.status(500).json({ error: 'فشل رفع الصورة' });
  }
});

export default router;
