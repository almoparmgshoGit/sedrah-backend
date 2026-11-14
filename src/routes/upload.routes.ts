import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { authenticate, AuthRequest } from '../middlewares/security.middleware';
import { getPublicServerUrl, recordUpload } from '../utils/uploadAccess';
import { fitImageToPreset, getImagePreset, ResizeResult } from '../utils/imagePresets';

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

const STAFF_ROLES = ['admin', 'super_admin', 'support', 'moderator', 'owner'];

// Recognises a file by its first bytes, so a script or web page renamed to .jpg or .pdf is rejected
const detectFileKind = (head: Buffer): 'image' | 'pdf' | null => {
  const hex = head.subarray(0, 12).toString('hex');
  const ascii = head.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff')) return 'image'; // JPEG
  if (hex.startsWith('89504e470d0a1a0a')) return 'image'; // PNG
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image';
  if (ascii.startsWith('BM')) return 'image';
  if (ascii.slice(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heif|avif)/.test(ascii.slice(8, 12))) return 'image';
  if (ascii.startsWith('%PDF-')) return 'pdf';
  return null;
};

// Audio is checked by type and extension only; it is served with a sandbox policy and never executed
const isContentAllowed = (head: Buffer, mime: string, ext: string): boolean => {
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.includes(ext)) return true;
  const kind = detectFileKind(head);
  if (!kind) return false;
  return ext === '.pdf' ? kind === 'pdf' : kind === 'image';
};

const RESIZE_FAILED = 'تعذر ضبط مقاس الصورة، ارفعها بصيغة JPG أو PNG';

// Size fields every response carries when a preset was applied, so the app can tell the user
const sizeInfo = (result: ResizeResult | null) =>
  result
    ? { width: result.width, height: result.height, original_width: result.originalWidth, original_height: result.originalHeight, resized: result.resized }
    : {};

const isStaff = (req: any): boolean => STAFF_ROLES.includes(String(req.user?.role || ''));

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
      if (!isStaff(req)) {
        cb(new Error('غير مصرح برفع ملفات إلى هذا القسم'));
        return;
      }
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
    let filename = req.file.filename;

    // The declared type is only a claim; the stored bytes must really be that kind of file
    const fd = fs.openSync(req.file.path, 'r');
    const head = Buffer.alloc(16);
    try {
      fs.readSync(fd, head, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!isContentAllowed(head, String(req.file.mimetype || '').toLowerCase(), path.extname(filename).toLowerCase())) {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: 'محتوى الملف لا يطابق نوعه، يُسمح بالصور و PDF فقط' });
      return;
    }

    // ?preset= crops and resizes a display image to the exact size the customer app shows it at
    const preset = getImagePreset(req.query.preset);
    let sized: ResizeResult | null = null;
    if (preset && detectFileKind(head) === 'image') {
      try {
        sized = await fitImageToPreset(req.file.path, preset);
        filename = sized.filename;
      } catch (resizeError) {
        console.error('Image resize error:', resizeError);
        fs.unlink(req.file.path, () => {});
        res.status(400).json({ error: RESIZE_FAILED });
        return;
      }
    }

    await recordUpload(filename, subFolder, String(req.user!.id));

    const fileUrl = `${getPublicServerUrl(req)}/uploads/${subFolder}/${filename}`;

    res.status(201).json({ success: true, url: fileUrl, filename, ...sizeInfo(sized) });
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
    if (subFolder === 'sounds' && !isStaff(req)) {
      res.status(403).json({ error: 'غير مصرح برفع ملفات إلى هذا القسم' });
      return;
    }
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

    if (!isContentAllowed(buffer.subarray(0, 16), mime, ext)) {
      res.status(400).json({ error: 'محتوى الملف لا يطابق نوعه، يُسمح بالصور و PDF فقط' });
      return;
    }

    const randomPrefix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    // The stored extension always comes from the validated type, never from the client's file name
    const cleanName = typeof originalName === 'string' ? originalName : '';
    const safeBaseName = path.basename(cleanName, path.extname(cleanName)).replace(/[^a-zA-Z0-9_\u0600-\u06FF-]/g, '_') || 'upload';
    let filename = `${randomPrefix}-${safeBaseName}${ext}`;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, buffer);

    const preset = getImagePreset(req.query.preset);
    let sized: ResizeResult | null = null;
    if (preset && ext !== '.pdf') {
      try {
        sized = await fitImageToPreset(filePath, preset);
        filename = sized.filename;
      } catch (resizeError) {
        console.error('Image resize error:', resizeError);
        fs.unlink(filePath, () => {});
        res.status(400).json({ error: RESIZE_FAILED });
        return;
      }
    }

    await recordUpload(filename, subFolder, String(req.user!.id));

    const fileUrl = `${getPublicServerUrl(req)}/uploads/${subFolder}/${filename}`;

    res.status(201).json({ success: true, url: fileUrl, ...sizeInfo(sized) });
  } catch (error: any) {
    console.error('Error uploading base64 image:', error);
    res.status(500).json({ error: 'فشل رفع الصورة' });
  }
});

export default router;
