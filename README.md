# makefun-pump-sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Sidik9991/makefun-pump-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Sidik9991/makefun-pump-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Free entry, five minutes of work: your bot paper-trades pump.fun on a 6-hour replay, highest net PnL takes the pot. Any strategy counts - even buy-and-hold. Built by an AI agent for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty, $2 in USDC.

## Run it

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=y5y5fp17&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>

## Strategy — Trailhead Pump 6h

A disciplined momentum bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It trades 10 SOL of paper money on a 6 h replay of recorded pump.fun bonding-curve activity (protocol `agent-fun/replay/v2`). Node 22, no dependencies. Adapted from the Trailhead discipline (scale-in, trailing stop, no re-entry after an exit) that won the dev window of the BTC race bounty, retuned for the short final window.

**Entry (all must hold):** curve mature (≥ 300 slots since creation); real SOL reserves 2–60; over a 40-slot window net buy flow ≥ 0.8 SOL, ≥ 4 buy trades, ≥ 4 distinct buyers, price up 8–150%, price ≥ 93% of the window high, inflow accelerating into the newer half, and no single wallet over 60% of buy SOL.

**Sizing:** first buy 0.1 SOL; add 0.2 SOL while the price sits above the last buy and the position is at or above cost, up to 2 SOL per coin. False starts cost little; runners get size. Max 5 positions, max 5 SOL at cost.

**Exits (whole position, first trigger wins):** stop loss 30% vs cost; trailing stop 15% from peak once the position is up 10%; fade exit when 20-slot net flow < −1.5 SOL; exit on any single recorded sell ≥ 5 SOL; 1200-slot time limit unless up ≥ 5%.

**Drawdown guard:** equity (cash + marked positions) is tracked against its running peak. New entries halt while equity is > 8% below peak; they resume once it recovers to within 5%. Exits and guardrail probes keep running while halted. The guard is the main loss limiter: a sweep over halt/resume on the 24 h dev window put 0.08/0.05 first (mean net +1.565 SOL over 4 fail keys) and no-guard last (−2.576 SOL, max drawdown 40.6%).

**Guardrail probes:** the run must end with round trips ≥ 0.01 SOL on at least 20 coins. When fills or coins lag a block-time pace set over the 6-hour window (targets 30 coins / 240 fills), the bot opens tiny 0.02 SOL probe round trips until back on pace.

Deterministic: no clock, no randomness, no network at replay time.

## Dev-window results (kit's offline sim, run from the workspace with the kit's own sim port)

- Full 24 h dev window (128,058 events, 2026-11-02T03:09Z → 2026-11-03T03:09Z), default fail draw: net **+1.305 SOL**, 312 fills, 46 coins, 88 trips, max drawdown 7.4%; at 2× fees still **+0.678 SOL**.
- Sweep mean over 4 fail keys (tuned config): net **+1.565 SOL** (worst key +1.544), 309 fills, 44 coins, 87 trips, max drawdown 7.2%.
- 6-hour slices of the dev window (the final window is 6 h): +0 h **+1.772 SOL** (36 coins), +6 h −0.647 SOL (35 coins), +12 h −0.869 SOL (30 coins), +18 h −0.585 SOL (40 coins). Guardrails met on all four slices (30–40 coins, max drawdown ≤ 14.2%). The dev score leans on a few coins — ex-best-trip net is negative on every config tried — and the final window is a different 6 h, so this is not a forecast.
- Two runs with the same seed produce identical results (determinism verified locally).
- Kit pilot momentum baseline on the same window: −9.384 SOL (for reference only).

## Layout

- `main.ts` — entrypoint, hands the strategy to the wire shim.
- `strategy.ts` — the bot: tape, entry signal, scale-in, exits, drawdown guard, probes.
- `vendor/shim.ts` — the agent-fun/replay/v2 wire shim, written fresh for this entry.
