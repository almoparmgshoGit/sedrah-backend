import { Pool } from 'pg';
import { env } from './env';
import { generate16CharId, formatUserId, formatCompanyId, formatPackageId, formatChatId, formatDocumentId } from '../utils/formatId';
import argon2 from 'argon2';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Initialize database tables with 16-character secure random alphanumeric IDs and migrate integer IDs if any
export const initDB = async () => {
  try {
    // Universal safety check: ensure all ID and foreign key columns across all tables are VARCHAR(16)
    const tablesAndCols = [
      { table: 'users', col: 'id' },
      { table: 'users', col: 'permission_group_id' },
      { table: 'permission_groups', col: 'id' },
      { table: 'cities', col: 'id' },
      { table: 'governorates', col: 'id' },
      { table: 'centers', col: 'id' },
      { table: 'centers', col: 'governorate_id' },
      { table: 'companies', col: 'id' },
      { table: 'companies', col: 'user_id' },
      { table: 'companies', col: 'city_id' },
      { table: 'packages', col: 'id' },
      { table: 'packages', col: 'company_id' },
      { table: 'packages', col: 'city_id' },
      { table: 'reviews', col: 'id' },
      { table: 'reviews', col: 'company_id' },
      { table: 'reviews', col: 'user_id' },
      { table: 'bookings', col: 'id' },
      { table: 'bookings', col: 'user_id' },
      { table: 'bookings', col: 'package_id' },
      { table: 'documents', col: 'id' },
      { table: 'documents', col: 'booking_id' },
      { table: 'favorites', col: 'id' },
      { table: 'favorites', col: 'user_id' },
      { table: 'favorites', col: 'company_id' },
      { table: 'favorites', col: 'package_id' },
      { table: 'notifications', col: 'id' },
      { table: 'notifications', col: 'user_id' },
      { table: 'push_tokens', col: 'id' },
      { table: 'push_tokens', col: 'user_id' },
      { table: 'notification_templates', col: 'id' },
      { table: 'trip_stages', col: 'id' },
      { table: 'trip_stages', col: 'booking_id' },
      { table: 'chats', col: 'id' },
      { table: 'chats', col: 'user_id' },
      { table: 'chats', col: 'company_id' },
      { table: 'messages', col: 'id' },
      { table: 'messages', col: 'chat_id' },
      { table: 'messages', col: 'user_id' },
      { table: 'messages', col: 'company_id' },
      { table: 'interview_appointments', col: 'id' },
      { table: 'interview_appointments', col: 'user_id' },
      { table: 'interview_appointments', col: 'chat_id' },
      { table: 'store_categories', col: 'id' },
      { table: 'store_products', col: 'id' },
      { table: 'store_products', col: 'category_id' },
      { table: 'store_banners', col: 'id' },
      { table: 'store_banners', col: 'product_id' },
      { table: 'store_banners', col: 'governorate_id' },
      { table: 'store_orders', col: 'id' },
      { table: 'store_orders', col: 'user_id' },
      { table: 'store_orders', col: 'governorate_id' },
      { table: 'store_orders', col: 'city_id' },
      { table: 'store_order_items', col: 'id' },
      { table: 'store_order_items', col: 'order_id' },
      { table: 'store_order_items', col: 'product_id' },
      { table: 'audit_logs', col: 'id' },
      { table: 'idempotency_keys', col: 'user_id' },
    ];

    for (const item of tablesAndCols) {
      try {
        const check = await pool.query(
          `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
          [item.table, item.col]
        );
        if (check.rows.length > 0 && ['integer', 'bigint', 'smallint', 'numeric'].includes(check.rows[0].data_type)) {
          try {
            await pool.query(`ALTER TABLE ${item.table} ALTER COLUMN ${item.col} TYPE VARCHAR(16) USING ${item.col}::VARCHAR(16);`);
          } catch (alterErr) {
            await pool.query(`ALTER TABLE ${item.table} DROP CONSTRAINT IF EXISTS ${item.table}_${item.col}_fkey CASCADE;`);
            await pool.query(`ALTER TABLE ${item.table} ALTER COLUMN ${item.col} TYPE VARCHAR(16) USING ${item.col}::VARCHAR(16);`);
          }
          console.log(`✅ Converted existing column ${item.table}.${item.col} to VARCHAR(16)`);
        }
      } catch (err: any) {
        console.warn(`Could not convert ${item.table}.${item.col}:`, err.message);
      }
    }

    // Check if migration from integer IDs to VARCHAR(16) is needed
    const userColCheck = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'id'`);
    if (userColCheck.rows.length > 0 && ['integer', 'bigint', 'smallint'].includes(userColCheck.rows[0].data_type)) {
      console.log('🔄 Migrating existing integer IDs to 16-character alphanumeric IDs in topological order...');

      // Helper function to migrate a table's integer id to VARCHAR(16)
      const migrateTableId = async (tableName: string) => {
        const check = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`, [tableName]);
        if (check.rows.length > 0 && ['integer', 'bigint', 'smallint'].includes(check.rows[0].data_type)) {
          await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS new_id VARCHAR(16);`);
          const rows = await pool.query(`SELECT id FROM ${tableName} WHERE new_id IS NULL`);
          for (const r of rows.rows) {
            const newId = generate16CharId();
            await pool.query(`UPDATE ${tableName} SET new_id = $1 WHERE id = $2`, [newId, r.id]);
          }
        }
      };

      // Helper function to migrate a foreign key column from integer to VARCHAR(16)
      const migrateForeignKey = async (tableName: string, fkColumn: string, parentTable: string) => {
        const check = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [tableName, fkColumn]);
        if (check.rows.length > 0 && ['integer', 'bigint', 'smallint'].includes(check.rows[0].data_type)) {
          const newFkCol = `new_${fkColumn}`;
          await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${newFkCol} VARCHAR(16);`);
          await pool.query(`
            UPDATE ${tableName} t SET ${newFkCol} = p.new_id
            FROM ${parentTable} p WHERE t.${fkColumn} = p.id AND t.${newFkCol} IS NULL
          `);
        }
      };

      // 1. Level 1: Parents
      await migrateTableId('users');
      await migrateTableId('cities');
      await migrateTableId('governorates');
      await migrateTableId('store_categories');
      await migrateTableId('notification_templates');
      await migrateTableId('permission_groups');

      // 2. Level 2: Depends on Level 1
      await migrateForeignKey('companies', 'user_id', 'users');
      await migrateForeignKey('companies', 'city_id', 'cities');
      await migrateTableId('companies');

      await migrateForeignKey('centers', 'governorate_id', 'governorates');
      await migrateTableId('centers');

      await migrateForeignKey('store_products', 'category_id', 'store_categories');
      await migrateTableId('store_products');

      // 3. Level 3
      await migrateForeignKey('packages', 'company_id', 'companies');
      await migrateForeignKey('packages', 'city_id', 'cities');
      await migrateTableId('packages');

      await migrateForeignKey('reviews', 'company_id', 'companies');
      await migrateForeignKey('reviews', 'user_id', 'users');
      await migrateTableId('reviews');

      await migrateForeignKey('favorites', 'user_id', 'users');
      await migrateForeignKey('favorites', 'company_id', 'companies');
      await migrateForeignKey('favorites', 'package_id', 'packages');
      await migrateTableId('favorites');

      await migrateForeignKey('notifications', 'user_id', 'users');
      await migrateTableId('notifications');

      await migrateForeignKey('push_tokens', 'user_id', 'users');
      await migrateTableId('push_tokens');

      await migrateForeignKey('chats', 'user_id', 'users');
      await migrateForeignKey('chats', 'company_id', 'companies');
      await migrateTableId('chats');

      await migrateForeignKey('interview_appointments', 'user_id', 'users');
      await migrateForeignKey('interview_appointments', 'chat_id', 'chats');
      await migrateTableId('interview_appointments');

      await migrateForeignKey('store_orders', 'user_id', 'users');
      await migrateForeignKey('store_orders', 'governorate_id', 'governorates');
      await migrateForeignKey('store_orders', 'city_id', 'cities');
      await migrateTableId('store_orders');

      await migrateTableId('audit_logs');
      await migrateTableId('idempotency_keys');
      await migrateForeignKey('idempotency_keys', 'user_id', 'users');

      // 4. Level 4
      await migrateForeignKey('bookings', 'user_id', 'users');
      await migrateForeignKey('bookings', 'package_id', 'packages');
      await migrateTableId('bookings');

      await migrateForeignKey('store_banners', 'product_id', 'store_products');
      await migrateForeignKey('store_banners', 'governorate_id', 'governorates');
      await migrateTableId('store_banners');

      // 5. Level 5
      await migrateForeignKey('documents', 'booking_id', 'bookings');
      await migrateTableId('documents');

      await migrateForeignKey('trip_stages', 'booking_id', 'bookings');
      await migrateTableId('trip_stages');

      await migrateForeignKey('messages', 'chat_id', 'chats');
      await migrateForeignKey('messages', 'user_id', 'users');
      await migrateForeignKey('messages', 'company_id', 'companies');
      await migrateTableId('messages');

      await migrateForeignKey('store_order_items', 'order_id', 'store_orders');
      await migrateForeignKey('store_order_items', 'product_id', 'store_products');
      await migrateTableId('store_order_items');

      // Now drop old integer columns and swap new_id to id across all tables
      const allTables = [
        'store_order_items', 'messages', 'trip_stages', 'documents', 'store_banners', 'bookings',
        'idempotency_keys', 'audit_logs', 'store_orders', 'interview_appointments', 'chats', 'push_tokens',
        'notifications', 'favorites', 'reviews', 'packages', 'store_products', 'centers', 'companies',
        'permission_groups', 'notification_templates', 'store_categories', 'governorates', 'cities', 'users'
      ];

      for (const t of allTables) {
        try {
          // Drop constraints referencing or referenced by this table temporarily
          await pool.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${t}_pkey CASCADE;`);
        } catch {}
      }

      for (const t of allTables) {
        try {
          await pool.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS id CASCADE;`);
          await pool.query(`ALTER TABLE ${t} RENAME COLUMN new_id TO id;`);
          await pool.query(`ALTER TABLE ${t} ADD PRIMARY KEY (id);`);
        } catch (e) {
          // Some tables might have compound PK like notification_templates or key PK like settings
        }
      }

      // Swap and re-add foreign key columns
      const foreignKeyDefs = [
        { table: 'companies', col: 'user_id', ref: 'users(id)' },
        { table: 'companies', col: 'city_id', ref: 'cities(id)' },
        { table: 'centers', col: 'governorate_id', ref: 'governorates(id)' },
        { table: 'store_products', col: 'category_id', ref: 'store_categories(id)' },
        { table: 'packages', col: 'company_id', ref: 'companies(id)' },
        { table: 'packages', col: 'city_id', ref: 'cities(id)' },
        { table: 'reviews', col: 'company_id', ref: 'companies(id)' },
        { table: 'reviews', col: 'user_id', ref: 'users(id)' },
        { table: 'favorites', col: 'user_id', ref: 'users(id)' },
        { table: 'favorites', col: 'company_id', ref: 'companies(id)' },
        { table: 'favorites', col: 'package_id', ref: 'packages(id)' },
        { table: 'notifications', col: 'user_id', ref: 'users(id)' },
        { table: 'push_tokens', col: 'user_id', ref: 'users(id)' },
        { table: 'chats', col: 'user_id', ref: 'users(id)' },
        { table: 'chats', col: 'company_id', ref: 'companies(id)' },
        { table: 'interview_appointments', col: 'user_id', ref: 'users(id)' },
        { table: 'interview_appointments', col: 'chat_id', ref: 'chats(id)' },
        { table: 'store_orders', col: 'user_id', ref: 'users(id)' },
        { table: 'store_orders', col: 'governorate_id', ref: 'governorates(id)' },
        { table: 'store_orders', col: 'city_id', ref: 'cities(id)' },
        { table: 'idempotency_keys', col: 'user_id', ref: 'users(id)' },
        { table: 'bookings', col: 'user_id', ref: 'users(id)' },
        { table: 'bookings', col: 'package_id', ref: 'packages(id)' },
        { table: 'store_banners', col: 'product_id', ref: 'store_products(id)' },
        { table: 'store_banners', col: 'governorate_id', ref: 'governorates(id)' },
        { table: 'documents', col: 'booking_id', ref: 'bookings(id)' },
        { table: 'trip_stages', col: 'booking_id', ref: 'bookings(id)' },
        { table: 'messages', col: 'chat_id', ref: 'chats(id)' },
        { table: 'messages', col: 'user_id', ref: 'users(id)' },
        { table: 'messages', col: 'company_id', ref: 'companies(id)' },
        { table: 'store_order_items', col: 'order_id', ref: 'store_orders(id)' },
        { table: 'store_order_items', col: 'product_id', ref: 'store_products(id)' },
      ];

      for (const fk of foreignKeyDefs) {
        try {
          await pool.query(`ALTER TABLE ${fk.table} DROP COLUMN IF EXISTS ${fk.col} CASCADE;`);
          await pool.query(`ALTER TABLE ${fk.table} RENAME COLUMN new_${fk.col} TO ${fk.col};`);
          await pool.query(`ALTER TABLE ${fk.table} ADD FOREIGN KEY (${fk.col}) REFERENCES ${fk.ref} ON DELETE CASCADE;`);
        } catch (e) {
          console.error(`Error migrating FK ${fk.col} on ${fk.table}:`, e);
        }
      }

      console.log('✅ Successfully completed integer ID to 16-character alphanumeric ID migration.');
    }

    // Permission Groups table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS permission_groups (
        id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        permissions TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 1. Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        phone VARCHAR(50),
        role VARCHAR(50),
        balance NUMERIC(10, 2),
        country VARCHAR(100),
        city VARCHAR(100),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure permission_group_id, permissions, address, status, public_id, is_verified, otp_code & otp_expires_at columns exist in users table
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_group_id VARCHAR(16);');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT;');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;');
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';");
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;');

    // 2. Cities table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cities (
        id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        image_url TEXT,
        total_companies INT,
        total_packages INT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure permissions column exists in users table
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT;');

    // Ensure all 27 Egyptian governorates with 'محافظة ' prefix are present in cities table
    const cityCountResult = await pool.query('SELECT COUNT(*) FROM cities');
    const egyptianGovernoratesList = [
      "محافظة القاهرة", "محافظة الجيزة", "محافظة الإسكندرية", "محافظة البحيرة", "محافظة كفر الشيخ",
      "محافظة الدقهلية", "محافظة الشرقية", "محافظة الغربية", "محافظة المنوفية", "محافظة القليوبية",
      "محافظة دمياط", "محافظة بورسعيد", "محافظة الإسماعيلية", "محافظة السويس", "محافظة شمال سيناء",
      "محافظة جنوب سيناء", "محافظة الفيوم", "محافظة بني سويف", "محافظة المنيا", "محافظة أسيوط",
      "محافظة سوهاج", "محافظة قنا", "محافظة الأقصر", "محافظة أسوان", "محافظة البحر الأحمر",
      "محافظة الوادي الجديد", "محافظة مطروح"
    ];

    if (parseInt(cityCountResult.rows[0].count, 10) < 27) {
      await pool.query('DELETE FROM cities');
      for (const govName of egyptianGovernoratesList) {
        await pool.query(
          `INSERT INTO cities (id, name, image_url, total_companies, total_packages, description) VALUES ($1, $2, NULL, 0, 0, $3)`,
          [generate16CharId(), govName, govName]
        );
      }
      console.log('✅ Re-seeded all 27 Egyptian governorates without default images.');
    } else {
      const existingCities = await pool.query('SELECT id FROM cities ORDER BY created_at ASC');
      for (let i = 0; i < Math.min(existingCities.rows.length, egyptianGovernoratesList.length); i++) {
        const targetName = egyptianGovernoratesList[i];
        await pool.query('UPDATE cities SET name = $1 WHERE id = $2', [targetName, existingCities.rows[i].id]);
      }
      // Remove any dummy unsplash default image_urls
      await pool.query("UPDATE cities SET image_url = NULL WHERE image_url LIKE '%unsplash%'");
    }

    // 3. Companies table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id VARCHAR(16) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE SET NULL,
        city_id VARCHAR(16) REFERENCES cities(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        logo_url TEXT,
        banner_url TEXT,
        rating NUMERIC(3,2),
        reviews_count INT,
        description TEXT,
        verified BOOLEAN,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS pending_owner_email VARCHAR(255);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS short_description TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(100);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(100);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS landline_phone VARCHAR(100);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS website_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS social_links TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS google_maps_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS working_hours TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS holidays_notes TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS commercial_register_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_id_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS manager_id_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS manager_id_back_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS field_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);
    `);

    // 4. Packages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS packages (
        id VARCHAR(16) PRIMARY KEY,
        company_id VARCHAR(16) REFERENCES companies(id) ON DELETE CASCADE,
        city_id VARCHAR(16) REFERENCES cities(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        duration VARCHAR(100) NOT NULL,
        price NUMERIC(10, 2),
        rating NUMERIC(3, 2),
        image_url TEXT,
        description TEXT,
        features TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS features TEXT;
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS nights_count INT;
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS departure_date VARCHAR(100);
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS return_date VARCHAR(100);
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS departure_airport VARCHAR(100);
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS hotel_makkah TEXT;
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS hotel_madinah TEXT;
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS room_prices TEXT;
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS max_adults VARCHAR(50);
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS max_children VARCHAR(50);
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS cancellation_policy TEXT;
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS itinerary TEXT;
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
      ALTER TABLE packages ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);
      ALTER TABLE packages ALTER COLUMN price DROP NOT NULL;
    `);

    // 5. Reviews table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id VARCHAR(16) PRIMARY KEY,
        company_id VARCHAR(16) REFERENCES companies(id) ON DELETE CASCADE,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        rating NUMERIC(2, 1) NOT NULL,
        comment TEXT NOT NULL,
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query('ALTER TABLE reviews ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;');

    // 6. Bookings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id VARCHAR(16) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        package_id VARCHAR(16) REFERENCES packages(id) ON DELETE CASCADE,
        booking_reference VARCHAR(50) UNIQUE NOT NULL,
        status VARCHAR(50),
        booking_method VARCHAR(50),
        room_type VARCHAR(50),
        travelers_count INT,
        children_count INT,
        total_price NUMERIC(10, 2) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_url TEXT;');
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_approved BOOLEAN DEFAULT FALSE;');
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS receipt_status VARCHAR(50) DEFAULT 'pending';`);
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rejection_reason TEXT;');
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS allow_retry BOOLEAN DEFAULT TRUE;');
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 3;');
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;');
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(50) DEFAULT 'admin';`);
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS commission_amount FLOAT DEFAULT 0.0;');
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS commission_method_used VARCHAR(50);');
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS commission_rate_used VARCHAR(100);');

    // 7. Documents table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id VARCHAR(16) PRIMARY KEY,
        booking_id VARCHAR(16) REFERENCES bookings(id) ON DELETE CASCADE,
        traveler_name VARCHAR(255) NOT NULL,
        document_type VARCHAR(100),
        status VARCHAR(50),
        valid_until VARCHAR(100),
        file_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Appointment & working hours columns
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS working_days TEXT DEFAULT '["Sunday","Monday","Tuesday","Wednesday","Thursday"]';`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS working_hours_start VARCHAR(50) DEFAULT '09:00';`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS working_hours_end VARCHAR(50) DEFAULT '17:00';`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_daily_capacity INT DEFAULT 10;`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS slot_duration_minutes INT DEFAULT 30;`);

    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS appointment_date DATE;`);
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS appointment_time VARCHAR(50);`);
    await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS appointment_status VARCHAR(50) DEFAULT 'suggested';`);

    // 8. Favorites table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id VARCHAR(16) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        company_id VARCHAR(16) REFERENCES companies(id) ON DELETE CASCADE,
        package_id VARCHAR(16) REFERENCES packages(id) ON DELETE CASCADE,
        product_id VARCHAR(100),
        product_name VARCHAR(255),
        product_price VARCHAR(100),
        product_image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 9. Notifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id VARCHAR(16) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        subtitle TEXT NOT NULL,
        category VARCHAR(50),
        icon VARCHAR(100),
        icon_bg VARCHAR(100),
        icon_color VARCHAR(50),
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false;`);
    await pool.query(`UPDATE notifications SET is_read = false WHERE is_read IS NULL;`);

    // 9.1 Push Tokens table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id VARCHAR(16) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        platform VARCHAR(20) DEFAULT 'android',
        project_id VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, token)
      );
    `);

    // 9.2 Notification Templates table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_templates (
        id VARCHAR(16) PRIMARY KEY,
        system VARCHAR(50) NOT NULL,
        status_key VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        subtitle TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'عام',
        icon VARCHAR(50) DEFAULT 'notifications-outline',
        icon_bg VARCHAR(50) DEFAULT '#EFF6FF',
        icon_color VARCHAR(50) DEFAULT '#2563EB',
        variables TEXT[],
        is_active BOOLEAN DEFAULT true,
        is_system BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(system, status_key)
      );
    `);

    // Seed default notification templates if empty
    const tplCount = await pool.query('SELECT COUNT(*) FROM notification_templates');
    if (parseInt(tplCount.rows[0].count, 10) === 0) {
      const defaultTemplates = [
        { system: 'bookings', status_key: 'new', name: 'طلب حجز جديد', title: 'طلب حجز جديد #{booking_number}', subtitle: 'مرحباً {customer_name}، تم استلام طلب حجزك بنجاح وجاري مراجعته وتأكيده من قبل إدارة سدرة.', category: 'bookings', icon: 'calendar-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{booking_number}', '{package_name}'] },
        { system: 'bookings', status_key: 'confirmed', name: 'تأكيد الحجز', title: 'تم تأكيد حجزك بنجاح 🎉', subtitle: 'مرحباً {customer_name}، تم تأكيد حجزك رقم #{booking_number} لرحلة {package_name}. يمكنك متابعة برنامج رحلتك عبر التطبيق.', category: 'bookings', icon: 'checkmark-circle-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{booking_number}', '{package_name}', '{company_name}'] },
        { system: 'bookings', status_key: 'receipt_review', name: 'مراجعة إيصال السداد', title: 'جاري مراجعة إيصال السداد', subtitle: 'تم استلام إيصال السداد لحجزك #{booking_number} وجاري التحقق منه من قبل فريق الحسابات.', category: 'payments', icon: 'receipt-outline', icon_bg: '#FEF3C7', icon_color: '#D97706', variables: ['{customer_name}', '{booking_number}'] },
        { system: 'bookings', status_key: 'receipt_rejected', name: 'رفض إيصال السداد', title: 'تنبيه بشأن إيصال السداد ⚠️', subtitle: 'تعذر اعتماد إيصال التحويل المرفق للحجز #{booking_number}. يرجى إعادة رفع إيصال واضح وصحيح عبر التطبيق.', category: 'payments', icon: 'alert-circle-outline', icon_bg: '#FEE2E2', icon_color: '#DC2626', variables: ['{customer_name}', '{booking_number}'] },
        { system: 'bookings', status_key: 'completed', name: 'اكتمال الرحلة والحجز', title: 'اكتملت رحلتك، حمداً لله على سلامتكم ✨', subtitle: 'مرحباً {customer_name}، نتمنى أن تكون رحلتك ممتعة ومباركة! نسعد دائماً بتقييم تجربتك عبر التطبيق.', category: 'bookings', icon: 'sparkles-outline', icon_bg: '#F3E8FF', icon_color: '#9333EA', variables: ['{customer_name}', '{booking_number}', '{package_name}'] },
        { system: 'bookings', status_key: 'cancelled', name: 'إلغاء الحجز', title: 'تم إلغاء الحجز #{booking_number}', subtitle: 'نود إفادتك بأنه تم إلغاء حجزك #{booking_number}. إذا كان لديك أي استفسار يرجى التواصل مع الدعم الفني.', category: 'bookings', icon: 'close-circle-outline', icon_bg: '#FEE2E2', icon_color: '#DC2626', variables: ['{customer_name}', '{booking_number}'] },
        { system: 'bookings', status_key: 'stage_started', name: 'بدء مرحلة جديدة من الرحلة', title: 'مرحلة جديدة: {stage_title} 📍', subtitle: 'بدأت الآن مرحلة "{stage_title}" ضمن جدول رحلتك. يمكنك متابعة خطوات المسار ومواعيد التجمع عبر التطبيق.', category: 'bookings', icon: 'navigate-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{booking_number}', '{stage_title}', '{stage_order}'] },
        { system: 'bookings', status_key: 'stage_completed', name: 'اكتمال مرحلة من الرحلة', title: 'اكتملت مرحلة: {stage_title} ✅', subtitle: 'تم إنجاز مرحلة "{stage_title}" بنجاح. استعد للخطوة القادمة في برنامج رحلتك.', category: 'bookings', icon: 'checkmark-done-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{booking_number}', '{stage_title}'] },
        { system: 'bookings', status_key: 'trip_departed', name: 'انطلاق الرحلة', title: 'انطلقت الرحلة الآن 🚌', subtitle: 'انطلقت رحلتك الآن متوجهة إلى {destination}. نتمنى لكم رحلة آمنة وسعيدة.', category: 'bookings', icon: 'bus-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{booking_number}', '{destination}'] },

        { system: 'store', status_key: 'order_created', name: 'طلب متجر جديد', title: 'تم استلام طلبك بنجاح 🛍️', subtitle: 'مرحباً {customer_name}، تم استلام طلبك رقم #{order_number} بنجاح وجاري مراجعته وتجهيزه.', category: 'store', icon: 'bag-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{order_number}', '{total_amount}'] },
        { system: 'store', status_key: 'processing', name: 'جاري تجهيز الطلب', title: 'جاري تجهيز طلبك 📦', subtitle: 'بدأ فريق المستودع في تجهيز وتغليف محتويات طلبك رقم #{order_number}.', category: 'store', icon: 'cube-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{order_number}'] },
        { system: 'store', status_key: 'shipped', name: 'تم شحن الطلب', title: 'طلبك في الطريق إليك 🚚', subtitle: 'تم تسليم طلبك رقم #{order_number} لمندوب التوصيل وبات في طريقه لعنوانك.', category: 'store', icon: 'car-outline', icon_bg: '#FEF3C7', icon_color: '#D97706', variables: ['{customer_name}', '{order_number}'] },
        { system: 'store', status_key: 'delivered', name: 'تم توصيل الطلب بنجاح', title: 'تم توصيل طلبك بنجاح ✨', subtitle: 'تم تسليم طلبك رقم #{order_number} بنجاح. شكراً لتسوقك من متجر سدرة، نتمنى أن تنال المنتجات رضاك!', category: 'store', icon: 'gift-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{order_number}'] },
        { system: 'store', status_key: 'cancelled', name: 'إلغاء طلب المتجر', title: 'تم إلغاء الطلب رقم #{order_number}', subtitle: 'تم إلغاء طلبك من المتجر رقم #{order_number}. لأي استفسار لا تتردد بالتواصل مع خدمة العملاء.', category: 'store', icon: 'close-outline', icon_bg: '#FEE2E2', icon_color: '#DC2626', variables: ['{customer_name}', '{order_number}'] },

        { system: 'chats', status_key: 'new_message', name: 'رسالة محادثة جديدة', title: 'رسالة جديدة من {sender_name} 💬', subtitle: 'لديك رسالة جديدة في المحادثة: "{message_preview}"', category: 'chats', icon: 'chatbubbles-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{sender_name}', '{message_preview}', '{chat_id}'] },
        { system: 'chats', status_key: 'chat_assigned', name: 'تولي ممثل الدعم للمحادثة', title: 'انضم ممثل الدعم للمحادثة 👨‍💼', subtitle: 'الممثل {agent_name} انضم للمحادثة الآن ومستعد لخدمتك والإجابة على كافة استفساراتك.', category: 'chats', icon: 'person-add-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{agent_name}', '{chat_id}'] },
        { system: 'chats', status_key: 'chat_closed', name: 'إغلاق المحادثة', title: 'تم إغلاق المحادثة', subtitle: 'تم إنهاء جلسة المحادثة. شكراً لتواصلك معنا ويسعدنا دائماً تقديم المساعدة.', category: 'chats', icon: 'chatbox-ellipses-outline', icon_bg: '#F1F5F9', icon_color: '#64748B', variables: ['{customer_name}', '{chat_id}'] },

        { system: 'tickets', status_key: 'new_ticket', name: 'فتح تذكرة دعم فني جديدة', title: 'تم فتح التذكرة رقم #{ticket_number} 🎫', subtitle: 'مرحباً {customer_name}، تم استلام تذكرتك "{ticket_subject}" وسيقوم فريق الدعم بالرد عليها في أقرب وقت.', category: 'tickets', icon: 'ticket-outline', icon_bg: '#EFF6FF', icon_color: '#2563EB', variables: ['{customer_name}', '{ticket_number}', '{ticket_subject}'] },
        { system: 'tickets', status_key: 'ticket_reply', name: 'رد جديد على تذكرة الدعم', title: 'رد جديد على تذكرتك #{ticket_number} ✍️', subtitle: 'أضاف فريق الدعم رداً جديداً على تذكرتك: "{reply_preview}". اضغط لعرض التفاصيل.', category: 'tickets', icon: 'mail-unread-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{ticket_number}', '{reply_preview}'] },
        { system: 'tickets', status_key: 'ticket_in_progress', name: 'التذكرة قيد المعالجة', title: 'تذكرتك قيد المعالجة الآن ⚙️', subtitle: 'جاري العمل ومتابعة طلبك في التذكرة رقم #{ticket_number} للوصول إلى أفضل حل.', category: 'tickets', icon: 'time-outline', icon_bg: '#FEF3C7', icon_color: '#D97706', variables: ['{customer_name}', '{ticket_number}'] },
        { system: 'tickets', status_key: 'ticket_resolved', name: 'تم حل التذكرة بنجاح', title: 'تم حل تذكرتك رقم #{ticket_number} ✅', subtitle: 'تمت معالجة المشكلة بنجاح في التذكرة #{ticket_number}. يرجى تأكيد إغلاقها أو تقييم الدعم.', category: 'tickets', icon: 'checkmark-circle-outline', icon_bg: '#ECFDF5', icon_color: '#059669', variables: ['{customer_name}', '{ticket_number}'] },
        { system: 'tickets', status_key: 'ticket_closed', name: 'إغلاق تذكرة الدعم', title: 'تم إغلاق التذكرة #{ticket_number}', subtitle: 'تم إغلاق تذكرة الدعم #{ticket_number}. نتمنى أن تكون الخدمة نالت إعجابك، ونسعد بتواصلك مجدداً.', category: 'tickets', icon: 'lock-closed-outline', icon_bg: '#F1F5F9', icon_color: '#64748B', variables: ['{customer_name}', '{ticket_number}'] }
      ];

      for (const tpl of defaultTemplates) {
        await pool.query(
          `INSERT INTO notification_templates (id, system, status_key, name, title, subtitle, category, icon, icon_bg, icon_color, variables, is_active, is_system)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, true)
           ON CONFLICT (system, status_key) DO NOTHING`,
          [generate16CharId(), tpl.system, tpl.status_key, tpl.name, tpl.title, tpl.subtitle, tpl.category, tpl.icon, tpl.icon_bg, tpl.icon_color, tpl.variables]
        );
      }
      console.log('✅ Seeded default notification templates for all systems.');
    }

    // 10. Trip Stages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trip_stages (
        id VARCHAR(16) PRIMARY KEY,
        booking_id VARCHAR(16) REFERENCES bookings(id) ON DELETE CASCADE,
        stage_order INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        subtitle TEXT,
        status VARCHAR(50),
        stage_date VARCHAR(100),
        traveler_name VARCHAR(255),
        document_url TEXT,
        document_number VARCHAR(100),
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 11. Chats & Messages tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id VARCHAR(16) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        company_name VARCHAR(255) NOT NULL,
        company_id VARCHAR(16) REFERENCES companies(id) ON DELETE SET NULL,
        context VARCHAR(255),
        last_message TEXT,
        unread_count INT,
        avatar TEXT,
        verified BOOLEAN,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS assigned_admin_id VARCHAR(16);
      ALTER TABLE chats ALTER COLUMN assigned_admin_id TYPE VARCHAR(16) USING assigned_admin_id::VARCHAR;
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS assigned_admin_name VARCHAR(255);
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(50);
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS ticket_type VARCHAR(100);
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS description TEXT;
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS attachment_url TEXT;
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS category_title VARCHAR(255);
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS booking_reference VARCHAR(50);
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'open';
      ALTER TABLE chats ADD COLUMN IF NOT EXISTS department VARCHAR(50) DEFAULT 'users';
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(16) PRIMARY KEY,
        chat_id VARCHAR(16) REFERENCES chats(id) ON DELETE CASCADE,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        company_id VARCHAR(16) REFERENCES companies(id) ON DELETE SET NULL,
        company_name VARCHAR(255) NOT NULL,
        sender VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        image_uri TEXT,
        time VARCHAR(50),
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 12. Interview Appointments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS interview_appointments (
        id VARCHAR(16) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE CASCADE,
        company_name VARCHAR(255) NOT NULL,
        chat_id VARCHAR(16) REFERENCES chats(id) ON DELETE SET NULL,
        title VARCHAR(255),
        appointment_date VARCHAR(100),
        appointment_time VARCHAR(50),
        location VARCHAR(255),
        notes TEXT,
        status VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 13. Governorate & Centers tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS governorates (
        id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        shipping_fee DECIMAL(10, 2) DEFAULT 50.00
      );
    `);

    await pool.query('ALTER TABLE governorates ADD COLUMN IF NOT EXISTS shipping_fee NUMERIC(10, 2) DEFAULT 50.00;');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS centers (
        id VARCHAR(16) PRIMARY KEY,
        governorate_id VARCHAR(16) REFERENCES governorates(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL
      );
    `);

    // Seed Egyptian Governorates & Centers if empty
    const govCountRes = await pool.query('SELECT COUNT(*) FROM governorates');
    if (parseInt(govCountRes.rows[0].count, 10) === 0) {
      const EGYPT_DATA = [
        { name: "محافظة الإسكندرية", centers: ["المنتزه أول", "المنتزه ثان", "شرق", "وسط", "غرب", "الجمرك", "العجمي", "العامرية أول", "العامرية ثان", "مركز ومدينة برج العرب"] },
        { name: "محافظة البحيرة", centers: ["دمنهور", "كفر الدوار", "أبو حمص", "أبو المطامير", "الدلنجات", "المحمودية", "الرحمانية", "رشيد", "إدكو", "إيتاي البارود", "حوش عيسى", "شبراخيت", "كوم حمادة", "بدر", "وادي النطرون"] },
        { name: "محافظة كفر الشيخ", centers: ["كفر الشيخ", "دسوق", "فوه", "مطوبس", "بلطيم", "الحامول", "بيلا", "سيدي سالم", "قلين", "الرياض"] },
        { name: "محافظة الدقهلية", centers: ["المنصورة", "طلخا", "نبروه", "بلقاس", "شربين", "دكرنس", "بني عبيد", "منية النصر", "ميت غمر", "أجا", "السنبلاوين", "تمي الأمديد", "المنزلة", "المطرية", "الجمالية", "ميت سلسيل", "الكردي", "محلة دمنة"] },
        { name: "محافظة الشرقية", centers: ["الزقازيق", "منيا القمح", "بلبيس", "مشتول السوق", "أبو حماد", "أبو كبير", "فاقوس", "الحسينية", "كفر صقر", "أولاد صقر", "ديرب نجم", "الإبراهيمية", "ههيا", "القرين", "صان الحجر", "منشأة أبو عمر"] },
        { name: "محافظة الغربية", centers: ["طنطا", "المحلة الكبرى", "كفر الزيات", "زفتى", "السنطة", "بسيون", "قطور", "سمنود"] },
        { name: "محافظة المنوفية", centers: ["شبين الكوم", "منوف", "أشمون", "الباجور", "قويسنا", "بركة السبع", "تلا", "الشهداء"] },
        { name: "محافظة القليوبية", centers: ["بنها", "قليوب", "القناطر الخيرية", "الخانكة", "كفر شكر", "طوخ", "شبين القناطر", "حي شرق شبرا الخيمة", "حي غرب شبرا الخيمة", "الخصوص", "العبور"] },
        { name: "محافظة دمياط", centers: ["دمياط", "فارسكور", "الزرقا", "كفر سعد", "كفر البطيخ"] },
        { name: "محافظة الإسماعيلية", centers: ["الإسماعيلية", "فايد", "القنطرة شرق", "القنطرة غرب", "التل الكبير", "أبو صوير", "القصاصين الجديدة"] },
        { name: "محافظة بورسعيد", centers: ["حي الشرق", "حي العرب", "حي المناخ", "حي الضواحي", "حي الزهور", "حي الجنوب", "مدينة بورفؤاد"] },
        { name: "محافظة السويس", centers: ["حي السويس", "حي الأربعين", "حي عتاقة", "حي الجناين", "حي فيصل"] },
        { name: "محافظة شمال سيناء", centers: ["العريش", "بئر العبد", "الشيخ زويد", "رفح", "الحسنة", "نخل"] },
        { name: "محافظة جنوب سيناء", centers: ["الطور", "شرم الشيخ", "دهب", "نويبع", "طابا", "سانت كاترين", "رأس سدر", "أبو رديس", "أبو زنيمة"] },
        { name: "محافظة القاهرة", centers: ["حي شبرا", "حي روض الفرج", "حي الساحل", "حي الشرابية", "حي الزاوية الحمراء", "حي حدائق القبة", "حي الزيتون", "حي الأميرية", "حي مصر الجديدة", "حي النزهة", "حي شرق مدينة نصر", "حي غرب مدينة نصر", "حي عين شمس", "حي السلام أول", "حي السلام ثان", "حي المطرية", "حي المرج", "حي منشأة ناصر", "حي الوايلي", "حي وسط القاهرة", "حي بولاق أبو العلا", "حي غرب القاهرة", "حي عابدين", "حي الأزبكية", "حي الموسكي", "حي باب الشعرية", "حي السيدة زينب", "حي مصر القديمة", "حي الخليفة", "حي المقطم", "حي البساتين", "حي دار السلام", "حي المعادي", "حي طرة", "حي حلوان", "حي التبين", "حي المعصرة", "حي 15 مايو", "القاهرة الجديدة", "الشروق", "بدر"] },
        { name: "محافظة الجيزة", centers: ["الجيزة", "البدرشين", "الصف", "العياط", "أطفيح", "الواحات البحرية", "منشأة القناطر", "أوسيم", "كرداسة", "أبو النمرس", "الحوامدية", "إمبابة", "الوراق"] },
        { name: "محافظة الفيوم", centers: ["الفيوم", "سنورس", "إطسا", "أبشواي", "طامية", "يوسف الصديق"] },
        { name: "محافظة بني سويف", centers: ["بني سويف", "الواسطى", "ناصر", "إهناسيا", "ببا", "سمسطا", "الفشن"] },
        { name: "محافظة المنيا", centers: ["المنيا", "مغاغة", "بني مزار", "مطاي", "سمالوط", "أبو قرقاص", "ملوي", "دير مواس", "العدوة"] },
        { name: "محافظة أسيوط", centers: ["أسيوط", "ديروط", "القوصية", "منفلوط", "أبنوب", "الفتح", "ساحل سليم", "البداري", "صدفا", "الغنايم", "أبو تيج"] },
        { name: "محافظة سوهاج", centers: ["سوهاج", "أخميم", "المراغة", "جهينة", "طهطا", "طما", "ساقلتة", "المنشأة", "جرجا", "البلينا", "دار السلام"] },
        { name: "محافظة قنا", centers: ["قنا", "دشنا", "الوقف", "نجع حمادي", "فرشوط", "أبو تشت", "قفط", "قوص", "نقادة"] },
        { name: "محافظة الأقصر", centers: ["الأقصر", "الزينية", "البياضية", "القرنة", "أرمنت", "إسنا", "الطود"] },
        { name: "محافظة أسوان", centers: ["أسوان", "دراو", "كوم أمبو", "نصر النوبة", "إدفو"] },
        { name: "محافظة البحر الأحمر", centers: ["رأس غارب", "الغردقة", "سفاجا", "القصير", "مرسى علم", "الشلاتين", "حلايب"] },
        { name: "محافظة الوادي الجديد", centers: ["الخارجة", "الداخلة", "الفرافرة", "باريس", "بلاط"] },
        { name: "محافظة مطروح", centers: ["مرسى مطروح", "الحمام", "العلمين", "الضبعة", "النجيلة", "سيدي براني", "السلوم", "سيوة"] }
      ];

      for (const gov of EGYPT_DATA) {
        const govId = generate16CharId();
        await pool.query('INSERT INTO governorates (id, name) VALUES ($1, $2)', [govId, gov.name]);
        for (const center of gov.centers) {
          await pool.query('INSERT INTO centers (id, governorate_id, name) VALUES ($1, $2, $3)', [generate16CharId(), govId, center]);
        }
      }
      console.log('✅ Seeded governorates and centers into database.');
    }

    // 14. Store Tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_categories (
        id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        icon VARCHAR(100) DEFAULT 'bag-outline',
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_products (
        id VARCHAR(16) PRIMARY KEY,
        custom_id VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        discount_price DECIMAL(10, 2),
        category_id VARCHAR(16) REFERENCES store_categories(id) ON DELETE SET NULL,
        image_url TEXT,
        images TEXT DEFAULT '[]',
        sizes TEXT DEFAULT '[]',
        colors TEXT DEFAULT '[]',
        attributes TEXT DEFAULT '{}',
        stock INT NOT NULL DEFAULT 0,
        is_featured BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query('ALTER TABLE store_products ADD COLUMN IF NOT EXISTS attributes TEXT DEFAULT \'{}\';');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_banners (
        id VARCHAR(16) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        image_url TEXT NOT NULL,
        product_id VARCHAR(16) REFERENCES store_products(id) ON DELETE SET NULL,
        product_custom_id VARCHAR(50),
        governorate_id VARCHAR(16) REFERENCES governorates(id) ON DELETE SET NULL,
        start_date DATE,
        end_date DATE,
        start_at TIMESTAMP,
        end_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_orders (
        id VARCHAR(16) PRIMARY KEY,
        order_number VARCHAR(50) UNIQUE NOT NULL,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE SET NULL,
        customer_name VARCHAR(255) NOT NULL,
        customer_phone VARCHAR(50) NOT NULL,
        customer_address TEXT NOT NULL,
        governorate_id VARCHAR(16) REFERENCES governorates(id) ON DELETE SET NULL,
        city_id VARCHAR(16) REFERENCES cities(id) ON DELETE SET NULL,
        subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        shipping_fee DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        total DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        status VARCHAR(50) DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_order_items (
        id VARCHAR(16) PRIMARY KEY,
        order_id VARCHAR(16) REFERENCES store_orders(id) ON DELETE CASCADE,
        product_id VARCHAR(16) REFERENCES store_products(id) ON DELETE SET NULL,
        product_name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        size TEXT,
        color TEXT,
        total_price DECIMAL(10, 2) NOT NULL
      );
    `);

    await pool.query(`
      ALTER TABLE cities ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);
      ALTER TABLE store_categories ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);
      ALTER TABLE store_products ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);
      ALTER TABLE store_banners ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);
      ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS public_id VARCHAR(50);
    `);

    // Seed default store categories if empty
    const catCountRes = await pool.query('SELECT COUNT(*) FROM store_categories');
    if (parseInt(catCountRes.rows[0].count, 10) === 0) {
      const DEFAULT_CATS = [
        { name: 'ملابس', icon: 'shirt-outline', sort_order: 1 },
        { name: 'أحذية', icon: 'footsteps-outline', sort_order: 2 },
        { name: 'حقائب', icon: 'briefcase-outline', sort_order: 3 },
        { name: 'ملابس الإحرام', icon: 'shirt-outline', sort_order: 4 },
        { name: 'مستلزمات العمرة', icon: 'home-outline', sort_order: 5 },
      ];
      for (const cat of DEFAULT_CATS) {
        await pool.query('INSERT INTO store_categories (id, name, icon, sort_order) VALUES ($1, $2, $3, $4)', [generate16CharId(), cat.name, cat.icon, cat.sort_order]);
      }
      console.log('✅ Seeded default store categories.');
    }

    // 15. Audit Logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(16) PRIMARY KEY,
        admin_email VARCHAR(255) NOT NULL,
        admin_name VARCHAR(255),
        action VARCHAR(255) NOT NULL,
        details TEXT,
        ip_address VARCHAR(100),
        before_data TEXT,
        after_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 16. Platform Settings table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 17. Idempotency Keys table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(16) REFERENCES users(id) ON DELETE SET NULL,
        request_hash VARCHAR(255),
        response_status INT,
        response_body JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(
      `INSERT INTO settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      ['packages_disclaimer_note', 'نحن في سدرة غير مسئولين تماما عن اي اتفاقات تتم خارج البرنامج والشركة غير مسئولة تماما عنها نهائيا', 'ملاحظة وإخلاء مسئولية الباقات للعملاء']
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_earnings (
        id VARCHAR(16) PRIMARY KEY,
        booking_id VARCHAR(16) REFERENCES bookings(id) ON DELETE CASCADE,
        company_id VARCHAR(16) REFERENCES companies(id) ON DELETE CASCADE,
        commission_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        status VARCHAR(50) DEFAULT 'recorded',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(booking_id)
      );
    `);

    await pool.query(
      `INSERT INTO settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      ['platform_commission_fee', '50', 'المبلغ الثابت لعمولة المنصة عن كل حجز']
    );

    await pool.query(
      `INSERT INTO settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      ['fixed_commission_amount', '50', 'المبلغ الثابت للعمولة لكل حجز مكتمل']
    );

    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10, 2);');

    // Ensure default admin user exists and is verified
    const allPerms = JSON.stringify(['users','companies','packages','bookings','store','notifications','reviews','admins','audit_logs','settings']);
    const adminCheck = await pool.query('SELECT id FROM users WHERE email = $1', ['admin@sdra.com']);
    if (adminCheck.rows.length === 0) {
      const passwordHash = await argon2.hash('Password123!');
      await pool.query(
        `INSERT INTO users (id, name, email, password_hash, phone, role, balance, is_verified, permissions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [generate16CharId(), 'مالك النظام', 'admin@sdra.com', passwordHash, '+966 50 000 0000', 'super_admin', 0.00, true, allPerms]
      );
      console.log('✅ Default super_admin owner created: admin@sdra.com / Password123!');
    } else {
      await pool.query(
        `UPDATE users SET name = $1, role = 'super_admin', is_verified = true, permissions = $2 WHERE email = $3`,
        ['مالك النظام', allPerms, 'admin@sdra.com']
      );
    }
    // Also mark all admin/super_admin accounts as verified by default
    await pool.query(`UPDATE users SET is_verified = true WHERE role IN ('admin', 'super_admin')`);

    // Ensure default test user exists
    const testUserCheck = await pool.query('SELECT id FROM users WHERE email = $1', ['test@example.com']);
    if (testUserCheck.rows.length === 0) {
      const passwordHash = await argon2.hash('password123');
      await pool.query(
        `INSERT INTO users (id, name, email, password_hash, phone, role, balance, permissions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [generate16CharId(), 'مستخدم تجريبي', 'test@example.com', passwordHash, '+201012345678', 'user', 0.00, JSON.stringify([])]
      );
      console.log('✅ Default test user created: test@example.com / password123');
    }

    console.log('✅ Database tables initialized successfully with 16-character secure alphanumeric IDs.');
  } catch (error) {
    console.error('❌ Error initializing database tables:', error);
  }
};

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Neon PostgreSQL Connection Error:', err.stack);
  } else {
    console.log('✅ Connected successfully to Neon PostgreSQL database at:', res.rows[0].now);
    initDB();
  }
});
