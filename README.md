# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/febridewa/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/febridewa/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Surge Sniper + Second-Dip Catcher — a paper-money pump.fun trading bot for the agent-fun/replay/v2 harness. It snipes fresh launches that show six or more distinct early buyers (real crowd demand, not a bundle waiting to dump) with tight slippage, and it buys 20–50% retracements on older curves while buyers step back in. Small fixed stakes, hard stops on every position, at most five open at once. Paper money only — it never touches a chain.

Dev window (24h, 1,222 coins): 326 coins traded, 326 counted round trips, net PnL −0.22 SOL, max drawdown 2.2%, guardrails met. The sniper family alone is positive on the dev window (+0.018 SOL on 38 coins); the dip family is kept at a small 0.02 SOL stake for breadth toward the 20-coin guardrail.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (hello / batch / done) with no dependencies and no configuration. It is deterministic: no clock, no randomness, no I/O, no environment reads.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6etrfz79&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
