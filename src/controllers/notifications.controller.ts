import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middlewares/security.middleware';
import { pool } from '../config/db';
import { env } from '../config/env';
import { generate16CharId } from '../utils/formatId';
import { logAudit } from '../utils/auditLogger';
import { sendPushToUsers, sendPushToAllTokens } from '../utils/pushNotification';

export const getUserNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [String(userId)]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب الإشعارات' });
  }
};

export const markNotificationAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const notificationId = req.params.id;

    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const result = await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *`,
      [notificationId, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الإشعار غير موجود' });
      return;
    }

    res.json({
      success: true,
      message: 'تم تحديث حالة الإشعار بنجاح',
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء تحديث الإشعار' });
  }
};

/**
 * تسجيل / تحديث توكن Push Notification للمستخدم
 */
export const registerPushToken = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { token, userId, platform, projectId } = req.body;
    let effectiveUserId: string | null = null;

    if (userId) {
      const cleanUserId = String(userId).trim().replace(/^usr_/, '');
      const uMatch = await pool.query('SELECT id FROM users WHERE id = $1 OR public_id = $1', [cleanUserId]);
      if (uMatch.rows.length > 0) {
        effectiveUserId = uMatch.rows[0].id;
      }
    }

    if (!effectiveUserId && req.user?.id) {
      effectiveUserId = req.user.id;
    }

    if (!effectiveUserId && req.headers?.authorization?.startsWith('Bearer ')) {
      try {
        const tokenStr = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(tokenStr, env.JWT_SECRET) as any;
        if (decoded?.id) {
          effectiveUserId = String(decoded.id);
        }
      } catch (err) {}
    }

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'التوكن مطلوب وصالح' });
      return;
    }

    if (effectiveUserId) {
      // Delete any previous associations of this device token with ANY account to ensure absolute account isolation
      await pool.query(
        'DELETE FROM push_tokens WHERE token = $1',
        [token]
      );

      await pool.query(
        `INSERT INTO push_tokens (id, user_id, token, platform, project_id, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, token) DO UPDATE SET
           is_active = true,
           platform = EXCLUDED.platform,
           project_id = EXCLUDED.project_id,
           updated_at = CURRENT_TIMESTAMP`,
        [generate16CharId(), effectiveUserId, token, platform || 'android', projectId || 'sdra-app']
      );

      console.log(`✅ Push token registered & bound to user ${effectiveUserId}: ${token.substring(0, 30)}...`);
    } else {
      const existing = await pool.query('SELECT id FROM push_tokens WHERE token = $1', [token]);
      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO push_tokens (id, user_id, token, platform, project_id, is_active, updated_at)
           VALUES ($1, NULL, $2, $3, $4, true, CURRENT_TIMESTAMP)`,
          [generate16CharId(), token, platform || 'android', projectId || 'sdra-app']
        );
      } else {
        await pool.query(
          `UPDATE push_tokens SET is_active = true, updated_at = CURRENT_TIMESTAMP WHERE token = $1`,
          [token]
        );
      }
      console.log(`✅ Push token registered (active): ${token.substring(0, 30)}...`);
    }

    res.status(200).json({
      success: true,
      message: 'تم تسجيل التوكن بنجاح',
    });
  } catch (error: any) {
    console.error('Error registering push token:', error);
    res.status(500).json({ error: 'فشل تسجيل التوكن' });
  }
};

/**
 * إرسال إشعار من لوحة التحكم مع Push Notification فعلي
 */
export const sendNotificationByAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { targetType, targetId, title, subtitle, category } = req.body;

    if (!title || !title.trim()) {
      res.status(400).json({ error: 'عنوان الإشعار مطلوب' });
      return;
    }

    const notifTitle = title.trim();
    const notifSub = subtitle ? subtitle.trim() : '';
    const notifCat = category ? category.trim() : 'عام';
    let targetUserIds: string[] = [];

    if (targetType === 'everyone') {
      const allUsers = await pool.query('SELECT id FROM users');
      targetUserIds = allUsers.rows.map(r => r.id);
    } else if (targetType === 'all_users') {
      const usersRes = await pool.query("SELECT id FROM users WHERE role = 'user' OR role = 'client' OR role = 'customer' OR role IS NULL OR role = 'admin'");
      targetUserIds = usersRes.rows.map(r => r.id);
      if (targetUserIds.length === 0) {
        const allU = await pool.query('SELECT id FROM users');
        targetUserIds = allU.rows.map(r => r.id);
      }
    } else if (targetType === 'all_companies') {
      const compOwners = await pool.query('SELECT DISTINCT user_id FROM companies WHERE user_id IS NOT NULL');
      targetUserIds = compOwners.rows.map(r => r.user_id).filter(Boolean);
      if (targetUserIds.length === 0) {
        const companyUsers = await pool.query("SELECT id FROM users WHERE role = 'company' OR role = 'provider'");
        targetUserIds = companyUsers.rows.map(r => r.id);
      }
      if (targetUserIds.length === 0) {
        const allU = await pool.query('SELECT id FROM users');
        targetUserIds = allU.rows.map(r => r.id);
      }
    } else if (targetType === 'specific_user' && targetId) {
      const userRes = await pool.query('SELECT id FROM users WHERE id = $1 OR public_id = $1', [String(targetId).trim()]);
      if (userRes.rows.length > 0) {
        targetUserIds = [userRes.rows[0].id];
      }
    } else if (targetType === 'specific_company' && targetId) {
      const compRes = await pool.query('SELECT * FROM companies WHERE id = $1 OR public_id = $1', [String(targetId).trim()]);

      if (compRes.rows.length > 0) {
        const comp = compRes.rows[0];
        if (comp.user_id) {
          targetUserIds = [comp.user_id];
        } else if (comp.pending_owner_email) {
          const userMatch = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [comp.pending_owner_email]);
          if (userMatch.rows.length > 0) {
            targetUserIds = [userMatch.rows[0].id];
          }
        }
      }
    }

    if (targetUserIds.length === 0) {
      res.status(400).json({ error: 'لم يتم العثور على مستخدمين لإرسال الإشعار إليهم.' });
      return;
    }

    for (const uid of targetUserIds) {
      await pool.query(
        `INSERT INTO notifications (id, user_id, title, subtitle, category, icon, icon_bg, icon_color, is_read)
         VALUES ($1, $2, $3, $4, $5, 'notifications-outline', '#EFF6FF', '#2563EB', false)`,
        [generate16CharId(), uid, notifTitle, notifSub, notifCat]
      );
    }

    let pushResult;
    if (targetType === 'everyone' || targetType === 'all_users') {
      pushResult = await sendPushToAllTokens(
        notifTitle,
        notifSub || notifTitle,
        { type: 'admin_notification', category: notifCat }
      );
    } else {
      pushResult = await sendPushToUsers(
        targetUserIds,
        notifTitle,
        notifSub || notifTitle,
        { type: 'admin_notification', category: notifCat }
      );
    }

    await logAudit(
      req.user?.email || 'admin@sdra.com',
      'إرسال إشعارات المنصة',
      `تم إرسال إشعار بعنوان "${notifTitle}" (الفئة: ${notifCat}) إلى (${targetUserIds.length}) مستهدف — Push: ${pushResult.sent} نجح، ${pushResult.failed} فشل`,
      req.ip,
      req.user?.email || 'المسؤول',
      null,
      JSON.stringify({
        targetType,
        targetId,
        title: notifTitle,
        subtitle: notifSub,
        category: notifCat,
        sentCount: targetUserIds.length,
        pushSent: pushResult.sent,
        pushFailed: pushResult.failed,
        recipientUserIds: targetUserIds
      }, null, 2)
    );

    res.status(201).json({
      success: true,
      message: `تم إرسال الإشعار إلى (${targetUserIds.length}) مستهدفين — Push: ${pushResult.sent} وصل`,
      sentCount: targetUserIds.length,
      pushSent: pushResult.sent,
      pushFailed: pushResult.failed,
    });
  } catch (error: any) {
    console.error('Error sending admin notification:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء إرسال الإشعار: ' + (error.message || '') });
  }
};

export const getAllAdminNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT n.*, u.name as user_name, u.email as user_email
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      ORDER BY n.created_at DESC
      LIMIT 100
    `);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error fetching admin notifications:', error);
    res.status(500).json({ error: 'فشل جلب الإشعارات' });
  }
};

export const getPushTokenStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const totalTokens = await pool.query('SELECT COUNT(*) FROM push_tokens WHERE is_active = true');
    const androidTokens = await pool.query("SELECT COUNT(*) FROM push_tokens WHERE is_active = true AND platform = 'android'");
    const iosTokens = await pool.query("SELECT COUNT(*) FROM push_tokens WHERE is_active = true AND platform = 'ios'");

    res.json({
      success: true,
      data: {
        total: parseInt(totalTokens.rows[0].count, 10),
        android: parseInt(androidTokens.rows[0].count, 10),
        ios: parseInt(iosTokens.rows[0].count, 10),
      },
    });
  } catch (error: any) {
    console.error('Error fetching push token stats:', error);
    res.status(500).json({ error: 'فشل جلب الإحصائيات' });
  }
};

export const deleteNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const notificationId = req.params.id;

    const result = await pool.query(
      `DELETE FROM notifications WHERE id = $1 RETURNING *`,
      [notificationId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'الإشعار غير موجود' });
      return;
    }

    res.json({
      success: true,
      message: 'تم حذف الإشعار بنجاح',
    });
  } catch (error: any) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: 'فشل حذف الإشعار' });
  }
};
