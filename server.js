const express = require('express');
const compression = require('compression');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 20,
});
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const HOUSE_BONUS_TOKENS = 50;

// Wallet integration constants
const HOUSE_WALLET_PRIVATE_KEY = process.env.HOUSE_WALLET_PRIVATE_KEY || '';
const HOUSE_WALLET_PUBLIC_KEY = process.env.HOUSE_WALLET_PUBLIC_KEY || 'utpk1rtpjdqwm53jv6t7ax6vxczlujv577nz33veskavdn48s6k3ljr8qmn798l';
const HOUSE_WALLET_ADDRESS = process.env.HOUSE_WALLET_ADDRESS || 'ut1yusmc55zyqcaj2prwjln6z87ewa5mclhfyz7vjagr0xqqlms420qlvz7s8';
const USERNODE_SIDECAR_URL = process.env.USERNODE_SIDECAR_URL || (IS_STAGING ? 'http://usernode:3001' : 'http://usernode:3000');
const MOCK_WALLET_TXS = IS_STAGING && (!HOUSE_WALLET_PRIVATE_KEY || process.env.MOCK_WALLET_TXS === 'true');

const PUBLIC_API_PATHS = new Set(['/health', '/api/league', '/api/session', '/api/themes', '/api/captain-pot', '/api/env', '/api/admin/check', '/api/admin/reset-game', '/api/testing-mode']);
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/games/'];

app.use(express.json());

app.use((req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = req.query.token || req.headers['x-usernode-token'] || bearerToken;
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Tournament difficulty progression ──────────────────────────────────────
// The board grows with the stage (World-Cup difficulty curve):
//   stages 0-2 group   → 4×4 = 16 tiles   (jackpot odds 1/16 = 6.25%)
//   stages 3-4 knockout → 5×5 = 25 tiles   (1/25 = 4.0%)
//   stage  5   semi     → 6×6 = 36 tiles   (1/36 = 2.78%)
//   stage  6   final    → 7×7 = 49 tiles   (1/49 = 2.04%)
function gridSizeForStage(stageIdx) {
  if (stageIdx <= 2) return 16;
  if (stageIdx <= 4) return 25;
  if (stageIdx === 5) return 36;
  return 49;
}
function gridColsForStage(stageIdx) {
  if (stageIdx <= 2) return 4;
  if (stageIdx <= 4) return 5;
  if (stageIdx === 5) return 6;
  return 7;
}

// Per-stage shot pricing. Set so the house keeps ~6% (app owner cut) on a
// typical board regardless of grid size: smaller easy boards are found in
// fewer shots, so they cost more per shot; big hard boards cost less.
//   group 6.5 t/shot, knockout 4, semi 2.75, final 2
// Reduced by ~50% to match the reduced prizeDecay payouts
function pricingForStage(stageIdx) {
  let perShot;
  if (stageIdx <= 2) perShot = 6.5;
  else if (stageIdx <= 4) perShot = 4;
  else if (stageIdx === 5) perShot = 2.75;
  else perShot = 2;
  const bundle2Cost = Math.round(perShot * 2 * 0.97);
  const bundle8Cost = Math.round(perShot * 8 * 0.85);
  const bundle16Cost = Math.round(perShot * 16 * 0.80);
  return { perShot, bundle2: bundle2Cost, bundle8: bundle8Cost, bundle16: bundle16Cost };
}

// Captain's Pot floor per stage tier — rounded UP to tidy figures (per the
// build instruction): each floor = previous floor + the rounded top-up.
//   group 100, knockout 160 (+60), semi 230 (+70), final 320 (+90).
// Expected house jackpot cost per fresh board is floor/N ≈ 6.25-6.5 across all
// tiers, so it stays roughly constant and the margin band holds.
function potTierForStage(stageIdx) {
  if (stageIdx <= 2) return 0;
  if (stageIdx <= 4) return 1;
  if (stageIdx === 5) return 2;
  return 3;
}
const POT_FLOORS = [100, 160, 230, 320];
function potFloorForTier(tier) {
  return POT_FLOORS[Math.max(0, Math.min(3, tier))];
}
function potFloorForStage(stageIdx) {
  return potFloorForTier(potTierForStage(stageIdx));
}
function potTierName(tier) {
  return ['group', 'knockout', 'semi-final', 'final'][Math.max(0, Math.min(3, tier))];
}

// Prize decay formula, now keyed to the FRACTION of the board revealed so it
// scales identically across grid sizes:
//   prize(n, N) = max(8, floor(150 / (1 + e^(10.8*(n/N - 0.4444)))))
// At N=36 this is exactly the original 0.30*(n-16) curve (10.8 = 0.30*36,
// 0.4444 = 16/36): ~148 on a fresh board, ~75 at 44% revealed, floor 8 late.
function prizeDecay(n, gridSize) {
  const N = gridSize || 36;
  // Adjusted payout formula to achieve ~6% app owner cut instead of ~12.5%
  // Reduced base payout from 150 to 75 tokens, maintaining the same curve shape
  return Math.max(4, Math.floor(75 / (1 + Math.exp(10.8 * (n / N - 0.4444)))));
}

// Lazy timeout check — called at start of GET /api/games and GET /api/session
async function runTimeoutCheck(client) {
  const { rows: timedOut } = await client.query(`
    UPDATE games
    SET status = 'cooldown',
        cooldown_expires_at = NOW() + interval '1 minute',
        active_player_id = NULL,
        active_player_username = NULL
    WHERE status = 'active'
      AND last_active_at < NOW() - interval '90 seconds'
    RETURNING id
  `);
  if (timedOut.length > 0) {
    const ids = timedOut.map(r => r.id);
    await client.query(`
      UPDATE tournament_sessions SET current_game_id = NULL, updated_at = NOW()
      WHERE current_game_id = ANY($1)
    `, [ids]);
  }
  await client.query(`
    UPDATE games SET status = 'open'
    WHERE status = 'cooldown' AND cooldown_expires_at < NOW()
  `);
}

// ── Wallet transaction helpers (sidecar-based) ──────────────────────────────
// Mock transaction signing for staging (no real sidecar calls)
function generateMockTxHash() {
  return 'tx_' + crypto.randomBytes(16).toString('hex');
}

async function sendTransactionViaSidecar(toAddress, amount, memo) {
  // In staging with MOCK_WALLET_TXS, return a mock confirmed transaction immediately
  if (MOCK_WALLET_TXS) {
    return { tx_hash: generateMockTxHash(), status: 'confirmed' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${USERNODE_SIDECAR_URL}/wallet/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: toAddress,
        amount: amount,
        memo: memo
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 402) {
        throw { status: 402, message: 'Insufficient balance' };
      }
      throw new Error(`Sidecar error: ${response.status} ${JSON.stringify(err)}`);
    }

    const data = await response.json();
    return { tx_hash: data.tx_hash, status: 'pending' };
  } catch (err) {
    if (err.status === 402) throw err;
    throw new Error(`Failed to submit transaction to sidecar: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pollTransactionConfirmation(txHash, maxWaitMs = 30000) {
  // Poll for on-chain confirmation of the transaction
  const startTime = Date.now();
  const pollIntervalMs = 2000;

  while (Date.now() - startTime < maxWaitMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      // In mock mode, immediately return confirmed
      if (MOCK_WALLET_TXS) {
        return { status: 'confirmed' };
      }

      const response = await fetch(`${USERNODE_SIDECAR_URL}/wallet/status/${txHash}`, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        if (data.status === 'confirmed') {
          return data;
        }
      }
    } catch (err) {
      // Continue polling on error, as the sidecar may be temporarily unavailable
    } finally {
      clearTimeout(timeoutId);
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Transaction ${txHash} confirmation timeout after ${maxWaitMs}ms`);
}

async function recordTransaction(client, userId, txHash, direction, amount, reason, gameId = null, status = 'pending') {
  await client.query(`
    INSERT INTO wallet_transactions (user_id, tx_hash, direction, amount, reason, game_id, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (tx_hash) DO NOTHING
  `, [userId, txHash, direction, amount, reason, gameId, status]);
}

async function updateTransactionStatus(client, txHash, status = 'confirmed') {
  await client.query(`
    UPDATE wallet_transactions
    SET status = $2, confirmed_at = NOW()
    WHERE tx_hash = $1
  `, [txHash, status]);
}

// Local wallet helpers (now blockchain-backed with local cache)
async function ensureWallet(client, userId, username, userNodePubkey = null) {
  // Use actual linked Usernode wallet address if available, otherwise fall back to fake address
  const walletAddress = userNodePubkey || `wallet_${userId}`;
  await client.query(`
    INSERT INTO player_wallets (user_id, username, balance, wallet_address, last_synced_at)
    VALUES ($1, $2, 1000, $3, NOW())
    ON CONFLICT (user_id) DO NOTHING
  `, [userId, username, walletAddress]);
}

async function getWalletBalance(client, userId) {
  const { rows } = await client.query(
    'SELECT balance FROM player_wallets WHERE user_id = $1', [userId]
  );
  return rows.length > 0 ? parseFloat(rows[0].balance) : 1000;
}

async function syncWalletBalance(client, userId, playerInDemoMode = false) {
  // Sync wallet balance from sidecar and update cached player_wallets
  // playerInDemoMode: if true, return mock demo balance; if false, call sidecar
  try {
    console.log(`[wallet-sync] Starting wallet sync for user ${userId}, demo mode: ${playerInDemoMode}`);

    // Ensure wallet exists first
    const { rows: walletRows } = await client.query(
      'SELECT wallet_address FROM player_wallets WHERE user_id = $1',
      [userId]
    );

    if (!walletRows.length) {
      console.warn(`[wallet-sync] Wallet not found in database for user ${userId}`);
      return { balance: 1000, synced: false, error: 'Wallet not initialized' };
    }

    const walletAddress = walletRows[0].wallet_address;
    console.log(`[wallet-sync] User ${userId} wallet address: ${walletAddress}`);

    // If player is in demo mode, return mock demo balance
    if (playerInDemoMode) {
      // Return demo balance (different from the 1000 demo to show it's working)
      const demoBalance = 500;
      console.log(`[wallet-sync] Player in demo mode: returning demo balance ${demoBalance}`);
      // Update the database with the demo balance so it persists
      await client.query(
        'UPDATE player_wallets SET balance = $1, last_synced_at = NOW() WHERE user_id = $2',
        [demoBalance, userId]
      );
      return { balance: demoBalance, synced: true, source: 'mock' };
    }

    // In staging with mocked wallet TXs (and not in demo mode), still use mock for real mode
    if (MOCK_WALLET_TXS) {
      const demoBalance = 500;
      console.error(`[wallet-sync] MOCK_WALLET_TXS is enabled (IS_STAGING=${IS_STAGING}, HOUSE_WALLET_PRIVATE_KEY=${!!process.env.HOUSE_WALLET_PRIVATE_KEY})`);
      console.error(`[wallet-sync] Returning mock balance ${demoBalance} instead of calling sidecar`);
      await client.query(
        'UPDATE player_wallets SET balance = $1, last_synced_at = NOW() WHERE user_id = $2',
        [demoBalance, userId]
      );
      return { balance: demoBalance, synced: true, source: 'mock' };
    }

    // Query sidecar for actual balance
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const requestUrl = `${USERNODE_SIDECAR_URL}/wallet/balance`;
      const requestBody = { address: walletAddress };

      console.error(`[wallet-sync] Preparing sidecar request for user ${userId}`);
      console.error(`[wallet-sync] Wallet address: ${walletAddress}`);
      console.error(`[wallet-sync] Sidecar URL: ${requestUrl}`);
      console.error(`[wallet-sync] Request body: ${JSON.stringify(requestBody)}`);

      const headers = { 'content-type': 'application/json' };
      // Add auth header if the sidecar requires it
      if (process.env.USERNODE_SIDECAR_TOKEN) {
        console.error(`[wallet-sync] Including x-usernode-sidecar-token header (token set)`);
        headers['x-usernode-sidecar-token'] = process.env.USERNODE_SIDECAR_TOKEN;
      } else {
        console.error(`[wallet-sync] No USERNODE_SIDECAR_TOKEN env var set - sidecar call may fail if auth is required`);
      }

      console.error(`[wallet-sync] Request headers: ${JSON.stringify(Object.keys(headers))}`);

      console.error(`[wallet-sync] Calling sidecar...`);
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      console.error(`[wallet-sync] Sidecar responded with status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        let errorBody = {};
        let rawResponse = '';
        try {
          errorBody = await response.json();
          console.error(`[wallet-sync] Sidecar error response (JSON): ${JSON.stringify(errorBody)}`);
        } catch (parseErr) {
          try {
            rawResponse = await response.text();
            console.error(`[wallet-sync] Sidecar error response (text): ${rawResponse}`);
          } catch (_) {
            console.error(`[wallet-sync] Could not parse sidecar error response as JSON or text`);
          }
        }
        const errorMsg = `Sidecar error: HTTP ${response.status} - ${rawResponse || JSON.stringify(errorBody)}`;
        console.error(`[wallet-sync] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const data = await response.json();
      console.error(`[wallet-sync] Sidecar response body: ${JSON.stringify(data)}`);

      const sidecarBalance = parseFloat(data.balance);
      if (isNaN(sidecarBalance)) {
        console.error(`[wallet-sync] Sidecar returned non-numeric balance: ${data.balance}`);
        const cachedBalance = await getWalletBalance(client, userId);
        return { balance: cachedBalance, synced: false, error: 'Invalid balance format from sidecar' };
      }

      console.error(`[wallet-sync] Sidecar returned balance ${sidecarBalance} for user ${userId}`);
      console.error(`[wallet-sync] Updating database with sidecar balance...`);

      // Update cached balance
      await client.query(
        'UPDATE player_wallets SET balance = $1, last_synced_at = NOW() WHERE user_id = $2',
        [sidecarBalance, userId]
      );
      console.error(`[wallet-sync] ✓ Database updated successfully with balance ${sidecarBalance}`);

      return { balance: sidecarBalance, synced: true, source: 'sidecar' };
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error(`[wallet-sync] ✗ Sidecar request timed out (5s) for user ${userId}`);
        const cachedBalance = await getWalletBalance(client, userId);
        console.error(`[wallet-sync] Falling back to cached balance: ${cachedBalance}`);
        return { balance: cachedBalance, synced: false, error: 'Sidecar request timeout (5 seconds)' };
      }
      const errorMsg = err.message || String(err);
      console.error(`[wallet-sync] ✗ Sidecar sync error for user ${userId}: ${errorMsg}`);
      console.error(`[wallet-sync] Error stack: ${err.stack}`);
      const cachedBalance = await getWalletBalance(client, userId);
      console.error(`[wallet-sync] Falling back to cached balance: ${cachedBalance}`);
      return { balance: cachedBalance, synced: false, error: errorMsg };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const errorMsg = err.message || String(err);
    console.error(`[wallet-sync] ✗ Unexpected error during wallet sync for user ${userId}: ${errorMsg}`);
    console.error(`[wallet-sync] Error stack: ${err.stack}`);
    try {
      const cachedBalance = await getWalletBalance(client, userId);
      console.error(`[wallet-sync] Falling back to cached balance: ${cachedBalance}`);
      return { balance: cachedBalance, synced: false, error: errorMsg };
    } catch (fallbackErr) {
      console.error(`[wallet-sync] ✗ Failed to get cached balance as fallback: ${fallbackErr.message}`);
      console.error(`[wallet-sync] Using default fallback balance: 1000`);
      return { balance: 1000, synced: false, error: errorMsg };
    }
  }
}

async function getHouseWalletBalance(client) {
  const { rows } = await client.query('SELECT balance FROM house_wallet WHERE id = 1');
  return rows.length > 0 ? parseFloat(rows[0].balance) : 0;
}

async function updateHouseWalletBalance(client, amount) {
  await client.query(
    'UPDATE house_wallet SET balance = balance - $1, last_synced_at = NOW() WHERE id = 1',
    [amount]
  );
}

async function debitWallet(client, userId, amount, reason = 'shot_bundle', gameId = null) {
  try {
    // Check local balance BEFORE calling sidecar, using pessimistic locking
    const { rows: balanceRows } = await client.query(`
      SELECT balance FROM player_wallets
      WHERE user_id = $1 AND balance >= $2
      FOR UPDATE
    `, [userId, amount]);

    if (!balanceRows.length) throw new Error('Insufficient balance');

    // Submit transaction via sidecar (app to house transfer)
    const txResult = await sendTransactionViaSidecar(HOUSE_WALLET_ADDRESS, amount, reason);
    if (!txResult || !txResult.tx_hash) {
      throw new Error('Sidecar transaction failed: no tx_hash returned');
    }
    const txHash = txResult.tx_hash;

    // Record transaction in audit log as pending
    await recordTransaction(client, userId, txHash, 'debit', amount, reason, gameId, 'pending');

    // Poll for on-chain confirmation
    await pollTransactionConfirmation(txHash);

    // Update transaction status to confirmed
    await updateTransactionStatus(client, txHash, 'confirmed');

    // Update local cache only after on-chain confirmation
    const { rows } = await client.query(`
      UPDATE player_wallets SET balance = balance - $2, last_transaction_id = $3, last_synced_at = NOW()
      WHERE user_id = $1
      RETURNING balance
    `, [userId, amount, txHash]);

    return parseFloat(rows[0].balance);
  } catch (err) {
    if (err.status === 402 || err.message === 'Insufficient balance') {
      throw new Error('Insufficient balance');
    }
    throw err;
  }
}

async function creditWallet(client, userId, amount, reason = 'prize_payout', gameId = null) {
  try {
    // Ensure wallet exists before crediting
    await ensureWallet(client, userId, `user_${userId}`);

    // For prize payouts, check if the house wallet has sufficient balance
    // to debit. If not, the credit is marked as pending and not applied.
    if (reason === 'prize_payout' || reason === 'house_bonus') {
      const houseBalance = await getHouseWalletBalance(client);
      if (houseBalance < amount) {
        console.error(`[creditWallet] House wallet insufficient balance: ${houseBalance} < ${amount} for ${reason}`);
        // Signal that the prize payout is pending (house wallet needs funding)
        // Return a special error that the caller can detect
        const err = new Error('House wallet insufficient balance');
        err.isPending = true;
        throw err;
      }

      // House has sufficient balance; debit the house account
      await updateHouseWalletBalance(client, amount);
      console.log(`[creditWallet] Debited house wallet ${amount} for ${reason} to user ${userId}`);
    }

    // Generate a tx_hash for audit trail purposes
    const txHash = generateMockTxHash();

    // Record transaction in audit log
    await recordTransaction(client, userId, txHash, 'credit', amount, reason, gameId, 'confirmed');

    // Update player balance directly in cache
    const { rows } = await client.query(`
      UPDATE player_wallets SET balance = balance + $2, last_transaction_id = $3, last_synced_at = NOW()
      WHERE user_id = $1
      RETURNING balance
    `, [userId, amount, txHash]);

    return rows.length ? parseFloat(rows[0].balance) : 0;
  } catch (err) {
    throw err;
  }
}

async function pickNextOpponent(client, playedSlugs, myTeamSlug) {
  const excludeSlugs = [...(playedSlugs || []), myTeamSlug];
  const { rows: themeRows } = await client.query(
    'SELECT slug FROM themes WHERE slug != ALL($1) ORDER BY RANDOM() LIMIT 1',
    [excludeSlugs]
  );
  return themeRows.length ? themeRows[0].slug : null;
}

// GET /api/themes
app.get('/api/themes', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, slug, country_name, accent_colour, footballer_name FROM themes ORDER BY id'
    );
    res.json({ themes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session
app.get('/api/session', async (req, res) => {
  const client = await pool.connect();
  try {
    await runTimeoutCheck(client);
    if (!req.user) {
      const { rows: potRows } = await client.query('SELECT balance, last_won_at, last_winner_username FROM captain_pot WHERE id = 1');
      const pot = potRows[0] || { balance: 100, last_won_at: null, last_winner_username: null };
      return res.json({ session: null, captain_pot_balance: parseFloat(pot.balance), last_won_at: pot.last_won_at, last_winner_username: pot.last_winner_username, wallet_balance: 1000 });
    }
    await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);

    const { rows } = await client.query(
      'SELECT * FROM tournament_sessions WHERE user_id = $1', [req.user.id]
    );
    let session = rows[0] || null;

    // Lazily clear stale current_game_id
    if (session && session.current_game_id) {
      const { rows: gRows } = await client.query(
        'SELECT status FROM games WHERE id = $1', [session.current_game_id]
      );
      if (!gRows.length || gRows[0].status !== 'active') {
        await client.query(
          'UPDATE tournament_sessions SET current_game_id = NULL, updated_at = NOW() WHERE user_id = $1',
          [req.user.id]
        );
        session = { ...session, current_game_id: null };
      }
    }

    // Enrich session with next opponent theme if available
    let nextOpponentTheme = null;
    if (session && session.next_opponent_slug) {
      const { rows: oppRows } = await client.query(
        'SELECT id, slug, country_name, accent_colour FROM themes WHERE slug = $1',
        [session.next_opponent_slug]
      );
      if (oppRows.length) {
        nextOpponentTheme = oppRows[0];
      }
    }

    const { rows: potRows } = await client.query('SELECT balance, last_won_at, last_winner_username FROM captain_pot WHERE id = 1');
    const pot = potRows[0] || { balance: 100, last_won_at: null, last_winner_username: null };
    const potBalance = parseFloat(pot.balance);
    const walletBalance = await getWalletBalance(client, req.user.id);

    res.json({ session, next_opponent_theme: nextOpponentTheme, captain_pot_balance: potBalance, last_won_at: pot.last_won_at, last_winner_username: pot.last_winner_username, wallet_balance: walletBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/session
app.post('/api/session', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in via Usernode to play' });
  const { my_team_slug } = req.body;
  if (!my_team_slug) return res.status(400).json({ error: 'my_team_slug required' });

  const client = await pool.connect();
  try {
    const { rows: themeCheck } = await client.query(
      'SELECT id FROM themes WHERE slug = $1', [my_team_slug]
    );
    if (!themeCheck.length) return res.status(400).json({ error: 'Invalid slug' });

    const nextOpponent = await pickNextOpponent(client, [], my_team_slug);

    const { rows } = await client.query(`
      INSERT INTO tournament_sessions
        (user_id, my_team_slug, stage_idx, played_slugs, total_tokens_won, session_complete, current_game_id, next_opponent_slug, last_won_game_id)
      VALUES ($1, $2, 0, '{}', 0, false, NULL, $3, NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        my_team_slug = $2, stage_idx = 0, played_slugs = '{}',
        total_tokens_won = 0, session_complete = false,
        current_game_id = NULL, next_opponent_slug = $3, last_won_game_id = NULL, updated_at = NOW()
      RETURNING *
    `, [req.user.id, my_team_slug, nextOpponent]);

    res.json({ session: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/games
app.get('/api/games', async (req, res) => {
  const client = await pool.connect();
  try {
    await runTimeoutCheck(client);

    const { rows } = await client.query(`
      SELECT g.id, g.theme_id, g.stage_idx, g.total_guesses, g.total_players_count,
             g.status, g.created_at,
             t.slug, t.country_name, t.accent_colour
      FROM games g
      JOIN themes t ON t.id = g.theme_id
      WHERE g.status = 'open'
      ORDER BY g.created_at DESC
      LIMIT 12
    `);

    const { rows: potRows } = await client.query(
      'SELECT balance FROM captain_pot WHERE id = 1'
    );
    const potBalance = potRows.length ? parseFloat(potRows[0].balance) : 100;

    const games = rows.map(g => ({
      ...g,
      grid_size: gridSizeForStage(g.stage_idx),
      grid_cols: gridColsForStage(g.stage_idx),
      prize_pot: prizeDecay(g.total_guesses, gridSizeForStage(g.stage_idx))
    }));

    res.json({ games, captain_pot_balance: potBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/session/start-map
app.post('/api/session/start-map', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: sessionRows } = await client.query(
      'SELECT * FROM tournament_sessions WHERE user_id = $1', [req.user.id]
    );
    if (!sessionRows.length) return res.status(400).json({ error: 'No session' });
    const session = sessionRows[0];
    if (session.session_complete) return res.status(400).json({ error: 'Tournament complete' });
    if (session.current_game_id) return res.status(409).json({ error: 'Already on a map' });

    let theme;
    if (session.next_opponent_slug) {
      const { rows: themeRows } = await client.query(
        'SELECT id, slug, country_name, accent_colour, footballer_name FROM themes WHERE slug = $1',
        [session.next_opponent_slug]
      );
      if (!themeRows.length) return res.status(400).json({ error: 'Opponent not found' });
      theme = themeRows[0];
    } else {
      const playedSlugs = session.played_slugs || [];
      const excludeSlugs = [...playedSlugs, session.my_team_slug];

      const { rows: themeRows } = await client.query(
        'SELECT id, slug, country_name, accent_colour, footballer_name FROM themes WHERE slug != ALL($1)',
        [excludeSlugs]
      );
      if (!themeRows.length) return res.status(400).json({ error: 'No opponents available' });

      theme = themeRows[Math.floor(Math.random() * themeRows.length)];
    }

    const gridSize = gridSizeForStage(session.stage_idx);
    const footballSquare = Math.floor(Math.random() * gridSize);
    const revealed = new Array(gridSize).fill(false);

    const { rows: gameRows } = await client.query(`
      INSERT INTO games
        (theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count,
         status, active_player_id, active_player_username, last_active_at)
      VALUES ($1, $2, $3, $4, 0, 0, 'active', $5, $6, NOW())
      RETURNING id, theme_id, stage_idx, revealed, total_guesses, total_players_count, status
    `, [theme.id, session.stage_idx, footballSquare, revealed, req.user.id, req.user.username]);

    const game = gameRows[0];

    // Carry over unused credits from the player's last won game in this tournament.
    // Credits are not refunded on win — they roll forward as prepaid shots.
    if (session.last_won_game_id) {
      const { rows: prevSessions } = await client.query(`
        SELECT id, (credits_total - credits_used) AS remaining, tokens_per_credit
        FROM game_sessions
        WHERE game_id = $1 AND user_id = $2 AND refunded = false AND credits_used < credits_total
      `, [session.last_won_game_id, req.user.id]);
      if (prevSessions.length) {
        const totalRemaining = prevSessions.reduce((s, r) => s + parseInt(r.remaining), 0);
        const totalValue = prevSessions.reduce((s, r) => s + parseInt(r.remaining) * parseFloat(r.tokens_per_credit), 0);
        const avgRate = parseFloat((totalValue / totalRemaining).toFixed(2));
        // Close out old sessions (credits are now on the new game, not refunded to wallet)
        await client.query(
          'UPDATE game_sessions SET credits_used = credits_total WHERE id = ANY($1)',
          [prevSessions.map(r => r.id)]
        );
        // Create one consolidated carried-over session on the new game
        await client.query(`
          INSERT INTO game_sessions (game_id, user_id, credits_total, credits_used, tokens_per_credit)
          VALUES ($1, $2, $3, 0, $4)
        `, [game.id, req.user.id, totalRemaining, avgRate]);
      }
    }

    await client.query(
      'UPDATE tournament_sessions SET current_game_id = $1, next_opponent_slug = NULL, updated_at = NOW() WHERE user_id = $2',
      [game.id, req.user.id]
    );

    res.json({ game, theme, session: { ...session, current_game_id: game.id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/games/:id/join
app.post('/api/games/:id/join', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: sessionRows } = await client.query(
      'SELECT * FROM tournament_sessions WHERE user_id = $1', [req.user.id]
    );
    if (!sessionRows.length) return res.status(400).json({ error: 'No session' });
    const session = sessionRows[0];
    if (session.current_game_id) return res.status(409).json({ error: 'Already on a map' });

    // Atomically claim open game
    const { rows: gameRows } = await client.query(`
      UPDATE games
      SET status = 'active', active_player_id = $1, active_player_username = $2, last_active_at = NOW()
      WHERE id = $3 AND status = 'open'
      RETURNING id, theme_id, stage_idx, revealed, total_guesses, total_players_count, status
    `, [req.user.id, req.user.username, req.params.id]);

    if (!gameRows.length) return res.status(409).json({ error: 'Map no longer available' });
    const game = gameRows[0];

    await client.query(
      'UPDATE tournament_sessions SET current_game_id = $1, updated_at = NOW() WHERE user_id = $2',
      [game.id, req.user.id]
    );

    const { rows: themeRows } = await client.query(
      'SELECT id, slug, country_name, accent_colour, footballer_name FROM themes WHERE id = $1',
      [game.theme_id]
    );

    res.json({ game, theme: themeRows[0], session: { ...session, current_game_id: game.id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/games/:id
app.get('/api/games/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: gameRows } = await client.query(`
      SELECT g.id, g.theme_id, g.stage_idx, g.revealed, g.total_guesses,
             g.total_players_count, g.status, g.active_player_id,
             g.winner_username, g.prize_paid, g.jackpot_paid, g.created_at, g.completed_at,
             t.slug, t.country_name, t.accent_colour, t.footballer_name
      FROM games g
      JOIN themes t ON t.id = g.theme_id
      WHERE g.id = $1
    `, [req.params.id]);

    if (!gameRows.length) return res.status(404).json({ error: 'Game not found' });
    const game = gameRows[0];

    let credRows = [];
    let walletBalance = 1000;
    if (req.user) {
      const { rows } = await client.query(`
        SELECT id, credits_total, credits_used, tokens_per_credit,
               (credits_total - credits_used) as credits_remaining
        FROM game_sessions
        WHERE game_id = $1 AND user_id = $2 AND refunded = false
          AND credits_used < credits_total
        ORDER BY created_at DESC LIMIT 1
      `, [game.id, req.user.id]);
      credRows = rows;
      await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);
      walletBalance = await getWalletBalance(client, req.user.id);
    }

    const { rows: potRows } = await client.query(
      'SELECT balance, last_won_at, last_winner_username FROM captain_pot WHERE id = 1'
    );
    const potData = potRows[0] || { balance: 100, last_won_at: null, last_winner_username: null };

    const gridSize = gridSizeForStage(game.stage_idx);
    const squaresRevealed = (game.revealed || []).filter(Boolean).length;
    const prizePot = prizeDecay(squaresRevealed, gridSize);
    const pricing = pricingForStage(game.stage_idx);

    res.json({
      game,
      credits: credRows[0] || null,
      captain_pot_balance: parseFloat(potData.balance),
      last_won_at: potData.last_won_at,
      last_winner_username: potData.last_winner_username,
      wallet_balance: walletBalance,
      prize_pot: prizePot,
      squares_revealed: squaresRevealed,
      grid_size: gridSize,
      grid_cols: gridColsForStage(game.stage_idx),
      pricing
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/games/:id/keepalive
app.post('/api/games/:id/keepalive', async (req, res) => {
  try {
    await pool.query(
      'UPDATE games SET last_active_at = NOW() WHERE id = $1 AND active_player_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/games/:id/leave
app.post('/api/games/:id/leave', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      UPDATE games
      SET status = 'cooldown',
          cooldown_expires_at = NOW() + interval '1 minute',
          active_player_id = NULL,
          active_player_username = NULL
      WHERE id = $1 AND active_player_id = $2
      RETURNING id
    `, [req.params.id, req.user.id]);

    if (rows.length) {
      await client.query(
        'UPDATE tournament_sessions SET current_game_id = NULL, updated_at = NOW() WHERE user_id = $1',
        [req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/games/:id/bundle
app.post('/api/games/:id/bundle', async (req, res) => {
  const { bundle_size } = req.body;
  if (![2, 8, 16].includes(bundle_size)) {
    return res.status(400).json({ error: 'bundle_size must be 2, 8, or 16' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: gameRows } = await client.query(
      'SELECT status, active_player_id, stage_idx FROM games WHERE id = $1', [req.params.id]
    );
    if (!gameRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Game not found' });
    }
    if (gameRows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Game not active' });
    }
    if (gameRows[0].active_player_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your game' });
    }

    // Per-stage pricing: bundles prepay `bundle_size` shots at the stage rate.
    const { perShot } = pricingForStage(gameRows[0].stage_idx);
    const credits = bundle_size;
    const tokensPerCredit = perShot;
    const cost = perShot * bundle_size;

    // Ensure wallet exists before attempting debit
    try {
      await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Wallet initialization failed:', err.message);
      return res.status(500).json({ error: 'Wallet initialization failed' });
    }

    // Attempt wallet debit with explicit error handling
    let newBalance;
    try {
      newBalance = await debitWallet(client, req.user.id, cost, 'shot_bundle', req.params.id);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.message === 'Insufficient balance') {
        return res.status(402).json({ error: 'Insufficient balance' });
      }
      console.error('Bundle wallet debit failed:', err.message);
      return res.status(500).json({ error: 'Bundle purchase failed: ' + err.message });
    }

    const { rows: sessRows } = await client.query(`
      INSERT INTO game_sessions (game_id, user_id, credits_total, credits_used, tokens_per_credit)
      VALUES ($1, $2, $3, 0, $4)
      RETURNING id, credits_total, credits_used, tokens_per_credit
    `, [req.params.id, req.user.id, credits, tokensPerCredit]);

    await client.query('COMMIT');

    res.json({ session: sessRows[0], wallet_balance: newBalance, credits_remaining: credits });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Bundle endpoint error:', err.message);
    res.status(500).json({ error: 'Bundle purchase failed' });
  } finally {
    client.release();
  }
});

// POST /api/games/:id/guess
app.post('/api/games/:id/guess', async (req, res) => {
  const { square_index, session_id, testing_mode } = req.body;
  if (square_index === undefined || square_index < 0) {
    return res.status(400).json({ error: 'Invalid square_index' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the game row
    const { rows: gameRows } = await client.query(`
      SELECT g.*, t.slug AS theme_slug, t.footballer_name, t.accent_colour
      FROM games g JOIN themes t ON t.id = g.theme_id
      WHERE g.id = $1 FOR UPDATE
    `, [req.params.id]);

    if (!gameRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Game not found' });
    }
    const game = gameRows[0];
    const gridSize = gridSizeForStage(game.stage_idx);

    if (square_index >= gridSize) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid square_index' });
    }
    if (game.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Game not active' });
    }
    if (game.active_player_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not your game' });
    }
    if (game.revealed[square_index]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Square already revealed' });
    }

    // Ensure wallet exists at the start of guess (prevents state pollution)
    try {
      await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Wallet initialization failed in guess:', err.message);
      return res.status(500).json({ error: 'Wallet initialization failed' });
    }

    // Determine cost — check for active bundle session, else the stage single-shot rate
    let tokensCharged = pricingForStage(game.stage_idx).perShot;
    let usedBundleId = null;

    if (session_id) {
      const { rows: bsRows } = await client.query(`
        SELECT * FROM game_sessions
        WHERE id = $1 AND user_id = $2 AND game_id = $3
          AND refunded = false AND credits_used < credits_total
        FOR UPDATE
      `, [session_id, req.user.id, game.id]);

      if (bsRows.length) {
        tokensCharged = parseFloat(bsRows[0].tokens_per_credit);
        usedBundleId = bsRows[0].id;
        await client.query(
          'UPDATE game_sessions SET credits_used = credits_used + 1 WHERE id = $1',
          [bsRows[0].id]
        );
      }
    }

    // Debit wallet for single guess (bundles pre-paid); skip in testing mode.
    if (!usedBundleId && !testing_mode) {
      await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);
      try {
        await debitWallet(client, req.user.id, tokensCharged, 'single_shot', game.id);
      } catch {
        await client.query('ROLLBACK');
        return res.status(402).json({ error: 'Insufficient balance' });
      }
    }

    const potContribution = tokensCharged * 0.20;
    const jackpotEligible = game.total_guesses === 0;
    const isHit = square_index === game.football_square;

    const squaresRevealedBefore = (game.revealed || []).filter(Boolean).length;
    const newRevealed = [...(game.revealed || [])];
    newRevealed[square_index] = true;

    // Track first guess from this player
    const { rows: priorGuesses } = await client.query(
      'SELECT id FROM guesses WHERE game_id = $1 AND user_id = $2 LIMIT 1',
      [game.id, req.user.id]
    );
    const newPlayerCount = priorGuesses.length === 0
      ? game.total_players_count + 1
      : game.total_players_count;

    // Insert guess record
    await client.query(`
      INSERT INTO guesses (game_id, user_id, username, square_index, tokens_charged, pot_contribution, is_hit)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [game.id, req.user.id, req.user.username, square_index, tokensCharged, potContribution, isHit]);

    // Update game row
    await client.query(`
      UPDATE games SET revealed = $1, total_guesses = $2, total_players_count = $3, last_active_at = NOW()
      WHERE id = $4
    `, [newRevealed, game.total_guesses + 1, newPlayerCount, game.id]);

    // Contribute to captain pot
    await client.query(
      'UPDATE captain_pot SET balance = balance + $1 WHERE id = 1', [potContribution]
    );

    // Accumulate global stats
    await client.query(
      'UPDATE game_stats SET total_tokens_collected = total_tokens_collected + $1, updated_at = NOW() WHERE id = 1',
      [tokensCharged]
    );

    let prizePaid = 0, jackpotPaid = 0, creditsRefunded = 0, houseBonus = 0;
    let interstitial = null, newStageIdx = null, stageCompleted = false;
    let potTopup = 0, potTopupMessage = null;
    let prizeWalletError = null, bonusWalletError = null;

    if (isHit) {
      prizePaid = prizeDecay(squaresRevealedBefore, gridSize);

      let jackpotAmount = 0;
      if (jackpotEligible) {
        const { rows: potRows } = await client.query(
          'SELECT balance FROM captain_pot WHERE id = 1 FOR UPDATE'
        );
        jackpotAmount = parseFloat(potRows[0].balance);
        jackpotPaid = jackpotAmount;
        // Reseed to the floor of the stage where it was won, and reset the
        // pot's anchor tier so it can climb again. Easy group wins reseed low
        // (100), hard final wins reseed high (320) — keeps margin balanced.
        const reseedFloor = potFloorForStage(game.stage_idx);
        const reseedTier = potTierForStage(game.stage_idx);
        await client.query(`
          UPDATE captain_pot SET balance = $3, pot_floor_idx = $4, last_won_at = NOW(),
            last_winner_id = $1, last_winner_username = $2
          WHERE id = 1
        `, [req.user.id, req.user.username, reseedFloor, reseedTier]);
      }

      // Mark game completed
      await client.query(`
        UPDATE games SET status = 'completed', winner_user_id = $1, winner_username = $2,
          prize_paid = $3, jackpot_paid = $4, completed_at = NOW()
        WHERE id = $5
      `, [req.user.id, req.user.username, prizePaid, jackpotPaid, game.id]);

      // Credit prize + jackpot (skip in testing mode — balance is frontend-managed)
      if (!testing_mode) {
        await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);
        try {
          await creditWallet(client, req.user.id, prizePaid + jackpotAmount, 'prize_payout', game.id);
        } catch (err) {
          prizeWalletError = err;
          console.error('Prize payout wallet transaction failed:', err.message);
        }
      }

      // On final match win, refund remaining bundle credits to wallet
      const { rows: tourCheckRows } = await client.query(
        'SELECT stage_idx FROM tournament_sessions WHERE user_id = $1', [req.user.id]
      );
      const isFinalMatchWin = tourCheckRows.length && tourCheckRows[0].stage_idx >= 6;
      if (isFinalMatchWin) {
        const { rows: remainingCredits } = await client.query(`
          SELECT id, (credits_total - credits_used) AS remaining, tokens_per_credit
          FROM game_sessions
          WHERE game_id = $1 AND user_id = $2 AND refunded = false AND credits_used < credits_total
        `, [game.id, req.user.id]);
        if (remainingCredits.length) {
          const refundAmount = remainingCredits.reduce((sum, r) =>
            sum + (parseInt(r.remaining) * parseFloat(r.tokens_per_credit)), 0
          );
          creditsRefunded = parseFloat(refundAmount.toFixed(2));
          if (creditsRefunded > 0) {
            try {
              await creditWallet(client, req.user.id, creditsRefunded, 'bundle_refund_final', game.id);
            } catch (err) {
              console.error('Bundle refund wallet transaction failed:', err.message);
            }
            // Mark sessions as refunded
            await client.query(
              'UPDATE game_sessions SET refunded = true WHERE id = ANY($1)',
              [remainingCredits.map(r => r.id)]
            );
          }
        }
      }

      // Remaining bundle credits are NOT refunded on non-final wins — they carry over to the next game
      // via the start-map handler which consolidates them into a new session.

      // Advance tournament session
      const { rows: tourRows } = await client.query(
        'SELECT * FROM tournament_sessions WHERE user_id = $1 FOR UPDATE', [req.user.id]
      );
      const tour = tourRows[0];
      if (tour) {
        const newPlayed = [...(tour.played_slugs || []), game.theme_slug];
        const updatedStage = tour.stage_idx + 1;
        const sessionComplete = updatedStage >= 7;

        newStageIdx = updatedStage;
        stageCompleted = true;

        let wonThisRound = prizePaid + jackpotAmount;
        if (sessionComplete) {
          houseBonus = HOUSE_BONUS_TOKENS;
          if (!testing_mode) {
            try {
              await creditWallet(client, req.user.id, houseBonus, 'house_bonus', game.id);
            } catch (err) {
              bonusWalletError = err;
              console.error('House bonus wallet transaction failed:', err.message);
            }
          }
          wonThisRound += houseBonus;
        }

        const nextOpponentSlug = sessionComplete ? null : await pickNextOpponent(client, newPlayed, tour.my_team_slug);

        await client.query(`
          UPDATE tournament_sessions SET
            stage_idx = $1, played_slugs = $2,
            total_tokens_won = total_tokens_won + $3,
            session_complete = $4, current_game_id = NULL, next_opponent_slug = $6,
            last_won_game_id = $7, updated_at = NOW()
          WHERE user_id = $5
        `, [updatedStage, newPlayed, wonThisRound, sessionComplete, req.user.id, nextOpponentSlug, game.id]);

        await client.query(`
          INSERT INTO player_stats (user_id, username, display_name, total_tokens_won, sessions_completed, updated_at)
          VALUES ($1, $2, $2, $3, $4, NOW())
          ON CONFLICT (user_id) DO UPDATE SET
            total_tokens_won = player_stats.total_tokens_won + $3,
            sessions_completed = player_stats.sessions_completed + $4,
            username = $2, updated_at = NOW()
        `, [req.user.id, req.user.username, wonThisRound, sessionComplete ? 1 : 0]);

        // Determine interstitial type
        if (sessionComplete) {
          interstitial = 'final_win';
        } else if (updatedStage === 3) {
          interstitial = 'through_to_knockouts';
        } else if (updatedStage <= 3) {
          interstitial = 'group_win';
        } else {
          interstitial = 'knockout_win';
        }

        // Odds-indexed Captain's Pot top-up: when advancing into a harder tier
        // than the pot has yet reached, inject the rounded tier delta and raise
        // the pot's anchor. Bounded — at most a few top-ups per win cycle, and
        // the anchor resets on a jackpot win above.
        if (!sessionComplete) {
          const newTier = potTierForStage(updatedStage);
          const { rows: anchorRows } = await client.query(
            'SELECT pot_floor_idx FROM captain_pot WHERE id = 1 FOR UPDATE'
          );
          const anchorTier = anchorRows.length ? anchorRows[0].pot_floor_idx : 0;
          if (newTier > anchorTier) {
            potTopup = potFloorForTier(newTier) - potFloorForTier(anchorTier);
            await client.query(
              'UPDATE captain_pot SET balance = balance + $1, pot_floor_idx = $2 WHERE id = 1',
              [potTopup, newTier]
            );
            potTopupMessage = `⚡ ${potTopup} tokens now added to the Captain's Pot — ${potTierName(newTier)} odds unlocked!`;
          }
        }
      }
    }

    await client.query('COMMIT');

    const { rows: potRows } = await client.query('SELECT balance, last_won_at FROM captain_pot WHERE id = 1');
    const potBalance = potRows.length ? parseFloat(potRows[0].balance) : 100;
    const potLastWonAt = potRows.length ? potRows[0].last_won_at : null;
    const walletBalance = await getWalletBalance(client, req.user.id);

    res.json({
      hit: isHit,
      square_index,
      prize_paid: prizePaid,
      jackpot_paid: jackpotPaid,
      last_won_at: potLastWonAt,
      credits_refunded: creditsRefunded,
      house_bonus: houseBonus,
      squares_revealed: game.total_guesses + 1,
      pot_balance: potBalance,
      wallet_balance: walletBalance || 0,
      stage_completed: stageCompleted,
      new_stage_idx: newStageIdx,
      interstitial,
      pot_topup: potTopup,
      pot_topup_message: potTopupMessage,
      opponent_slug: game.theme_slug,
      footballer_name: game.footballer_name,
      prize_pending: prizeWalletError ? true : false,
      bonus_pending: bonusWalletError ? true : false
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Guess error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/captain-pot
app.get('/api/captain-pot', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT balance, last_won_at, last_winner_username FROM captain_pot WHERE id = 1'
    );
    const row = rows[0] || { balance: 100, last_won_at: null, last_winner_username: null };
    res.json({
      balance: parseFloat(row.balance),
      last_won_at: row.last_won_at,
      last_winner_username: row.last_winner_username
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/league — public endpoint
app.get('/api/league', async (req, res) => {
  try {
    const { rows: rankRows } = await pool.query(`
      SELECT user_id, username,
             COALESCE(display_name, username) AS display_name,
             total_tokens_won, sessions_completed
      FROM player_stats
      ORDER BY total_tokens_won DESC
      LIMIT 20
    `);

    const { rows: statsRows } = await pool.query(
      'SELECT total_tokens_collected FROM game_stats WHERE id = 1'
    );
    const totalCollected = statsRows.length ? parseFloat(statsRows[0].total_tokens_collected) : 0;
    const leaguePrize = Math.floor(totalCollected * 0.02);

    let currentPlayer = null;
    if (req.user) {
      const { rows: myRows } = await pool.query(`
        SELECT p.user_id, p.username,
               COALESCE(p.display_name, p.username) AS display_name,
               p.total_tokens_won,
               (SELECT COUNT(*) + 1 FROM player_stats p2 WHERE p2.total_tokens_won > p.total_tokens_won) AS rank
        FROM player_stats p WHERE p.user_id = $1
      `, [req.user.id]);
      currentPlayer = myRows[0] || null;
    }

    res.json({
      rankings: rankRows,
      current_player: currentPlayer,
      total_tokens_collected: totalCollected,
      league_prize_tokens: leaguePrize,
      prize_deadline: '2026-07-19T00:00:00Z',
      current_leader: rankRows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/league/display-name
app.patch('/api/league/display-name', async (req, res) => {
  const { display_name } = req.body;
  if (!display_name || !display_name.trim()) return res.status(400).json({ error: 'display_name required' });
  if (display_name.trim().length > 32) return res.status(400).json({ error: 'Max 32 chars' });

  try {
    await pool.query(`
      INSERT INTO player_stats (user_id, username, display_name, total_tokens_won, sessions_completed, updated_at)
      VALUES ($1, $2, $3, 0, 0, NOW())
      ON CONFLICT (user_id) DO UPDATE SET display_name = $3, updated_at = NOW()
    `, [req.user.id, req.user.username, display_name.trim()]);
    res.json({ display_name: display_name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wallet
app.get('/api/wallet', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);
    const balance = await getWalletBalance(client, req.user.id);

    const { rows } = await client.query(
      'SELECT wallet_address, last_synced_at FROM player_wallets WHERE user_id = $1',
      [req.user.id]
    );

    const walletData = rows[0] || { wallet_address: `wallet_${req.user.id}`, last_synced_at: null };

    res.json({
      balance,
      address: walletData.wallet_address,
      last_synced_at: walletData.last_synced_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/wallet/sync — Sync wallet balance from sidecar
app.get('/api/wallet/sync', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

    console.log(`[wallet-sync-endpoint] GET /api/wallet/sync for user ${req.user.id} (${req.user.username})`);

    // Get the player's current mode from query param (testingMode=1 means demo mode)
    const playerInDemoMode = req.query.testingMode === '1' || req.query.testingMode === 'true';
    console.log(`[wallet-sync-endpoint] Player testing mode: ${playerInDemoMode}`);

    await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);
    const syncResult = await syncWalletBalance(client, req.user.id, playerInDemoMode);

    console.log(`[wallet-sync-endpoint] Sync result for user ${req.user.id}:`, JSON.stringify({
      synced: syncResult.synced,
      balance: syncResult.balance,
      source: syncResult.source,
      error: syncResult.error
    }));

    const { rows } = await client.query(
      'SELECT wallet_address, last_synced_at FROM player_wallets WHERE user_id = $1',
      [req.user.id]
    );

    const walletData = rows[0] || { wallet_address: `wallet_${req.user.id}`, last_synced_at: null };

    const response = {
      balance: syncResult.balance,
      address: walletData.wallet_address,
      last_synced_at: walletData.last_synced_at,
      synced: syncResult.synced,
      source: syncResult.source,
      error: syncResult.error
    };

    console.log(`[wallet-sync-endpoint] Returning 200 OK response:`, JSON.stringify(response));

    // Return 200 OK with sync metadata — synced:false indicates sidecar unavailable, not endpoint error
    res.status(200).json(response);
  } catch (err) {
    const errorMsg = err.message || String(err);
    console.error(`[wallet-sync-endpoint] Unexpected endpoint error for user ${req.user?.id}: ${errorMsg}`);
    console.error(`[wallet-sync-endpoint] Full error:`, err);
    res.status(500).json({ error: errorMsg, synced: false });
  } finally {
    client.release();
  }
});

// Player reset balance endpoint
app.post('/api/player/reset-balance', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // Ensure wallet exists
      await ensureWallet(client, req.user.id, req.user.username, req.user.usernode_pubkey);

      // Reset balance to 1000
      const { rows } = await client.query(`
        UPDATE player_wallets SET balance = 1000, last_synced_at = NOW()
        WHERE user_id = $1
        RETURNING balance
      `, [req.user.id]);

      await client.query('COMMIT');
      const newBalance = rows.length ? parseFloat(rows[0].balance) : 1000;
      res.json({ success: true, new_balance: newBalance });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin check endpoint
async function isUserAdmin(client, userId) {
  const { rows } = await client.query('SELECT user_id FROM admin_users WHERE user_id = $1', [userId]);
  return rows.length > 0;
}

app.get('/api/admin/check', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const client = await pool.connect();
  try {
    const isAdmin = await isUserAdmin(client, req.user.id);
    res.json({ isAdmin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Admin reset game endpoint
app.post('/api/admin/reset-game', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // Delete all game-related data
      await client.query('DELETE FROM guesses');
      await client.query('DELETE FROM game_sessions');
      await client.query('DELETE FROM games');
      await client.query('DELETE FROM tournament_sessions');
      await client.query('DELETE FROM player_stats');

      // Reset player wallets to 1000
      await client.query('UPDATE player_wallets SET balance = 1000');

      // Reset captain pot
      await client.query(`
        UPDATE captain_pot
        SET balance = 100, pot_floor_idx = 0, last_won_at = NULL, last_winner_id = NULL, last_winner_username = NULL
        WHERE id = 1
      `);

      // Reset game stats
      await client.query('UPDATE game_stats SET total_tokens_collected = 0 WHERE id = 1');

      await client.query('COMMIT');
      res.json({ success: true, message: 'Game reset complete' });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/env', (req, res) => {
  res.json({ staging: IS_STAGING });
});

// Testing mode - allows skipping blockchain transactions
app.get('/api/testing-mode', (req, res) => {
  res.json({ available: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const THEMES_SEED = [
  { slug: 'france',      country_name: 'France',      accent_colour: '#3b6dff', footballer_name: 'Zinedine Zidane' },
  { slug: 'brazil',      country_name: 'Brazil',      accent_colour: '#22c55e', footballer_name: 'Neymar' },
  { slug: 'england',     country_name: 'England',     accent_colour: '#e23b4e', footballer_name: 'David Beckham' },
  { slug: 'spain',       country_name: 'Spain',       accent_colour: '#f1bf00', footballer_name: 'Carles Puyol' },
  { slug: 'argentina',   country_name: 'Argentina',   accent_colour: '#74ACDF', footballer_name: 'Diego Maradona' },
  { slug: 'morocco',     country_name: 'Morocco',     accent_colour: '#1db954', footballer_name: 'Hakim Ziyech' },
  { slug: 'usa',         country_name: 'USA',         accent_colour: '#4f7bff', footballer_name: 'Landon Donovan' },
  { slug: 'turkey',      country_name: 'Turkey',      accent_colour: '#ff3b4e', footballer_name: 'Hakan Şükür' },
  { slug: 'belgium',     country_name: 'Belgium',     accent_colour: '#ffd23f', footballer_name: 'Romelu Lukaku' },
  { slug: 'egypt',       country_name: 'Egypt',       accent_colour: '#d4af37', footballer_name: 'Mohamed Salah' },
  { slug: 'portugal',    country_name: 'Portugal',    accent_colour: '#e23b3b', footballer_name: 'Cristiano Ronaldo' },
  { slug: 'netherlands', country_name: 'Netherlands', accent_colour: '#ff7a18', footballer_name: 'Johan Cruyff' },
  { slug: 'norway',      country_name: 'Norway',      accent_colour: '#4f7bff', footballer_name: 'Erling Haaland' },
  { slug: 'germany',     country_name: 'Germany',     accent_colour: '#ffce00', footballer_name: 'Miroslav Klose' },
  { slug: 'mexico',      country_name: 'Mexico',      accent_colour: '#006847', footballer_name: 'Hugo Sánchez' },
];

async function start() {
  console.log('[init] Starting database migrations...');
  // ── Core tables ───────────────────────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS presses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    username VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS themes (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(32) UNIQUE NOT NULL,
    country_name VARCHAR(64) NOT NULL,
    accent_colour CHAR(7) NOT NULL,
    footballer_name VARCHAR(128) NOT NULL
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS captain_pot (
    id INTEGER PRIMARY KEY DEFAULT 1,
    balance NUMERIC(12,2) NOT NULL DEFAULT 100,
    last_won_at TIMESTAMPTZ,
    last_winner_id INTEGER,
    last_winner_username VARCHAR(255)
  )`);
  // Anchor tier the pot has climbed to (0 group … 3 final). Odds-indexed
  // top-ups raise the pot one tier at a time as play reaches harder stages.
  await pool.query(`ALTER TABLE captain_pot ADD COLUMN IF NOT EXISTS pot_floor_idx SMALLINT NOT NULL DEFAULT 0`);
  await pool.query(`COMMENT ON TABLE captain_pot IS 'staging:private'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    theme_id INTEGER NOT NULL REFERENCES themes(id),
    stage_idx SMALLINT NOT NULL DEFAULT 0,
    football_square SMALLINT NOT NULL,
    revealed BOOLEAN[] NOT NULL,
    total_guesses INTEGER NOT NULL DEFAULT 0,
    total_players_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    active_player_id INTEGER,
    active_player_username VARCHAR(255),
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    cooldown_expires_at TIMESTAMPTZ,
    winner_user_id INTEGER,
    winner_username VARCHAR(255),
    prize_paid INTEGER,
    jackpot_paid INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`);
  await pool.query(`COMMENT ON TABLE games IS 'staging:private'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS guesses (
    id SERIAL PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id),
    user_id INTEGER NOT NULL,
    username VARCHAR(255) NOT NULL,
    square_index SMALLINT NOT NULL,
    tokens_charged NUMERIC(8,2) NOT NULL,
    pot_contribution NUMERIC(8,2) NOT NULL,
    is_hit BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`COMMENT ON TABLE guesses IS 'staging:private'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS game_sessions (
    id SERIAL PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id),
    user_id INTEGER NOT NULL,
    credits_total SMALLINT NOT NULL,
    credits_used SMALLINT NOT NULL DEFAULT 0,
    tokens_per_credit NUMERIC(5,2) NOT NULL,
    refunded BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`COMMENT ON TABLE game_sessions IS 'staging:private'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS tournament_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    my_team_slug VARCHAR(32) NOT NULL REFERENCES themes(slug),
    stage_idx SMALLINT NOT NULL DEFAULT 0,
    played_slugs TEXT[] NOT NULL DEFAULT '{}',
    total_tokens_won INTEGER NOT NULL DEFAULT 0,
    session_complete BOOLEAN NOT NULL DEFAULT false,
    current_game_id INTEGER REFERENCES games(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE tournament_sessions ADD COLUMN IF NOT EXISTS next_opponent_slug VARCHAR(32) REFERENCES themes(slug)`);
  await pool.query(`ALTER TABLE tournament_sessions ADD COLUMN IF NOT EXISTS last_won_game_id INTEGER REFERENCES games(id)`);
  await pool.query(`COMMENT ON TABLE tournament_sessions IS 'staging:private'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS player_stats (
    user_id INTEGER PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    display_name VARCHAR(64),
    total_tokens_won NUMERIC(12,2) NOT NULL DEFAULT 0,
    sessions_completed INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS game_stats (
    id INTEGER PRIMARY KEY DEFAULT 1,
    total_tokens_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS player_wallets (
    user_id INTEGER PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    balance NUMERIC(12,2) NOT NULL DEFAULT 1000,
    wallet_address VARCHAR(255),
    last_synced_at TIMESTAMPTZ,
    last_transaction_id VARCHAR(255)
  )`);
  await pool.query(`COMMENT ON TABLE player_wallets IS 'staging:private'`);

  // Add columns to existing player_wallets table (idempotent for staging)
  await pool.query(`ALTER TABLE player_wallets ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(255)`);
  await pool.query(`ALTER TABLE player_wallets ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE player_wallets ADD COLUMN IF NOT EXISTS last_transaction_id VARCHAR(255)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS wallet_transactions (
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
  )`);
  await pool.query(`COMMENT ON TABLE wallet_transactions IS 'staging:private'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS admin_users (
    user_id INTEGER PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    granted_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`COMMENT ON TABLE admin_users IS 'staging:private'`);

  await pool.query(`CREATE TABLE IF NOT EXISTS house_wallet (
    id INTEGER PRIMARY KEY DEFAULT 1,
    wallet_address VARCHAR(255) NOT NULL,
    balance NUMERIC(12,2) NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`COMMENT ON TABLE house_wallet IS 'staging:private'`);

  // ── Seed reference data (unconditional) ───────────────────────────────────
  for (const t of THEMES_SEED) {
    await pool.query(`
      INSERT INTO themes (slug, country_name, accent_colour, footballer_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (slug) DO UPDATE SET
        country_name = $2, accent_colour = $3, footballer_name = $4
    `, [t.slug, t.country_name, t.accent_colour, t.footballer_name]);
  }

  await pool.query(`
    INSERT INTO captain_pot (id, balance) VALUES (1, 100)
    ON CONFLICT (id) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO game_stats (id, total_tokens_collected) VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `);

  // Initialize house_wallet with placeholder row
  await pool.query(`
    INSERT INTO house_wallet (id, wallet_address, balance, last_synced_at)
    VALUES (1, $1, 0, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [HOUSE_WALLET_ADDRESS]);

  // ── Staging boot reset ────────────────────────────────────────────────────
  // Wipe all player/game rows on every staging boot so the seed below always
  // starts from a clean slate. Themes, captain_pot, and game_stats are kept.
  if (IS_STAGING) {
    await pool.query(`DELETE FROM wallet_transactions`);
    await pool.query(`DELETE FROM guesses`);
    await pool.query(`DELETE FROM game_sessions`);
    await pool.query(`DELETE FROM games`);
    await pool.query(`DELETE FROM tournament_sessions`);
    await pool.query(`DELETE FROM player_stats`);
    await pool.query(`DELETE FROM player_wallets`);
    await pool.query(`DELETE FROM admin_users`);
    await pool.query(`ALTER SEQUENCE IF EXISTS games_id_seq RESTART WITH 1`);
    console.log('[staging] Reset: all game/player rows cleared');
  }

  // ── Staging seed data ─────────────────────────────────────────────────────
  if (IS_STAGING) {
    // Override captain pot and game stats with more interesting values.
    // Stamp a recent winner so the named broadcast ("X just won the Captain's
    // Pot!") and the on-load seeding fix can both be exercised in staging.
    await pool.query(`
      UPDATE captain_pot
      SET balance = 347.00, last_won_at = NOW(), last_winner_username = 'Staging Kaiser'
      WHERE id = 1
    `);
    await pool.query(`UPDATE game_stats SET total_tokens_collected = 8420.00 WHERE id = 1`);

    // Admin users for testing the reset button
    await pool.query(`
      INSERT INTO admin_users (user_id, username)
      VALUES (-1, 'staging-admin'), (-2, 'flushthefashion')
      ON CONFLICT (user_id) DO NOTHING
    `);

    // Staging player wallets with generous starting balance
    for (let i = 1; i <= 5; i++) {
      await pool.query(`
        INSERT INTO player_wallets (user_id, username, balance, wallet_address, last_synced_at)
        VALUES ($1, $2, 5000, $3, NOW())
        ON CONFLICT (user_id) DO NOTHING
      `, [-i, `staging-player-${i}`, `staging_wallet_${i}`]);
    }

    // A broke staging player (zero balance) so the Flow 1 "out of shots —
    // top up to play" notice and the insufficient-funds prompt are reachable
    // without grinding a wallet down to zero by hand.
    await pool.query(`
      INSERT INTO player_wallets (user_id, username, balance, wallet_address, last_synced_at)
      VALUES (-6, 'staging-broke-player', 0, 'staging_wallet_broke', NOW())
      ON CONFLICT (user_id) DO UPDATE SET balance = 0
    `);

    // Test user with standard starting balance for fresh game testing
    await pool.query(`
      INSERT INTO player_wallets (user_id, username, balance)
      VALUES (-1, 'staging-test-user', 1000)
      ON CONFLICT (user_id) DO UPDATE SET balance = 1000
    `);

    // Basic leaderboard entry for test user
    await pool.query(`
      INSERT INTO player_stats (user_id, username, display_name, total_tokens_won, sessions_completed)
      VALUES (-1, 'staging-test-user', 'staging-test-user', 0, 0)
      ON CONFLICT (user_id) DO NOTHING
    `);

    // 3 open staging game boards
    // We need theme IDs — fetch them
    const { rows: themeRows } = await pool.query('SELECT id, slug FROM themes');
    const themeMap = Object.fromEntries(themeRows.map(t => [t.slug, t.id]));

    // Boards are sized to their stage's grid (group 16, knockout 25, semi 36,
    // final 49). football_square is kept above the revealed prefix so the ball
    // is still hidden on the open boards.
    const revealedPrefix = (size, count) => {
      const arr = new Array(size).fill(false);
      for (let i = 0; i < count; i++) arr[i] = true;
      return arr;
    };

    // Game 1 — group stage (stage 0, 4×4 = 16 tiles), 6 revealed
    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count, status)
      VALUES (1, $1, 0, 11, $2, 6, 2, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['brazil'], revealedPrefix(16, 6)]);

    // Game 2 — semi-final (stage 5, 6×6 = 36 tiles), 20 revealed
    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count, status)
      VALUES (2, $1, 5, 32, $2, 20, 4, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['france'], revealedPrefix(36, 20)]);

    // Game 3 — knockout (stage 3, 5×5 = 25 tiles), 14 revealed
    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count, status)
      VALUES (3, $1, 3, 20, $2, 14, 6, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['argentina'], revealedPrefix(25, 14)]);

    // Sequence fixup so next insert gets id > 3
    await pool.query(`SELECT setval('games_id_seq', GREATEST((SELECT MAX(id) FROM games), 3))`);

    // Completed staging game — final (stage 6, 7×7 = 49 tiles), fully revealed
    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, status, winner_username, prize_paid, completed_at)
      VALUES (4, $1, 6, 40, $2, 18, 'completed', 'Staging Kaiser', 96, NOW())
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['germany'], new Array(49).fill(true)]);

    // Open final stage game with carry-over credits for refund testing
    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count, status)
      VALUES (5, $1, 6, 35, $2, 4, 1, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['belgium'], revealedPrefix(49, 4)]);

    // Add carry-over credits (8 remaining, 4 t/credit = 32 t refund potential) for the staging test user
    await pool.query(`
      INSERT INTO game_sessions (game_id, user_id, credits_total, credits_used, tokens_per_credit, refunded)
      VALUES (5, -1, 8, 0, 4, false)
      ON CONFLICT DO NOTHING
    `);

    await pool.query(`SELECT setval('games_id_seq', GREATEST((SELECT MAX(id) FROM games), 5))`);

    // Seed house wallet with 500 tokens for testing prize payouts in real token mode
    await pool.query(`
      UPDATE house_wallet SET balance = 500, last_synced_at = NOW() WHERE id = 1
    `);

  }

  console.log('[init] Database migrations completed, starting server...');
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
