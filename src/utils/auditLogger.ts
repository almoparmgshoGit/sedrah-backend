import { pool } from '../config/db';
import { generate16CharId } from './formatId';

export async function logAudit(
  adminEmail: string,
  action: string,
  details?: string,
  ipAddress?: string,
  adminName?: string,
  beforeData?: any,
  afterData?: any
) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (id, admin_email, admin_name, action, details, ip_address, before_data, after_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        generate16CharId(),
        adminEmail || 'system@sdra.com',
        adminName || adminEmail || 'المسؤول',
        action,
        details || '',
        ipAddress || '127.0.0.1',
        beforeData ? (typeof beforeData === 'string' ? beforeData : JSON.stringify(beforeData, null, 2)) : null,
        afterData ? (typeof afterData === 'string' ? afterData : JSON.stringify(afterData, null, 2)) : null,
      ]
    );
  } catch (err) {
    console.error('Failed to log audit event:', err);
  }
}
