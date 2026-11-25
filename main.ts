// Surge Sniper + Second-Dip Catcher — a pump.fun paper-trading bot for
// agent-fun/replay/v2.
//
// What the dev tape says (24h, 1,222 coins, 35 completions) and what ~20 offline
// rule variants measured on it:
//   - 61% of coins peak within 25 slots of their CreateEvent; most are already +10%
//     two slots after creation. The spike is immediate and it reverts — holding to
//     the end loses ~-17% per trade, and wide trailing stops give everything back.
//   - The one selection signal that separates winners: how many DISTINCT
//     wallets bought in a launch's first slots. Win rate rises monotonically
//     with the early buyer count (34% at >=1, 46% at >=5, 52.5% at >=6) and
//     per-coin EV turns positive at >=6 buyers — many independent buyers means
//     real crowd demand, while one or two buyers means a bundle waiting to dump.
//     Tight 500 bps buy slippage also helps: it refuses fills that already ran
//     away in the 2-slot latency instead of chasing them.
//   - The least-bad second family buys the retrace: a coin 10-300 slots old whose
//     price fell 20-50% from its running high while the last trade was a buy,
//     sold at +12% / -6% inside 60 slots: about -0.0006 SOL per coin. It exists
//     for breadth (the 20-coin guardrail) and is capped at 1 open slot so it
//     never crowds out the sniper family, which gets first claim on slots.
//   - Both families are near breakeven on this one dev window, so the bot is built
//     for the fresh final window, not tuned to the dev tape: broad (hundreds of
//     coins), small fixed stakes, hard stops everywhere, max drawdown far under the
//     50% guardrail.
//
// One real-bot lesson is baked in here: a sell can be rejected (a dumped curve's
// real SOL can drain below the sale's proceeds, or the 2% failed-tx rate bites),
// and a latch that marks a position "exiting" on send then never retries strands
// the position and its slot for the rest of the run. This bot therefore never
// latches exits — it re-decides every batch and only skips a coin while a sell is
// actually pending — and it sizes sells so their proceeds stay under 90% of the
// curve's real SOL, selling part of the position when the curve is drained.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no environment reads — so the two graded executions produce
// byte-identical action logs. Paper money only: the bot never touches a chain.
//
// Guardrails it is built to clear: at least 20 distinct mints with round trips of
// at least 0.01 SOL each, and max drawdown under 50% (small fixed stakes, at most
// 5 open positions, hard stops on every position).

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps on every curve trade
const BPS = 10_000;

// ---------------------------------------------------------------- sniper family
// The one selection signal that separates winners on the dev tape: how many
// DISTINCT wallets bought in the first slots. Win rate rises monotonically with
// the early buyer count (34% at >=1, 46% at >=5, 52.5% at >=6) and per-coin EV
// turns positive at >=6 buyers (+2.1 mSOL/coin) — many independent buyers means
// real crowd demand, while one or two buyers means a bundle waiting to dump.
// Tight 500 bps buy slippage also helps: it refuses fills that already ran away
// in the 2-slot latency instead of chasing them.
const SNIPER_MAX_AGE = 3; // slots since CreateEvent in which a first buy may be decided
const SNIPER_STAKE_SOL = 0.05;
const SNIPER_MIN_BUY_SOL = 0.01;
const SNIPER_MAX_REAL_SOL = 30;
const SNIPER_MAX_DEV_BUY_SOL = 2.5;
const SNIPER_MIN_BUYERS = 6;
const SNIPER_MAX_BUYERS = 12;
const SNIPER_MAX_SELL_RATIO_BPS = 5_000; // lamports sold by others / lamports bought
const SNIPER_MIN_RUNUP_BPS = -500;
const SNIPER_MAX_RUNUP_BPS = 4_000; // do not chase a launch that already spiked
const SNIPER_BUY_SLIP_BPS = 500; // refuse a buy whose price ran >5% in the latency
const SNIPER_TAKE_PROFIT = 0.12; // whole-sale take-profit
const SNIPER_STOP_LOSS = 0.12;
const SNIPER_MAX_HOLD = 30; // slots; the peak usually lands inside 25 of creation
const SNIPER_COOLDOWN = 150; // slots after an exit before the same coin may re-enter

// ---------------------------------------------------------------- dip family
// Second dip: a coin past its first spike, retraced 20-50% from its running high,
// with the last trade a buy (someone is catching it). One small 0.02 SOL tranche:
// this family loses a little per coin on the dev tape, and it is here for breadth
// — the 20-coin guardrail needs far more coins in a 6-hour final window than the
// rare sniper family alone can supply — so its stake is kept small on purpose.
const DIP_MIN_AGE = 10; // slots since CreateEvent
const DIP_MAX_AGE = 300;
const DIP_MIN_REAL_SOL = 1;
const DIP_DD_MIN = 0.20;
const DIP_DD_MAX = 0.50;
const DIP_STAKE_SOL = 0.02;
const DIP_MIN_BUY_SOL = 0.01;
const DIP_BUY_SLIP_BPS = 1_500;
const DIP_TAKE_PROFIT = 0.12;
const DIP_STOP_LOSS = 0.06;
const DIP_MAX_HOLD = 60; // slots for the bounce to develop
const DIP_COOLDOWN = 300; // slots after an exit before the same coin may re-enter
const DIP_MAX_OPEN = 1; // at most 1 dip position at once: dip entries must not crowd
// out the sniper family, whose coins are rarer and positive-EV on the dev tape

const SELL_SLIP_BPS = 10_000; // exits must always land
const SELL_PROCEEDS_CAP = 0.9; // a sell's proceeds stay under this share of real SOL

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  mint: Pubkey;
  created: number | null;
  creator: Pubkey | null;
  vq0: number;
  vt0: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  bought: number;
  soldByOthers: number;
  lastTradeSlot: number;
  lastExit: number;
  high: number; // running high price since creation
  recent: Tick[];
  done: boolean;
}

type Family = 'sniper' | 'dip';

interface Held {
  family: Family;
  opened: number;
  txPaid: number;
  devSoldAtOpen: boolean;
  filled: boolean; // a buy of this position filled
}

/** What selling `tokens` against (vq, vt) pays after curve fees, in SOL. */
function sellValueSol(tokens: number, vq: number, vt: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  const q = (tokens * vq) / (vt + tokens) / LAMPORTS;
  return q * (1 - CURVE_FEE);
}

/**
 * Tokens to sell so the proceeds stay under SELL_PROCEEDS_CAP of the curve's real
 * SOL: the harness rejects a sell whose proceeds exceed the real reserve, which
 * happens exactly when a dumped curve has drained. Selling part still counts as
 * progress, and the rest is retried next batch. All amounts here are raw lamports
 * (the token and quote reserves as the harness reports them); mixing in SOL-scale
 * units once produced dust-size sells that filled tens of thousands of times.
 */
function sellTokens(tokens: number, vq: number, vt: number, rqSol: number): bigint {
  const rq = rqSol * LAMPORTS; // real SOL reserve, lamports
  const target = (SELL_PROCEEDS_CAP * rq) / (1 - CURVE_FEE); // max proceeds, lamports
  if (vq <= target) return BigInt(Math.floor(tokens));
  const fit = (target * vt) / (vq - target);
  if (fit >= tokens) return BigInt(Math.floor(tokens));
  if (fit <= 0) return 0n;
  return BigInt(Math.floor(fit));
}

// -- State lives in module scope so it survives across batches. -------------------
const tapes = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();

function tapeOf(mint: Pubkey): Coin {
  let c = tapes.get(mint);
  if (c === undefined) {
    c = {
      mint,
      created: null,
      creator: null,
      vq0: 0,
      vt0: 1,
      devBuy: 0,
      devSold: false,
      buyers: new Set(),
      bought: 0,
      soldByOthers: 0,
      lastTradeSlot: -1,
      lastExit: -1e12,
      high: 0,
      recent: [],
      done: false,
    };
    tapes.set(mint, c);
  }
  return c;
}

function decide(state: BotState, batch: Batch, now: number): OrderInput[] {
  const traded = new Set<Pubkey>();

  // ---- fold the batch's events into the tapes --------------------------------
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const c = tapeOf(e.mint);
      c.created = e.slot;
      c.creator = e.creator;
      c.vq0 = Number(e.virtual_quote_reserves);
      c.vt0 = Number(e.virtual_token_reserves);
      c.lastTradeSlot = e.slot;
      const p0 = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (p0 > c.high) c.high = p0;
    } else if (e.event === 'TradeEvent') {
      const c = tapeOf(e.mint);
      const sol = Number(e.sol_amount) / LAMPORTS;
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
      if (price > c.high) c.high = price;
      c.lastTradeSlot = e.slot;
      traded.add(e.mint);
      const isDev = c.creator !== null && e.user === c.creator;
      if (e.is_buy) {
        c.bought += sol;
        if (isDev && e.slot === c.created) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
      }
    } else {
      const c = tapeOf(e.mint);
      c.done = true;
    }
  }
  // Prune tapes older than the longest lookback we use.
  const keepFrom = now - (DIP_MAX_AGE + 10);
  for (const mint of traded) {
    const c = tapes.get(mint)!;
    let cut = 0;
    while (cut < c.recent.length && c.recent[cut]!.slot <= keepFrom) cut++;
    if (cut > 0) c.recent.splice(0, cut);
  }

  // ---- fold the batch's fills into the held book ------------------------------
  for (const f of batch.fills) {
    if (f.client_id.startsWith('_')) {
      held.delete(f.mint);
      continue;
    }
    const h = held.get(f.mint);
    if (f.status === 'filled' && h !== undefined) {
      h.txPaid += Number(f.tx_fee_lamports) / LAMPORTS;
      if (f.side === 'buy') h.filled = true;
    }
    if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
      held.set(f.mint, { family: 'sniper', opened: f.slot, txPaid: Number(f.tx_fee_lamports) / LAMPORTS, devSoldAtOpen: false, filled: true });
    }
  }

  const orders: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const tx = Number(state.txFeeLamports()) / LAMPORTS;
  const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
  for (const po of state.pending.values()) {
    const p = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
    if (po.order.side === 'buy') p.buy = true;
    else p.sell = true;
    pendingByMint.set(po.order.mint, p);
  }

  // ---- exits first -------------------------------------------------------------
  // No latch: a position is re-decided every batch and skipped only while a sell
  // is actually pending, so a rejected or failed sell is retried next batch
  // instead of stranding the position and its slot.
  for (const [mint, pos] of state.positions) {
    if (orders.length >= cap) break;
    const h = held.get(mint);
    if (h === undefined) continue; // no book entry yet; the fill lands next batch
    if (pendingByMint.get(mint)?.sell) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    const tokens = Number(pos.token_amount);
    const value = sellValueSol(tokens, vq, vt) - tx;
    const basis = Number(pos.cost_lamports) / LAMPORTS + h.txPaid;
    if (basis <= 0) continue;
    const c = tapes.get(mint);
    let exit = false;
    if (h.family === 'sniper') {
      if (value >= basis * (1 + SNIPER_TAKE_PROFIT)) exit = true;
      if (!exit && value <= basis * (1 - SNIPER_STOP_LOSS)) exit = true;
      if (!exit && now - h.opened >= SNIPER_MAX_HOLD) exit = true;
    } else {
      if (value >= basis * (1 + DIP_TAKE_PROFIT)) exit = true;
      if (!exit && value <= basis * (1 - DIP_STOP_LOSS)) exit = true;
      if (!exit && now - h.opened >= DIP_MAX_HOLD) exit = true;
    }
    if (!exit) continue;
    const amount = sellTokens(tokens, vq, vt, rqSol);
    if (amount <= 0n) continue;
    // Never pay a tx fee to sell dust: if the sale is worth less than twice its
    // fee, leave the tokens for the harness to flatten/write off at the end.
    if (sellValueSol(Number(amount), vq, vt) < 2 * tx) continue;
    orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: SELL_SLIP_BPS });
  }

  // ---- entries ------------------------------------------------------------------
  let free = Number(state.freeCashLamports()) / LAMPORTS;
  let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
  let dipsOpen = 0;
  for (const h of held.values()) if (h.family === 'dip') dipsOpen++;

  // Two passes so the sniper family — rare, positive-EV coins — always gets first
  // claim on the 5 open slots each batch, and dip entries only take what is left.
  for (let pass = 0; pass < 2; pass++) {
  for (const mint of traded) {
    if (orders.length >= cap) break;
    if (slotsLeft <= 0) break;
    if (held.has(mint) || pendingByMint.has(mint)) continue;
    const c = tapes.get(mint)!;
    if (c.done) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
    const age = c.created === null ? 1e9 : now - c.created;

    let stake = 0;
    let slip = SNIPER_BUY_SLIP_BPS;
    let family: Family = 'sniper';
    let minBuy = SNIPER_MIN_BUY_SOL;

    if (age <= SNIPER_MAX_AGE) {
      if (pass !== 0) continue;
      // ---- sniper entry: fresh launch, rug filter ----
      // No minimum real SOL: the 1% size cap itself gates the buy (cap >= 0.01 SOL
      // needs real SOL >= 1), so the first buy lands on the earliest batch it can.
      if (rqSol > SNIPER_MAX_REAL_SOL) continue;
      if (c.devBuy > SNIPER_MAX_DEV_BUY_SOL) continue;
      if (c.devSold) continue;
      if (c.buyers.size < SNIPER_MIN_BUYERS || c.buyers.size > SNIPER_MAX_BUYERS) continue;
      if (c.bought > 0 && (c.soldByOthers / c.bought) * BPS > SNIPER_MAX_SELL_RATIO_BPS) continue;
      const runupBps = c.vq0 > 0 && c.vt0 > 0 ? ((price / (c.vq0 / c.vt0)) - 1) * BPS : 0;
      if (runupBps < SNIPER_MIN_RUNUP_BPS || runupBps > SNIPER_MAX_RUNUP_BPS) continue;
      if (now - c.lastExit < SNIPER_COOLDOWN) continue;
      stake = SNIPER_STAKE_SOL;
      family = 'sniper';
    } else if (age >= DIP_MIN_AGE && age <= DIP_MAX_AGE && dipsOpen < DIP_MAX_OPEN) {
      if (pass !== 1) continue;
      // ---- dip entry: retraced 20-50% from its running high, last trade a buy ----
      if (rqSol < DIP_MIN_REAL_SOL) continue;
      if (now - c.lastExit < DIP_COOLDOWN) continue;
      if (c.high <= 0) continue;
      const dd = 1 - price / c.high;
      if (dd < DIP_DD_MIN || dd > DIP_DD_MAX) continue;
      const last = c.recent[c.recent.length - 1];
      if (last === undefined || !last.buy) continue;
      stake = DIP_STAKE_SOL;
      slip = DIP_BUY_SLIP_BPS;
      family = 'dip';
      minBuy = DIP_MIN_BUY_SOL;
    } else {
      continue;
    }

    const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
    let amount = Math.min(capSol, stake);
    if (amount > free - tx) amount = free - tx;
    if (amount < minBuy) continue;
    const lamports = BigInt(Math.floor(amount * LAMPORTS));
    orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: slip });
    free -= amount + tx;
    slotsLeft--;
    if (family === 'dip') dipsOpen++;
    held.set(mint, { family, opened: now, txPaid: 0, devSoldAtOpen: c.devSold, filled: false });
  }
  }

  // ---- forget positions that are gone with nothing pending ----------------------
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint) && !pendingByMint.has(mint)) {
      const h = held.get(mint)!;
      const c = tapes.get(mint);
      if (h.filled) {
        // The position closed (sold, completed or flattened): cooldown starts.
        if (c !== undefined) c.lastExit = now;
        held.delete(mint);
      } else if (h.opened < now - 5) {
        held.delete(mint); // buy never landed; free the slot
      }
    }
  }
  return orders;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    return decide(state, batch, batch.slot);
  },
});
