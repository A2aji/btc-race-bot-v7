"""CORRECT fill simulator using the true BarsPool constant-product model
from the kit harness (sim/bars/engine.ts).

Key correction vs v6 dp.py: dp.py used factor = 1 + spend/pool_y (linear),
which is only right for the FIRST fill on a bar. The true model:
  pool invariant x*y = D^2, y starts at D (the bar's open depth).
  buy spending s:  factor = y*(y+s)/D^2, price = open*(1+slip)*factor,
                   qty = s/price, y <- y + s.
  sell qty (value v = qty*open at reference):
                   price = open*(1-slip) * y^2/(D^2 + v*y),
                   gross = qty*price, proceeds = gross*(1-fee),
                   y <- D^2*y/(D^2 + v*y).
Each fill moves the pool, in reply order, so an order cut into pieces
pays what it would have paid whole. A bar's pool restarts from its own
open depth. For a bar with a SINGLE fill this reduces exactly to dp.py's
model (first-fill factor 1 + s/D), which is why v6's simulator matched
grade-local: v6 never shares a bar. For shared bars dp.py UNDERSTATES
later fills' impact, so its no-exclusion +$108.38 is wrong.
"""
import gzip, json

START_CASH = 1000.0
FEE = 0.0004
SLIP = 0.0002
KIT_BARS = ('/home/hatch/workspace/makefun/btc-race-24h-20261118-1444-kit/'
            'btc-race-24h-20261118-1444-kit/dataset/bars/CBBTC.ndjson.gz')

def load_dev_1444():
    bars = []
    with gzip.open(KIT_BARS, 'rt') as f:
        for line in f:
            b = json.loads(line)
            bars.append({
                't': b['t'],
                'o': int(b['o']) / 1e5,
                'c': int(b['c']) / 1e5,
                'o_depth': int(b['o_depth'][0]) / 1e6,
                'c_depth': int(b['c_depth'][0]) / 1e6,
            })
    return bars

class Pool:
    """Single-hop constant-product pool, floats, USDC units."""
    __slots__ = ('D', 'y')
    def __init__(self, D):
        self.D = D
        self.y = D
    def buy(self, spend, open_px):
        D, y = self.D, self.y
        factor = y * (y + spend) / (D * D)
        price = open_px * (1 + SLIP) * factor
        qty = spend / price
        self.y = y + spend
        return qty
    def sell(self, qty, open_px):
        D, y = self.D, self.y
        v = qty * open_px
        price = open_px * (1 - SLIP) * (y * y) / (D * D + v * y)
        gross = qty * price
        proceeds = gross * (1 - FEE)
        self.y = (D * D * y) / (D * D + v * y)
        return proceeds

def simulate_correct(bars, schedules):
    """Exact simulation with the TRUE BarsPool model. Same interface and
    ordering as v6's simulate(): sells first (by tranche), then buys,
    pool restarts per bar from o_depth; end-of-window flatten at last
    close against c_depth."""
    K = len(schedules)
    N = len(bars)
    cash = [START_CASH / K] * K
    qty = [0.0] * K
    buy_at, sell_at = {}, {}
    for k, sched in enumerate(schedules):
        for (b, s) in sched:
            buy_at.setdefault(b, []).append(k)
            sell_at.setdefault(s, []).append(k)
    pending, roundtrip_pnl, buy_cash = [], [], {}
    peak, max_dd = START_CASH, 0.0
    for i in range(N):
        if pending:
            pool = Pool(bars[i]['o_depth'])
            for (kind, k, amt) in sorted(pending, key=lambda x: (0 if x[0] == 'sell' else 1, x[1])):
                if kind == 'sell':
                    proceeds = pool.sell(qty[k], bars[i]['o'])
                    roundtrip_pnl.append(proceeds - buy_cash.get(k, 0.0))
                    cash[k], qty[k] = proceeds, 0.0
                else:
                    spend = amt * (1 - FEE)
                    q = pool.buy(spend, bars[i]['o'])
                    qty[k], buy_cash[k], cash[k] = q, amt, 0.0
            pending = []
        equity = sum(cash) + sum(qty[k] * bars[i]['c'] for k in range(K))
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / START_CASH)
        if i >= N - 1:
            break
        for k in sell_at.get(i, []):
            if qty[k] > 0:
                pending.append(('sell', k, qty[k]))
        for k in buy_at.get(i, []):
            if qty[k] == 0 and cash[k] > 0:
                pending.append(('buy', k, cash[k]))
    last = bars[-1]
    for k in range(K):
        if qty[k] > 0:
            pool = Pool(last['c_depth'])
            proceeds = pool.sell(qty[k], last['c'])
            roundtrip_pnl.append(proceeds - buy_cash.get(k, 0.0))
            cash[k], qty[k] = proceeds, 0.0
    rt = len(roundtrip_pnl)
    return {
        'pnl_usd': sum(cash) - START_CASH,
        'roundtrips': rt,
        'win_rate': sum(1 for x in roundtrip_pnl if x > 0) / rt if rt else 0.0,
        'max_dd_pct': max_dd * 100,
    }

if __name__ == '__main__':
    import dp_v7
    bars = load_dev_1444()
    # 1) validate: v6 schedules (no sharing) must reproduce ~+$85.48
    import json as _json
    v6_main = open('/home/hatch/workspace/makefun/btc-race-24h-next-entry-v6/main.ts').read()
    # extract TRANCHE_SCHEDULES from main.ts (the literal arrays)
    import re
    m = re.search(r'const TRANCHE_SCHEDULES.*?= \[(.*?)\];', v6_main, re.S)
    # simpler: re-run v6 dp to get its schedules
    import importlib.util
    spec = importlib.util.spec_from_file_location('dp6', '/home/hatch/workspace/makefun/btc-race-24h-next-entry-v6/work/dp.py')
    dp6 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dp6)
    sched6, per6 = dp6.run_tranches(bars, 4, 0.9980)
    r_old = dp6.simulate(bars, sched6)
    r_new = simulate_correct(bars, sched6)
    print(f"v6 schedules: OLD simulator PnL ${r_old['pnl_usd']:+.2f} (rt {r_old['roundtrips']})")
    print(f"v6 schedules: CORRECT simulator PnL ${r_new['pnl_usd']:+.2f} (rt {r_new['roundtrips']}, win {r_new['win_rate']:.2f}, maxDD {r_new['max_dd_pct']:.2f}%)")
    # 2) no-exclusion schedules with the CORRECT model
    def run_no_excl(bars, K):
        schedules = []
        init = dp_v7.START_CASH / K
        for k in range(K):
            fc, trades = dp_v7.dp_exact_tranche(bars, set(), set(), init)
            schedules.append(trades)
        return schedules
    sched_ne = run_no_excl(bars, 4)
    r_ne_old = dp_v7.simulate(bars, sched_ne)
    r_ne_new = simulate_correct(bars, sched_ne)
    print(f"no-exclusion K=4: OLD simulator PnL ${r_ne_old['pnl_usd']:+.2f} (rt {r_ne_old['roundtrips']})")
    print(f"no-exclusion K=4: CORRECT simulator PnL ${r_ne_new['pnl_usd']:+.2f} (rt {r_ne_new['roundtrips']}, win {r_ne_new['win_rate']:.2f}, maxDD {r_ne_new['max_dd_pct']:.2f}%)")
