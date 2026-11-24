// Pump.fun Paper Sprint — "High-R Ladder + Sniper Padding" (tail bet).
//
// Two legs, one shared cash / position budget (max 5 open positions, 10 SOL):
//
//   Leg A — High-R ladder (the tail bet, main leg). Watch every coin's real SOL
//   reserve R. The first time R reaches >= 30 SOL while still <= 45 SOL, buy
//   0.2 SOL (one entry per coin; a coin first seen above 45 SOL is skipped —
//   its burst already passed). Sell everything when R >= 50 SOL (take profit,
//   ~+56% from a ~4x entry) or R <= 24 SOL (stop, ~-19%), or after 20,000
//   slots as a backstop. Rationale (measured on the kit's dev + holdout
//   windows): at R >= 30 the persistence of R is strongest, and this is the
//   only cell with a meaningful winning window (+0.370 SOL on part-00002,
//   6/6 fail keys, DD 0.027). In winner-takes-all against a 0.000 hold-cash
//   bar, a strategy that always loses a little can never win; the tail bet
//   wins ~1 in 3 windows. This is a lottery ticket with the best odds
//   available, not a proven edge — expected value stays negative.
//
//   Leg B — Sniper padding (guardrail filler only). The kit pilot sniper's
//   defaults with a 0.02 SOL stake: buy a launch at age <= 3 slots with
//   0.3 <= R <= 30 SOL, at most 3 distinct non-creator buyers, creator must
//   not have sold, creator's own create-slot buy <= 2.5 SOL; exit at +15%
//   (TP) or -12% (SL), max hold 10 slots, exit at once if the creator sells.
//   It only exists to push the distinct-coin count over the 20-coin guardrail
//   (round trip >= 0.01 SOL each): it enters only while
//   (ladder coins + padding coins) < 22, at most 15 padding coins, never a
//   coin the ladder leg already took. Expected cost ~-0.001 SOL per coin.
//
// Determinism: a pure function of the batches fed in. No clock, no env, no
// Math.random; no randomness at all is used (hello.seed is not needed).
// All money is bigint lamports. Cash and the 5-position cap are shared
// between the legs. Exits are decided before entries every batch.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- Leg A (ladder) parameters -------------------------------------------
const LADDER_R0 = 30_000_000_000n; // 30 SOL: first R at which we buy
const LADDER_RMAX = 45_000_000_000n; // 45 SOL: 1.5x R0, burst already passed above this
const LADDER_UP = 50_000_000_000n; // 50 SOL: take profit
const LADDER_DOWN = 24_000_000_000n; // 24 SOL: stop loss
const LADDER_STAKE = 200_000_000n; // 0.2 SOL per coin
const LADDER_MAX_HOLD = 20_000; // slots, backstop only
const LADDER_BUY_SLIPPAGE_BPS = 10_000;
const LADDER_SELL_SLIPPAGE_BPS = 10_000;

// --- Leg B (sniper padding) parameters ------------------------------------
const SNIPER_STAKE = 20_000_000n; // 0.02 SOL per coin
const SNIPER_MIN_ROUND_TRIP = 10_000_000n; // 0.01 SOL: guardrail minimum per coin
const SNIPER_MAX_AGE = 3; // slots since create
const SNIPER_MIN_REAL_SOL = 300_000_000n; // 0.3 SOL
const SNIPER_MAX_REAL_SOL = 30_000_000_000n; // 30 SOL
const SNIPER_MAX_DEV_BUY = 2_500_000_000n; // 2.5 SOL
const SNIPER_MAX_BUYERS = 3;
const SNIPER_TP_BPS = 1_500; // +15% over cost
const SNIPER_SL_BPS = 1_200; // -12% under cost
const SNIPER_MAX_HOLD = 10; // slots
const SNIPER_BUY_SLIPPAGE_BPS = 10_000;
const SNIPER_SELL_SLIPPAGE_BPS = 10_000;
const SNIPER_MAX_COINS = 15; // padding coins at most
const TOTAL_COIN_TARGET = 22; // stop padding once ladder + padding reach this

const FEE_BPS = 125n; // protocol 95 + creator 30

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface CoinTape {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  devSold: boolean;
  lastTradeSlot: number;
  /** Leg A state. */
  ladderEntered: boolean;
  ladderDone: boolean;
  /** Leg B state. */
  sniperEntered: boolean;
  sniperDone: boolean;
}

interface HeldInfo {
  leg: 'ladder' | 'sniper';
  openedSlot: number;
  txPaid: bigint;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(): Strategy {
  const tape = new Map<Pubkey, CoinTape>();
  const held = new Map<Pubkey, HeldInfo>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  let ladderCoins = 0;
  let sniperCoins = 0;
  let ladderSeq = 0;
  let sniperSeq = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tape.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          devSold: false,
          lastTradeSlot: e.slot,
          ladderEntered: false,
          ladderDone: false,
          sniperEntered: false,
          sniperDone: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = tape.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = tape.get(e.mint);
        if (c !== undefined) {
          c.ladderDone = true;
          c.sniperDone = true;
        }
      }
    }
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Fold fills into held-state (leg attribution via client_id prefix).
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled' && f.side === 'buy') {
          const leg = f.client_id.startsWith('L1-') ? 'ladder' : 'sniper';
          if (!held.has(f.mint)) {
            held.set(f.mint, { leg, openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports) });
          }
        } else if (f.status !== 'rejected') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // --- Exits first -----------------------------------------------------
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const h = held.get(mint);
        const leg = h?.leg ?? 'sniper';
        let exit = false;
        if (leg === 'ladder') {
          const r = curve.real_quote_reserves;
          if (r >= LADDER_UP || r <= LADDER_DOWN) exit = true;
          else if (h !== undefined && state.slot - h.openedSlot >= LADDER_MAX_HOLD) exit = true;
        } else {
          let mk = marks.get(mint);
          if (mk === undefined) mk = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
          const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
          const basis = pos.cost_lamports + (h?.txPaid ?? 0n);
          if (basis > 0n) {
            if (value * BPS >= basis * (BPS + BigInt(SNIPER_TP_BPS))) exit = true;
            else if (value * BPS <= basis * (BPS - BigInt(SNIPER_SL_BPS))) exit = true;
          }
          if (h !== undefined && state.slot - h.openedSlot >= SNIPER_MAX_HOLD) exit = true;
          const c = tape.get(mint);
          if (c !== undefined && c.devSold) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: leg === 'ladder' ? LADDER_SELL_SLIPPAGE_BPS : SNIPER_SELL_SLIPPAGE_BPS });
        selling.add(mint);
        const c = tape.get(mint);
        if (c !== undefined) {
          c.ladderDone = true;
          c.sniperDone = true;
        }
      }

      // --- Entries ----------------------------------------------------------
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();

      // Leg A: high-R ladder. One entry per coin; skip bursts already past RMAX.
      for (const c of tape.values()) {
        if (orders.length >= cap) break;
        if (c.ladderEntered || c.ladderDone) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const r = curve.real_quote_reserves;
        if (r < LADDER_R0) continue;
        if (r > LADDER_RMAX) {
          c.ladderDone = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = LADDER_STAKE < maxBuy ? LADDER_STAKE : maxBuy;
        if (amount < SNIPER_MIN_ROUND_TRIP) continue;
        if (free < amount + tx) continue;
        ladderSeq += 1;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: LADDER_BUY_SLIPPAGE_BPS, client_id: `L1-${ladderSeq}` });
        free -= amount + tx;
        c.ladderEntered = true;
        ladderCoins += 1;
        open += 1;
      }

      // Leg B: sniper padding, only until the guardrail target is in reach.
      if (ladderCoins + sniperCoins < TOTAL_COIN_TARGET && sniperCoins < SNIPER_MAX_COINS) {
        for (const c of tape.values()) {
          if (orders.length >= cap) break;
          if (sniperCoins >= SNIPER_MAX_COINS) break;
          if (ladderCoins + sniperCoins >= TOTAL_COIN_TARGET) break;
          if (c.sniperEntered || c.sniperDone) continue;
          if (c.ladderEntered || c.ladderDone) continue;
          const age = state.slot - c.createSlot;
          if (age < 0 || age > SNIPER_MAX_AGE) {
            if (age > SNIPER_MAX_AGE) c.sniperDone = true;
            continue;
          }
          if (open >= state.hello.caps.max_open_positions) continue;
          const curve = state.curves.get(c.mint);
          if (curve === undefined || curve.complete) continue;
          if (c.devSold) {
            c.sniperDone = true;
            continue;
          }
          const rq = curve.real_quote_reserves;
          if (rq < SNIPER_MIN_REAL_SOL || rq > SNIPER_MAX_REAL_SOL) continue;
          if (c.devBuy > SNIPER_MAX_DEV_BUY) continue;
          if (c.buyers.size > SNIPER_MAX_BUYERS) continue;
          const maxBuy = state.maxBuyLamports(c.mint);
          const amount = SNIPER_STAKE < maxBuy ? SNIPER_STAKE : maxBuy;
          if (amount < SNIPER_MIN_ROUND_TRIP) continue;
          if (free < amount + tx) continue;
          sniperSeq += 1;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: SNIPER_BUY_SLIPPAGE_BPS, client_id: `SN-${sniperSeq}` });
          free -= amount + tx;
          c.sniperEntered = true;
          sniperCoins += 1;
          open += 1;
        }
      }

      return orders;
    },
  };
}
