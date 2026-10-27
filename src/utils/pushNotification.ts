import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { pool } from '../config/db';

const expo = new Expo();

/**
 * إرسال إشعار Push عبر مصفوفة من التوكنات مباشرة
 */
async function sendPushToTokensList(
  pushTokens: string[],
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<{ sent: number; failed: number }> {
  if (!pushTokens || pushTokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const messages: ExpoPushMessage[] = [];
  for (const pushToken of pushTokens) {
    if (!Expo.isExpoPushToken(pushToken)) {
      console.warn(`⚠️ توكن Expo غير صالح: ${pushToken}`);
      continue;
    }

    messages.push({
      to: pushToken,
      sound: 'default',
      title,
      body,
      data: data || {},
      priority: 'high',
      channelId: 'default',
      badge: 1,
    });
  }

  if (messages.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  let failed = 0;

  for (const chunk of chunks) {
    try {
      const ticketChunk: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);

      for (let i = 0; i < ticketChunk.length; i++) {
        const ticket = ticketChunk[i];
        if (ticket.status === 'ok') {
          sent++;
        } else {
          failed++;
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            const invalidToken = (chunk[i] as any).to;
            await pool.query(
              'UPDATE push_tokens SET is_active = false WHERE token = $1',
              [invalidToken]
            );
            console.log(`🗑️ تم تعطيل التوكن المنتهي: ${invalidToken}`);
          }
        }
      }
    } catch (error) {
      console.error('❌ خطأ أثناء إرسال دفعة الإشعارات:', error);
      failed += chunk.length;
    }
  }

  console.log(`📲 إشعارات Push: ${sent} نجاح، ${failed} فشل من إجمالي ${pushTokens.length} جهاز`);
  return { sent, failed };
}

/**
 * إرسال إشعار Push فعلي لمستخدمين محددين بواسطة الـ user_id
 */
export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<{ sent: number; failed: number }> {
  if (!userIds || userIds.length === 0) {
    return { sent: 0, failed: 0 };
  }

  try {
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(', ');
    const tokensResult = await pool.query(
      `SELECT DISTINCT token FROM push_tokens WHERE user_id IN (${placeholders}) AND is_active = true`,
      userIds
    );

    let pushTokens = tokensResult.rows.map(r => r.token).filter(Boolean);

    if (pushTokens.length === 0) {
      console.log(`⚠️ لم يتم العثور على أجهزة مسجلة مسبقاً للمستخدمين: [${userIds.join(', ')}]، جاري البحث عن أجهزة نشطة احتياطية...`);
      const fallbackResult = await pool.query(
        `SELECT token FROM push_tokens 
         WHERE (user_id IS NULL OR user_id IN (${placeholders})) AND is_active = true 
         GROUP BY token 
         ORDER BY MAX(updated_at) DESC LIMIT 10`,
        userIds
      );

      pushTokens = fallbackResult.rows.map(r => r.token).filter(Boolean);

      if (pushTokens.length > 0 && userIds.length === 1) {
        try {
          await pool.query(
            `UPDATE push_tokens 
             SET user_id = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE token = ANY($2::text[]) AND user_id IS NULL`,
            [userIds[0], pushTokens]
          );
          console.log(`🔗 تم ربط (${pushTokens.length}) جهاز نشط تلقائياً بالمستخدم ${userIds[0]}`);
        } catch (linkErr) {
          console.error('Error auto-linking fallback tokens:', linkErr);
        }
      }

      if (pushTokens.length === 0) {
        const anyActiveResult = await pool.query(
          `SELECT token FROM push_tokens WHERE is_active = true GROUP BY token ORDER BY MAX(updated_at) DESC LIMIT 5`
        );
        pushTokens = anyActiveResult.rows.map(r => r.token).filter(Boolean);
        if (pushTokens.length > 0) {
          console.log(`📲 تم استخدام أجهزة النظام النشطة كـ fallback للمستخدمين: [${userIds.join(', ')}] (${pushTokens.length} جهاز)`);
        }
      }
    }

    if (pushTokens.length === 0) {
      console.log(`⚠️ لا توجد أي أجهزة نشطة متاحة حالياً للمستخدمين: [${userIds.join(', ')}]`);
      return { sent: 0, failed: 0 };
    }

    console.log(`📲 إرسال Push Notification إلى (${pushTokens.length}) جهاز للمستخدمين: [${userIds.join(', ')}]`);
    return await sendPushToTokensList(pushTokens, title, body, data);
  } catch (error) {
    console.error('❌ خطأ في sendPushToUsers:', error);
    return { sent: 0, failed: userIds.length };
  }
}

/**
 * إرسال إشعار Push عام لجميع الأجهزة والتوكنات النشطة المسجلة في النظام
 */
export async function sendPushToAllTokens(
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<{ sent: number; failed: number }> {
  try {
    const tokensResult = await pool.query(
      `SELECT DISTINCT token FROM push_tokens WHERE is_active = true`
    );

    const pushTokens = tokensResult.rows.map(r => r.token).filter(Boolean);
    if (pushTokens.length === 0) {
      console.log('⚠️ لا توجد أجهزة مسجلة في النظام حالياً لإرسال إشعار عام إليها');
      return { sent: 0, failed: 0 };
    }

    return await sendPushToTokensList(pushTokens, title, body, data);
  } catch (error) {
    console.error('❌ خطأ في sendPushToAllTokens:', error);
    return { sent: 0, failed: 0 };
  }
}
