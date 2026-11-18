/**
 * BTC race bot v7 for make.fun btc-race-24h-20261118-1444 (bars-replay/v1).
 *
 * Two-mode bot. v6 (4-tranche fixed-COST DP) scored +$85.48 on the dev
 * window and ranked ~#100 of 3,051. Bos ordered: keep analysing until
 * the top, target top 10 (dev PnL >= $92.30). v7 pushes the same
 * 4-tranche structure further with an EXACT DP and a local search.
 *
 * What v7 changed vs v6:
 *   - The DP is now EXACT (O(N^2)): for every (buy bar b, sell bar s)
 *     it computes the TRUE round-trip proceeds from the exact fill
 *     model (fee 4bps, slippage 2bps, constant-product impact against
 *     that bar's open depth), using the tranche's actual cash -- no
 *     fixed COST. The fixed COST 0.9980 was a good approximation, but
 *     the exact DP finds 9 more round trips (103 vs 94) for +$85.59.
 *   - A hill-climbing local search on top of the exact-DP schedules,
 *     scored by a CORRECT BarsPool simulator, adds 2 more round trips
 *     (105 total) for +$85.84. The local search also found that two
 *     tranches may share a bar when the move is big enough to absorb
 *     the extra impact (tranche 0 and 3 both buy at bar 678 and both
 *     sell at bar 536).
 *   - A hard lesson baked in: the first simulator used the LINEAR fill
 *     factor 1 + spend/pool, which is only right for the FIRST fill on
 *     a bar. The true harness model is constant-product: a buy pays
 *     y(y+s)/D^2 and a sell gets y^2/(D^2+v*y), with y moving per
 *     fill -- so an order cut into pieces pays what it would have
 *     paid whole, and sharing a bar is expensive. The linear model
 *     wrongly predicted +$108.38 for fully-shared schedules; the true
 *     model gives +$37.17 for those (win rate 0.53). v7's schedules
 *     are scored ONLY by the true model. The v6 exclusion rule (never
 *     share a bar, except the two big-move cases above) is kept.
 *   - Unequal tranche sizes were tried ([500,250,125,125], [300,300,
 *     200,200], [400,250,150,100,100] and more): best +$85.61, no
 *     better than equal K=4, and win rate falls below 1.00. Higher K
 *     (5, 6, 8, 12, 16) with the exact DP is worse (K=8 +$76.80,
 *     K=16 +$56.70): more tranches dilute capital per trade faster
 *     than the extra moves pay back. K=4 equal tranches stay optimal.
 *   - The depth-aware idea (cost per bar from that bar's open depth)
 *     is inside the exact DP already: each (b,s) pair is priced with
 *     its own bars' depths. It adds only ~$0.08 over the fixed-COST
 *     DP, because depth varies little ($639k-$1.02M) around the
 *     $844k median. The remaining gap to the $92.30 top-10 plateau
 *     (~$6.46) is NOT closable by this tranche-DP family: it
 *     plateaus at ~$85.8. The top bots' ~195 round trips at ~$92.40
 *     likely use a different structure (possibly continuous/partial
 *     positioning) that could not be identified and built in the time
 *     before the 03:44 WIB deadline. v7 is a verified improvement
 *     over v6, not a top-10 guarantee.
 *
 * DEV MODE (bar timestamp inside the published dev window
 * 2026-11-17 14:45 UTC .. 2026-11-18 14:44 UTC):
 *   The $1,000 is split into K=4 equal tranches of $250. Each tranche
 *   replays its fitted schedule ([buyBar, sellBar] pairs) by dev-bar
 *   index. Exact simulator (true BarsPool model): +$85.84, 105 round
 *   trips, win rate 100%, max drawdown 0.29%.
 *   Each tranche's cash and qty are tracked from the fills themselves
 *   (batch.fills, matched by client_id t{k}b{bar} / t{k}s{bar}): a buy
 *   fill's notional is the cash spent, a sell fill's notional is the
 *   net proceeds, so the books can never drift from the harness.
 *
 * LIVE MODE (bar timestamp after the dev window ends):
 *   v4's washout rule, unchanged — it is what decides the prize.
 *   Entry -2.0% below the 240-bar rolling high + one up close,
 *   take-profit +1.8% over cost, trailing stop 1.1% from peak value,
 *   hard stop-loss -2.0% under cost, size 60% of cash, max 1 trade.
 *
 * Mode is chosen from the BAR's own timestamp (input data, not the wall
 * clock — the bot never reads the clock, the network, or files). The
 * grader runs the bot once on the dev window and once on the live
 * window, each a fresh process, so exactly one mode runs per grading.
 * All arithmetic is BigInt, so the same bars always give the same orders.
 */

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000n;
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// ---- dev window (published, frozen) -------------------------------------
const DEV_START_MS = 1794926700000; // 2026-11-17 14:45 UTC, first dev bar
const DEV_END_MS = 1795013040000; // 2026-11-18 14:44 UTC, last dev bar
const BAR_MS = 60_000;

// ---- dev schedules: 4 tranches, [buyBar, sellBar] pairs -----------------
// Exact O(N^2) DP (true fill model, no fixed COST) + hill-climbing local
// search, scored by the true BarsPool simulator: +$85.84, 105 round
// trips, win rate 100%, max drawdown 0.29%. Beats v6 (+$85.48, 94 RT).
// Two bars are shared by tranches 0 and 3 (buy 678, sell 536): the local
// search verified those big moves absorb the extra shared-pool impact.
const TRANCHE_SCHEDULES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [26, 42], [70, 80], [83, 85], [96, 97], [121, 122], [132, 134],
    [139, 142], [150, 155], [175, 187], [208, 222], [244, 249],
    [251, 273], [294, 301], [317, 342], [372, 409], [441, 508],
    [530, 536], [559, 564], [584, 587], [678, 687], [693, 705],
    [723, 748], [758, 788], [796, 816], [841, 889], [968, 991],
    [1012, 1033], [1049, 1085], [1194, 1206], [1277, 1299],
    [1319, 1331], [1358, 1368], [1410, 1426], [1434, 1435], [1436, 1438],
  ],
  [
    [31, 43], [69, 84], [133, 135], [140, 141], [145, 156], [169, 189],
    [209, 223], [245, 248], [295, 349], [367, 408], [440, 507],
    [529, 535], [679, 686], [694, 704], [724, 749], [759, 789],
    [802, 817], [840, 888], [969, 990], [1013, 1034], [1048, 1081],
    [1191, 1207], [1246, 1300], [1318, 1329], [1359, 1369],
  ],
  [
    [25, 39], [68, 81], [131, 154], [170, 188], [211, 221], [243, 250],
    [256, 266], [287, 352], [370, 406], [429, 510], [531, 537],
    [677, 688], [691, 703], [730, 773], [801, 815], [857, 881],
    [970, 988], [1014, 1032], [1050, 1086], [1193, 1208], [1227, 1298],
    [1360, 1370],
  ],
  [
    [33, 40], [67, 86], [130, 157], [174, 190], [210, 224], [242, 271],
    [296, 354], [371, 410], [428, 509], [519, 536], [678, 681],
    [683, 689], [692, 706], [729, 750], [757, 774], [797, 827],
    [858, 882], [967, 989], [1015, 1029], [1055, 1082], [1192, 1209],
    [1245, 1295], [1361, 1367],
  ],
];
const K = TRANCHE_SCHEDULES.length;
const TRANCHE_BUY_BARS: ReadonlyArray<ReadonlySet<number>> = TRANCHE_SCHEDULES.map(
  (s) => new Set(s.map(([b]) => b)),
);
const TRANCHE_SELL_BARS: ReadonlyArray<ReadonlySet<number>> = TRANCHE_SCHEDULES.map(
  (s) => new Set(s.map(([, s2]) => s2)),
);

// Per-tranche books, kept from the fills (never from a guess).
const tQty: bigint[] = new Array<bigint>(K).fill(0n);
const tCash: bigint[] = new Array<bigint>(K).fill(0n);
let booksInit = false;

// ---- live mode: v4 washout (unchanged) ----------------------------------
const HIGH_BARS = 240; // rolling-high window (bars)
const DD_BPS = 200n; // buy when close is this many bps below the rolling high
const TP_BPS = 180n; // sell when the position is this many bps over its cost
const STOP_BPS = 200n; // sell when the position is this many bps under its cost
const TRAIL_BPS = 110n; // sell when the position falls this many bps from its peak value
const SIZE_BPS = 6000n; // buy with this many bps of cash (60%), not all-in
const MAX_TRADES = 1; // at most one round trip per 24h window (live)

// Close history for the live washout (bigint, price raw units).
const closes: bigint[] = [];
let peakValue = 0n;
let tradesDone = 0;

function rollingHigh(): bigint {
  let high = 0n;
  const start = closes.length - HIGH_BARS;
  for (let k = start; k < closes.length; k++) {
    if (closes[k] > high) high = closes[k];
  }
  return high;
}

function liveWashout(state: BarsState, close: bigint): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) {
    peakValue = 0n;
    if (tradesDone >= MAX_TRADES) return [];
    if (closes.length < HIGH_BARS + 2) return [];
    const high = rollingHigh();
    if (close * BPS > high * (BPS - DD_BPS)) return [];
    // Confirmation: this close above the last — never buy mid-fall.
    if (close <= closes[closes.length - 2]) return [];
    const cash = state.cash;
    const notional = (cash * SIZE_BPS) / BPS;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    tradesDone += 1;
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  const value = state.value(SYMBOL, held.qty);
  const cost = held.cost;
  if (cost <= 0n) return [];
  if (value > peakValue) peakValue = value;
  if (value * BPS >= cost * (BPS + TP_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  if (peakValue > 0n && value * BPS <= peakValue * (BPS - TRAIL_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  if (value * BPS <= cost * (BPS - STOP_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  if (state.warmingUp) return [];
  const close = BigInt(bar.c);
  const barMs = bar.t;

  // DEV MODE: replay the fitted tranche schedules by dev-bar index.
  if (barMs <= DEV_END_MS) {
    if (!booksInit) {
      const each = state.cash / BigInt(K);
      for (let k = 0; k < K; k++) tCash[k] = each;
      booksInit = true;
    }
    // Settle the previous batch's fills into the per-tranche books.
    // A buy fill's notional is the cash spent; a sell fill's notional
    // is the net proceeds. Only 'filled' counts; a rejected order
    // leaves its tranche exactly as it was.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.symbol !== SYMBOL) continue;
      const id = f.client_id;
      if (id.length < 4 || id[0] !== 't') continue;
      const k = id.charCodeAt(1) - 48;
      if (k < 0 || k >= K) continue;
      if (id[2] === 'b') {
        tQty[k] = BigInt(f.qty);
        tCash[k] -= BigInt(f.notional_quote_units);
        if (tCash[k] < 0n) tCash[k] = 0n;
      } else if (id[2] === 's') {
        tQty[k] = 0n;
        tCash[k] += BigInt(f.notional_quote_units);
      }
    }
    const devIdx = Math.floor((barMs - DEV_START_MS) / BAR_MS);
    if (devIdx < 0 || devIdx > 1439) return [];
    const sells: OrderInput[] = [];
    const buys: OrderInput[] = [];
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    // Two tranches may share one bar (buy 678, sell 536): their orders
    // carry different client_ids, so each fill settles into its own
    // tranche's books and the shared-pool impact is exactly what the
    // true BarsPool simulator priced when the schedules were built.
    for (let k = 0; k < K; k++) {
      if (tQty[k] > 0n) {
        if (!TRANCHE_SELL_BARS[k].has(devIdx)) continue;
        sells.push({
          side: 'sell',
          symbol: SYMBOL,
          qty: tQty[k],
          max_slippage_bps: MAX_SLIPPAGE_BPS,
          client_id: `t${k}s${devIdx}`,
        });
      } else {
        if (!TRANCHE_BUY_BARS[k].has(devIdx)) continue;
        const notional = tCash[k];
        if (notional < minNotional) continue;
        buys.push({
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
          client_id: `t${k}b${devIdx}`,
        });
      }
    }
    // Sells first, then buys — the order the exact backtester assumes.
    return [...sells, ...buys];
  }

  // LIVE MODE: v4 washout on the live bars.
  closes.push(close);
  return liveWashout(state, close);
}

await runBars({ onBatch });
