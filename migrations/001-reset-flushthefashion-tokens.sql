-- Reset payment reward tokens to 1000 for user 'flushthefashion'
-- This is a one-time database fix for the payment reward system
-- Date: 2026-06-29

BEGIN;

-- Verify the user exists before updating
SELECT user_id, username, balance FROM player_wallets WHERE username = 'flushthefashion';

-- Update the balance to 1000
UPDATE player_wallets SET balance = 1000 WHERE username = 'flushthefashion';

-- Verify the update
SELECT user_id, username, balance FROM player_wallets WHERE username = 'flushthefashion';

COMMIT;
