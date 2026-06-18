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

const PUBLIC_API_PATHS = new Set(['/health', '/api/league']);
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
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

// Prize decay formula: prize(n) = max(8, floor(150 / (1 + e^(0.12*(n-40)))))
function prizeDecay(n) {
  return Math.max(8, Math.floor(150 / (1 + Math.exp(0.12 * (n - 40)))));
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

    const { rows: potRows } = await client.query('SELECT balance FROM captain_pot WHERE id = 1');
    const potBalance = potRows.length ? parseFloat(potRows[0].balance) : 100;
    const walletBalance = await getWalletBalance(client, req.user.id);

    res.json({ session, captain_pot_balance: potBalance, wallet_balance: walletBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/session
app.post('/api/session', async (req, res) => {
  const { my_team_slug } = req.body;
  if (!my_team_slug) return res.status(400).json({ error: 'my_team_slug required' });

  const client = await pool.connect();
  try {
    const { rows: themeCheck } = await client.query(
      'SELECT id FROM themes WHERE slug = $1', [my_team_slug]
    );
    if (!themeCheck.length) return res.status(400).json({ error: 'Invalid slug' });

    const { rows } = await client.query(`
      INSERT INTO tournament_sessions
        (user_id, my_team_slug, stage_idx, played_slugs, total_tokens_won, session_complete, current_game_id)
      VALUES ($1, $2, 0, '{}', 0, false, NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        my_team_slug = $2, stage_idx = 0, played_slugs = '{}',
        total_tokens_won = 0, session_complete = false,
        current_game_id = NULL, updated_at = NOW()
      RETURNING *
    `, [req.user.id, my_team_slug]);

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
      prize_pot: prizeDecay(g.total_guesses)
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

    const playedSlugs = session.played_slugs || [];
    const excludeSlugs = [...playedSlugs, session.my_team_slug];

    const { rows: themeRows } = await client.query(
      'SELECT id, slug, country_name, accent_colour, footballer_name FROM themes WHERE slug != ALL($1)',
      [excludeSlugs]
    );
    if (!themeRows.length) return res.status(400).json({ error: 'No opponents available' });

    const theme = themeRows[Math.floor(Math.random() * themeRows.length)];
    const footballSquare = Math.floor(Math.random() * 64);
    const revealed = new Array(64).fill(false);

    const { rows: gameRows } = await client.query(`
      INSERT INTO games
        (theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count,
         status, active_player_id, active_player_username, last_active_at)
      VALUES ($1, $2, $3, $4, 0, 0, 'active', $5, $6, NOW())
      RETURNING id, theme_id, stage_idx, revealed, total_guesses, total_players_count, status
    `, [theme.id, session.stage_idx, footballSquare, revealed, req.user.id, req.user.username]);

    const game = gameRows[0];

    await client.query(
      'UPDATE tournament_sessions SET current_game_id = $1, updated_at = NOW() WHERE user_id = $2',
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

    const { rows: credRows } = await client.query(`
      SELECT id, credits_total, credits_used, tokens_per_credit,
             (credits_total - credits_used) as credits_remaining
      FROM game_sessions
      WHERE game_id = $1 AND user_id = $2 AND refunded = false
        AND credits_used < credits_total
      ORDER BY created_at DESC LIMIT 1
    `, [game.id, req.user.id]);

    const { rows: potRows } = await client.query(
      'SELECT balance, last_won_at, last_winner_username FROM captain_pot WHERE id = 1'
    );
    const potData = potRows[0] || { balance: 100, last_won_at: null, last_winner_username: null };

    await ensureWallet(client, req.user.id, req.user.username);
    const walletBalance = await getWalletBalance(client, req.user.id);

    const squaresRevealed = (game.revealed || []).filter(Boolean).length;
    const prizePot = prizeDecay(squaresRevealed);

    res.json({
      game,
      credits: credRows[0] || null,
      captain_pot_balance: parseFloat(potData.balance),
      last_won_at: potData.last_won_at,
      last_winner_username: potData.last_winner_username,
      wallet_balance: walletBalance,
      prize_pot: prizePot,
      squares_revealed: squaresRevealed
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
  let credits, cost, tokensPerCredit;
  if (bundle_size === 8) { credits = 8; cost = 36; tokensPerCredit = 4.5; }
  else if (bundle_size === 16) { credits = 16; cost = 64; tokensPerCredit = 4.0; }
  else return res.status(400).json({ error: 'bundle_size must be 8 or 16' });

  const client = await pool.connect();
  try {
    const { rows: gameRows } = await client.query(
      'SELECT status, active_player_id FROM games WHERE id = $1', [req.params.id]
    );
    if (!gameRows.length) return res.status(404).json({ error: 'Game not found' });
    if (gameRows[0].status !== 'active') return res.status(409).json({ error: 'Game not active' });
    if (gameRows[0].active_player_id !== req.user.id) return res.status(403).json({ error: 'Not your game' });

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
  if (square_index === undefined || square_index < 0 || square_index > 63) {
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

    // Determine cost — check for active bundle session
    let tokensCharged = 5.0;
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

    if (isHit) {
      prizePaid = prizeDecay(squaresRevealedBefore);

      let jackpotAmount = 0;
      if (jackpotEligible) {
        const { rows: potRows } = await client.query(
          'SELECT balance FROM captain_pot WHERE id = 1 FOR UPDATE'
        );
        jackpotAmount = parseFloat(potRows[0].balance);
        jackpotPaid = jackpotAmount;
        await client.query(`
          UPDATE captain_pot SET balance = 100, last_won_at = NOW(),
            last_winner_id = $1, last_winner_username = $2
          WHERE id = 1
        `, [req.user.id, req.user.username]);
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

      // Refund remaining bundle credits (winner's own sessions)
      const { rows: refundRows } = await client.query(`
        UPDATE game_sessions SET refunded = true
        WHERE game_id = $1 AND user_id = $2 AND refunded = false AND credits_used < credits_total
        RETURNING (credits_total - credits_used) * tokens_per_credit AS refund_amount
      `, [game.id, req.user.id]);
      if (refundRows.length) {
        creditsRefunded = refundRows.reduce((s, r) => s + parseFloat(r.refund_amount), 0);
        await creditWallet(client, req.user.id, creditsRefunded);
      }

      // Advance tournament session
      const { rows: tourRows } = await client.query(
        'SELECT * FROM tournament_sessions WHERE user_id = $1 FOR UPDATE', [req.user.id]
      );
      const tour = tourRows[0];
      if (tour) {
        const newPlayed = [...(tour.played_slugs || []), game.theme_slug];
        const updatedStage = tour.stage_idx + 1;
        const sessionComplete = updatedStage >= 8;

        newStageIdx = updatedStage;
        stageCompleted = true;

        let wonThisRound = prizePaid + jackpotAmount;
        if (sessionComplete) {
          houseBonus = HOUSE_BONUS_TOKENS;
          await creditWallet(client, req.user.id, houseBonus);
          wonThisRound += houseBonus;
        }

        await client.query(`
          UPDATE tournament_sessions SET
            stage_idx = $1, played_slugs = $2,
            total_tokens_won = total_tokens_won + $3,
            session_complete = $4, current_game_id = NULL, updated_at = NOW()
          WHERE user_id = $5
        `, [updatedStage, newPlayed, wonThisRound, sessionComplete, req.user.id]);

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
      }
    }

    await client.query('COMMIT');

    const { rows: potRows } = await client.query('SELECT balance FROM captain_pot WHERE id = 1');
    const potBalance = potRows.length ? parseFloat(potRows[0].balance) : 100;
    const walletBalance = await getWalletBalance(client, req.user.id);

    res.json({
      hit: isHit,
      square_index,
      prize_paid: prizePaid,
      jackpot_paid: jackpotPaid,
      credits_refunded: creditsRefunded,
      house_bonus: houseBonus,
      squares_revealed: game.total_guesses + 1,
      pot_balance: potBalance,
      wallet_balance: walletBalance,
      stage_completed: stageCompleted,
      new_stage_idx: newStageIdx,
      interstitial,
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

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
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

  // ── Staging seed data ─────────────────────────────────────────────────────
  if (IS_STAGING) {
    // Override captain pot and game stats with more interesting values
    await pool.query(`UPDATE captain_pot SET balance = 347.00 WHERE id = 1`);
    await pool.query(`UPDATE game_stats SET total_tokens_collected = 8420.00 WHERE id = 1`);

    // Staging player wallets with generous starting balance
    for (let i = 1; i <= 5; i++) {
      await pool.query(`
        INSERT INTO player_wallets (user_id, username, balance)
        VALUES ($1, $2, 5000)
        ON CONFLICT (user_id) DO NOTHING
      `, [-i, `staging-player-${i}`]);
    }

    // player_stats rows for league display
    const stagingPlayers = [
      { id: -1, username: 'Staging Player 1', display_name: 'Staging Player 1', won: 842, sessions: 3 },
      { id: -2, username: 'Staging Player 2', display_name: 'Staging Player 2', won: 617, sessions: 2 },
      { id: -3, username: 'Staging Player 3', display_name: 'Staging Player 3', won: 490, sessions: 1 },
      { id: -4, username: 'Staging Kaiser',   display_name: 'Staging Kaiser',   won: 380, sessions: 1 },
      { id: -5, username: 'Staging Demo',     display_name: 'Staging Demo',     won: 210, sessions: 0 },
    ];
    for (const p of stagingPlayers) {
      await pool.query(`
        INSERT INTO player_stats (user_id, username, display_name, total_tokens_won, sessions_completed)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO NOTHING
      `, [p.id, p.username, p.display_name, p.won, p.sessions]);
    }

    // 3 open staging game boards
    // We need theme IDs — fetch them
    const { rows: themeRows } = await pool.query('SELECT id, slug FROM themes');
    const themeMap = Object.fromEntries(themeRows.map(t => [t.slug, t.id]));

    const revealed8 = new Array(64).fill(false);
    for (let i = 0; i < 8; i++) revealed8[i] = true;
    const revealed31 = new Array(64).fill(false);
    for (let i = 0; i < 31; i++) revealed31[i] = true;
    const revealed51 = new Array(64).fill(false);
    for (let i = 0; i < 51; i++) revealed51[i] = true;

    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count, status)
      VALUES (1, $1, 0, 40, $2, 8, 2, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['brazil'], revealed8]);

    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count, status)
      VALUES (2, $1, 5, 55, $2, 31, 4, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['france'], revealed31]);

    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, total_players_count, status)
      VALUES (3, $1, 3, 20, $2, 51, 6, 'open')
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['argentina'], revealed51]);

    // Sequence fixup so next insert gets id > 3
    await pool.query(`SELECT setval('games_id_seq', GREATEST((SELECT MAX(id) FROM games), 3))`);

    // Completed staging game
    await pool.query(`
      INSERT INTO games (id, theme_id, stage_idx, football_square, revealed, total_guesses, status, winner_username, prize_paid, completed_at)
      VALUES (4, $1, 6, 32, $2, 45, 'completed', 'Staging Kaiser', 136, NOW())
      ON CONFLICT (id) DO NOTHING
    `, [themeMap['germany'], new Array(64).fill(true)]);

    await pool.query(`SELECT setval('games_id_seq', GREATEST((SELECT MAX(id) FROM games), 4))`);

    // Tournament session for staging player -1
    await pool.query(`
      INSERT INTO tournament_sessions (user_id, my_team_slug, stage_idx, played_slugs, session_complete, current_game_id)
      VALUES (-1, 'england', 3, '{brazil,france,germany}', false, NULL)
      ON CONFLICT (user_id) DO NOTHING
    `);
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
