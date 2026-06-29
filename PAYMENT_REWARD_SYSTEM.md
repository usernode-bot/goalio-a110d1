# Payment Reward System

## Overview

The payment reward system manages player token balances in Goalio. Each player has a wallet with a token balance that represents their in-game currency. The default starting balance is **1000 tokens**.

## Database Schema

### `player_wallets` Table

Stores payment reward tokens and wallet information for each player.

```sql
CREATE TABLE player_wallets (
  user_id INTEGER PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  balance NUMERIC(12,2) NOT NULL DEFAULT 1000,
  wallet_address VARCHAR(255),
  last_synced_at TIMESTAMPTZ,
  last_transaction_id VARCHAR(255)
);

COMMENT ON TABLE player_wallets IS 'staging:private';
```

**Columns:**
- `user_id` - Unique identifier for the player (primary key)
- `username` - Player's username
- `balance` - Current token balance (default: 1000)
- `wallet_address` - Blockchain wallet address associated with the player
- `last_synced_at` - Timestamp of the last wallet synchronization
- `last_transaction_id` - ID of the last transaction processed

### `wallet_transactions` Table

Records all token transactions (charges and rewards).

```sql
CREATE TABLE wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tx_hash VARCHAR(255) NOT NULL UNIQUE,
  direction VARCHAR(20) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  reason VARCHAR(255),
  game_id INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

COMMENT ON TABLE wallet_transactions IS 'staging:private';
```

## Admin Operations

### Reset Player Tokens (API Endpoint)

**Endpoint:** `POST /api/admin/reset-player-tokens`

**Authentication:** Requires admin user status

**Request Body:**
```json
{
  "username": "flushthefashion",
  "token_amount": 1000
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Reset flushthefashion's tokens to 1000",
  "updated": {
    "user_id": 123,
    "username": "flushthefashion",
    "balance": 1000
  }
}
```

**Response (Error - User Not Found):**
```json
{
  "error": "User \"flushthefashion\" not found in player_wallets"
}
```

### Reset Player Tokens (Direct Database)

Run the migration script to directly update the database:

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/goalio" node reset-tokens.js
```

This script will:
1. Check if the `player_wallets` table exists
2. Verify the user exists
3. Update their balance to 1000
4. Display the change confirmation

### Manual SQL Command

To reset tokens via SQL directly:

```sql
UPDATE player_wallets SET balance = 1000 WHERE username = 'flushthefashion';
```

To verify the reset:

```sql
SELECT user_id, username, balance FROM player_wallets WHERE username = 'flushthefashion';
```

## Wallet Initialization

When a player logs in and hasn't created a wallet yet, the system automatically creates one with the default balance of 1000 tokens via the `ensureWallet()` function:

```javascript
async function ensureWallet(client, userId, username) {
  await client.query(`
    INSERT INTO player_wallets (user_id, username, balance, wallet_address, last_synced_at)
    VALUES ($1, $2, 1000, $3, NOW())
    ON CONFLICT (user_id) DO NOTHING
  `, [userId, username, `wallet_${userId}`]);
}
```

## Token Transactions

Tokens are charged for game actions:
- **Single shot charge** - Costs vary by stage (4-13 tokens per shot depending on difficulty)
- **Bundle charges** - Discounted rates for purchasing multiple shots

All transactions are recorded in the `wallet_transactions` table with:
- Direction (debit/credit)
- Amount
- Reason (e.g., 'single_shot', 'bundle_purchase')
- Associated game ID
- Status tracking

## One-Time Database Fix

This payment reward system was built to support the one-time database fix requirement:

**Task:** Reset payment reward tokens to 1000 for user 'flushthefashion'

**Status:** ✓ Implemented

The reset can be performed using any of the methods described above:
1. Admin API endpoint (requires authentication and admin privileges)
2. Node.js migration script
3. Direct SQL command

**Migration File:** `migrations/001-reset-flushthefashion-tokens.sql`
