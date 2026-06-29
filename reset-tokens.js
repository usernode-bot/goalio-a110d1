#!/usr/bin/env node
/**
 * Database migration runner for payment reward tokens reset
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node reset-tokens.js
 *
 * This script resets the payment reward tokens to 1000 for user 'flushthefashion'.
 * It is a one-time database fix that can be run against any environment.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function resetTokens() {
  const client = await pool.connect();
  try {
    console.log('Starting payment reward tokens reset for flushthefashion...\n');

    // Check if tables exist
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'player_wallets'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      console.error('✗ Error: player_wallets table does not exist.');
      console.error('  The database schema has not been initialized yet.');
      await pool.end();
      process.exit(1);
    }

    // Check if user exists
    const userResult = await client.query(
      'SELECT user_id FROM player_wallets WHERE username = $1',
      ['flushthefashion']
    );

    if (userResult.rows.length === 0) {
      console.warn('⚠ User "flushthefashion" not found in player_wallets table.');
      console.warn('  Note: If this is the first time the user is being set up,');
      console.warn('  the wallet will be created automatically when they first log in.');
      await pool.end();
      process.exit(0);
    }

    const userId = userResult.rows[0].user_id;
    console.log(`✓ Found user "flushthefashion" with user_id: ${userId}`);

    // Start transaction
    await client.query('BEGIN');

    try {
      // Get current balance before update
      const beforeResult = await client.query(
        'SELECT user_id, username, balance FROM player_wallets WHERE user_id = $1',
        [userId]
      );
      console.log(`  Current balance: ${beforeResult.rows[0].balance} tokens`);

      // Update balance to 1000
      const updateResult = await client.query(
        'UPDATE player_wallets SET balance = 1000 WHERE user_id = $1 RETURNING user_id, username, balance',
        [userId]
      );

      console.log(`  New balance: ${updateResult.rows[0].balance} tokens`);

      await client.query('COMMIT');
      console.log('\n✓ Reset complete: flushthefashion tokens set to 1000');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('\n✗ Error resetting tokens:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

resetTokens();
