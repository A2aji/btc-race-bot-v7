"""Local search (hill climbing) on tranche schedules, evaluated with the
CORRECT BarsPool simulator (sim_correct). Starts from the exact-DP K=4
schedules (+$85.59). Only move: ADD a round trip (b,s) into a tranche
where it is flat. The candidate (b,s) may coincide with ANOTHER tranche's
sell bar (buy) or buy bar (sell) -- opposite-side sharing, whose pool
impact partly nets out in the true BarsPool model (a sell first lowers y,
so the later buy on the same bar pays a smaller factor). The per-tranche
DP cannot see this cross-tranche interaction, so it is the joint
optimisation gap. Candidates are scored by the correct simulator; the
best improving move is taken each round until no improvement.
"""
import copy, dp_v7, sim_correct

def flat_gaps(sched, N=1440):
    occ = sorted(sched)
    gaps = []
    prev_end = -1
    for (b, s) in occ:
        gaps.append((prev_end + 1, b))
        prev_end = s
    gaps.append((prev_end + 1, N - 1))
    return gaps

def candidate_adds(bars, schedules, k, thresh_bps=13.0, top_n=50):
    N = len(bars)
    opens = [b['o'] for b in bars]
    own_buy = {b for (b, s) in schedules[k]}
    own_sell = {s for (b, s) in schedules[k]}
    out = []
    for (lo, hi) in flat_gaps(schedules[k], N):
        for b in range(lo, min(hi, N - 2)):
            if b in own_buy:
                continue
            for s in range(b + 1, min(hi + 1, N - 1)):
                if s in own_sell:
                    continue
                gross_bps = (opens[s + 1] / opens[b + 1] - 1.0) * 10000
                if gross_bps > thresh_bps:
                    out.append((gross_bps, b, s))
    out.sort(reverse=True)
    return [(b, s) for (_, b, s) in out[:top_n]]

def local_search(bars, schedules, max_rounds=30, top_n=50):
    best = sim_correct.simulate_correct(bars, schedules)
    best_pnl = best['pnl_usd']
    print(f"start PnL ${best_pnl:+.2f} RT={best['roundtrips']} win={best['win_rate']:.2f}", flush=True)
    cur = copy.deepcopy(schedules)
    for rnd in range(max_rounds):
        best_move = None
        for k in range(len(cur)):
            for (b, s) in candidate_adds(bars, cur, k, top_n=top_n):
                trial = copy.deepcopy(cur)
                trial[k] = sorted(trial[k] + [(b, s)])
                r = sim_correct.simulate_correct(bars, trial)
                if r['pnl_usd'] > best_pnl + 1e-9:
                    if best_move is None or r['pnl_usd'] > best_move[0]:
                        best_move = (r['pnl_usd'], k, b, s)
        if best_move is None:
            print(f"round {rnd}: no improving ADD. stop.", flush=True)
            break
        pnl, k, b, s = best_move
        cur[k] = sorted(cur[k] + [(b, s)])
        best_pnl = pnl
        print(f"round {rnd}: ADD tranche {k} ({b},{s}) -> PnL ${pnl:+.2f}", flush=True)
    final = sim_correct.simulate_correct(bars, cur)
    print(f"final PnL ${final['pnl_usd']:+.2f} RT={final['roundtrips']} win={final['win_rate']:.2f} maxDD={final['max_dd_pct']:.2f}%", flush=True)
    return cur, final

if __name__ == '__main__':
    bars = dp_v7.load_dev_1444()
    schedules, per = dp_v7.run_tranches_exact(bars, 4)
    cur, final = local_search(bars, schedules, max_rounds=30, top_n=50)
    import json
    print("schedules:", json.dumps(cur))
