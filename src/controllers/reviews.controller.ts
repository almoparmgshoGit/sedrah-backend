import { Response } from 'express';
import { AuthRequest } from '../middlewares/security.middleware';
import { pool } from '../config/db';

export const getUserReviews = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }

    const result = await pool.query(
      `
      SELECT r.*, c.name as company_name, c.logo_url as company_logo
      FROM reviews r
      JOIN companies c ON r.company_id = c.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      `,
      [String(userId)]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error fetching user reviews:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب تقييماتك' });
  }
};
