const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const HOUSE_BONUS_TOKENS = 50;

const PUBLIC_API_PATHS = new Set(['/health', '/api/league', '/api/session', '/api/themes', '/api/captain-pot', '/api/env']);
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

// Per-stage shot pricing. Set so the house keeps ~12.5% (10-15% band) on a
// typical board regardless of grid size: smaller easy boards are found in
// fewer shots, so they cost more per shot; big hard boards cost less.
//   group 13 t/shot, knockout 8, semi 5.5, final 4
function pricingForStage(stageIdx) {
  let perShot;
  if (stageIdx <= 2) perShot = 13;
  else if (stageIdx <= 4) perShot = 8;
  else if (stageIdx === 5) perShot = 5.5;
  else perShot = 4;
  return { perShot, bundle2: perShot * 2, bundle8: perShot * 8, bundle16: perShot * 16 };
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
  return Math.max(8, Math.floor(150 / (1 + Math.exp(10.8 * (n / N - 0.4444)))));
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

// Local wallet helpers (platform wallet API not available in this environment)
async function ensureWallet(client, userId, username) {
  await client.query(`
    INSERT INTO player_wallets (user_id, username, balance)
    VALUES ($1, $2, 1000)
    ON CONFLICT (user_id) DO NOTHING
  `, [userId, username]);
}

async function getWalletBalance(client, userId) {
  const { rows } = await client.query(
    'SELECT balance FROM player_wallets WHERE user_id = $1', [userId]
  );
  return rows.length > 0 ? parseFloat(rows[0].balance) : 1000;
}

async function debitWallet(client, userId, amount) {
  const { rows } = await client.query(`
    UPDATE player_wallets SET balance = balance - $2
    WHERE user_id = $1 AND balance >= $2
    RETURNING balance
  `, [userId, amount]);
  if (!rows.length) throw new Error('Insufficient balance');
  return parseFloat(rows[0].balance);
}

async function creditWallet(client, userId, amount) {
  const { rows } = await client.query(`
    UPDATE player_wallets SET balance = balance + $2
    WHERE user_id = $1
    RETURNING balance
  `, [userId, amount]);
  return rows.length ? parseFloat(rows[0].balance) : null;
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
    await ensureWallet(client, req.user.id, req.user.username);

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
        (user_id, my_team_slug, stage_idx, played_slugs, total_tokens_won, session_complete, current_game_id, next_opponent_slug)
      VALUES ($1, $2, 0, '{}', 0, false, NULL, $3)
      ON CONFLICT (user_id) DO UPDATE SET
        my_team_slug = $2, stage_idx = 0, played_slugs = '{}',
        total_tokens_won = 0, session_complete = false,
        current_game_id = NULL, next_opponent_slug = $3, updated_at = NOW()
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

    // Carry over unused credits from the player's last won game into this new game.
    // Credits are not refunded on win — they roll forward as prepaid shots.
    const { rows: prevGameRows } = await client.query(`
      SELECT id FROM games
      WHERE winner_user_id = $1 AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `, [req.user.id]);
    if (prevGameRows.length) {
      const prevGameId = prevGameRows[0].id;
      const { rows: prevSessions } = await client.query(`
        SELECT id, (credits_total - credits_used) AS remaining, tokens_per_credit
        FROM game_sessions
        WHERE game_id = $1 AND user_id = $2 AND refunded = false AND credits_used < credits_total
      `, [prevGameId, req.user.id]);
      if (prevSessions.length) {
        const totalRemaining = prevSessions.reduce((s, r) => s + parseInt(r.remaining), 0);
        const totalValue = prevSessions.reduce((s, r) => s + parseInt(r.remaining) * parseFloat(r.tokens_per_credit), 0);
        const avgRate = (totalValue / totalRemaining).toFixed(2);
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
      await ensureWallet(client, req.user.id, req.user.username);
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
    const { rows: gameRows } = await client.query(
      'SELECT status, active_player_id, stage_idx FROM games WHERE id = $1', [req.params.id]
    );
    if (!gameRows.length) return res.status(404).json({ error: 'Game not found' });
    if (gameRows[0].status !== 'active') return res.status(409).json({ error: 'Game not active' });
    if (gameRows[0].active_player_id !== req.user.id) return res.status(403).json({ error: 'Not your game' });

    // Per-stage pricing: bundles prepay `bundle_size` shots at the stage rate.
    const { perShot } = pricingForStage(gameRows[0].stage_idx);
    const credits = bundle_size;
    const tokensPerCredit = perShot;
    const cost = perShot * bundle_size;

    await ensureWallet(client, req.user.id, req.user.username);
    const newBalance = await debitWallet(client, req.user.id, cost);

    const { rows: sessRows } = await client.query(`
      INSERT INTO game_sessions (game_id, user_id, credits_total, credits_used, tokens_per_credit)
      VALUES ($1, $2, $3, 0, $4)
      RETURNING id, credits_total, credits_used, tokens_per_credit
    `, [req.params.id, req.user.id, credits, tokensPerCredit]);

    res.json({ session: sessRows[0], wallet_balance: newBalance, credits_remaining: credits });
  } catch (err) {
    if (err.message === 'Insufficient balance') return res.status(402).json({ error: 'Insufficient balance' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/games/:id/guess
app.post('/api/games/:id/guess', async (req, res) => {
  const { square_index, session_id } = req.body;
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

    // Debit wallet for single guess (bundles pre-paid)
    if (!usedBundleId) {
      await ensureWallet(client, req.user.id, req.user.username);
      try {
        await debitWallet(client, req.user.id, tokensCharged);
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

      // Credit prize + jackpot
      await ensureWallet(client, req.user.id, req.user.username);
      await creditWallet(client, req.user.id, prizePaid + jackpotAmount);

      // Remaining bundle credits are NOT refunded — they carry over to the next game
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
          await creditWallet(client, req.user.id, houseBonus);
          wonThisRound += houseBonus;
        }

        const nextOpponentSlug = sessionComplete ? null : await pickNextOpponent(client, newPlayed, tour.my_team_slug);

        await client.query(`
          UPDATE tournament_sessions SET
            stage_idx = $1, played_slugs = $2,
            total_tokens_won = total_tokens_won + $3,
            session_complete = $4, current_game_id = NULL, next_opponent_slug = $6, updated_at = NOW()
          WHERE user_id = $5
        `, [updatedStage, newPlayed, wonThisRound, sessionComplete, req.user.id, nextOpponentSlug]);

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
      wallet_balance: walletBalance,
      stage_completed: stageCompleted,
      new_stage_idx: newStageIdx,
      interstitial,
      pot_topup: potTopup,
      pot_topup_message: potTopupMessage,
      opponent_slug: game.theme_slug,
      footballer_name: game.footballer_name
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
    await ensureWallet(client, req.user.id, req.user.username);
    const balance = await getWalletBalance(client, req.user.id);
    res.json({ balance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/env', (req, res) => {
  res.json({ staging: IS_STAGING });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const THEMES_SEED = [
  { slug: 'france',      country_name: 'France',      accent_colour: '#3b6dff', footballer_name: 'Zinedine Zidane' },
  { slug: 'brazil',      country_name: 'Brazil',      accent_colour: '#22c55e', footballer_name: 'Ronaldo Nazário' },
  { slug: 'england',     country_name: 'England',     accent_colour: '#e23b4e', footballer_name: 'David Beckham' },
  { slug: 'spain',       country_name: 'Spain',       accent_colour: '#f1bf00', footballer_name: 'Andrés Iniesta' },
  { slug: 'argentina',   country_name: 'Argentina',   accent_colour: '#74ACDF', footballer_name: 'Lionel Messi' },
  { slug: 'morocco',     country_name: 'Morocco',     accent_colour: '#1db954', footballer_name: 'Hakim Ziyech' },
  { slug: 'usa',         country_name: 'USA',         accent_colour: '#4f7bff', footballer_name: 'Landon Donovan' },
  { slug: 'turkey',      country_name: 'Turkey',      accent_colour: '#ff3b4e', footballer_name: 'Hakan Şükür' },
  { slug: 'belgium',     country_name: 'Belgium',     accent_colour: '#ffd23f', footballer_name: 'Eden Hazard' },
  { slug: 'egypt',       country_name: 'Egypt',       accent_colour: '#d4af37', footballer_name: 'Mohamed Salah' },
  { slug: 'portugal',    country_name: 'Portugal',    accent_colour: '#e23b3b', footballer_name: 'Cristiano Ronaldo' },
  { slug: 'netherlands', country_name: 'Netherlands', accent_colour: '#ff7a18', footballer_name: 'Johan Cruyff' },
  { slug: 'norway',      country_name: 'Norway',      accent_colour: '#4f7bff', footballer_name: 'Erling Haaland' },
  { slug: 'germany',     country_name: 'Germany',     accent_colour: '#ffce00', footballer_name: 'Franz Beckenbauer' },
  { slug: 'mexico',      country_name: 'Mexico',      accent_colour: '#006847', footballer_name: 'Hugo Sánchez' },
];

async function start() {
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
    balance NUMERIC(12,2) NOT NULL DEFAULT 1000
  )`);

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

  // ── Staging boot reset ────────────────────────────────────────────────────
  // Wipe all player/game rows on every staging boot so the seed below always
  // starts from a clean slate. Themes, captain_pot, and game_stats are kept.
  if (IS_STAGING) {
    await pool.query(`DELETE FROM guesses`);
    await pool.query(`DELETE FROM game_sessions`);
    await pool.query(`DELETE FROM games`);
    await pool.query(`DELETE FROM tournament_sessions`);
    await pool.query(`DELETE FROM player_stats`);
    await pool.query(`DELETE FROM player_wallets`);
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

    await pool.query(`SELECT setval('games_id_seq', GREATEST((SELECT MAX(id) FROM games), 4))`);

  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
