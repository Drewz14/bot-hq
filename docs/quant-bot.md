# The quant bot

A bot that researches crypto markets, tests trading rules on past prices, trades **paper money only**, and gets better over time by keeping score of its own calls.

Every bot gets the tools below, so the research bot can use the scorecard too.

| Tool | What it does |
|---|---|
| `market_data` | Live price and technical analysis: moving averages, trend, RSI, MACD, Bollinger bands, ATR. Free Coinbase data, no key. |
| `backtest_strategy` | Tests a rule on up to 1,500 past candles, with fees, filling at the next candle so it can't cheat. Reports the first 70% and the last 30% of history separately and warns when a rule looks overfitted. `strategy: "all"` compares every rule. |
| `paper_trade` / `paper_portfolio` | A practice account that starts at $10,000, at live prices, with 0.6% fees each way. |
| `log_prediction` | Writes a prediction down with a confidence. Price calls are scored against the market automatically; research calls are judged later by the bot. |
| `review_scorecard` | Settles due calls and shows hit rate, Brier score and calibration ("when I say 80%, am I right 80% of the time?"). |
| `resolve_prediction` | Scores a research call with the lesson learned. |

No tool can place a real order or reach an exchange account.

## Make the bot

Create a bot in the app, for example **Quant**, role **Crypto research**, and give it these instructions:

```text
You research crypto markets and test trading ideas with paper money. You never trade real money
and never tell the user to.

How you work:
1. Start from data: market_data for the current picture, backtest_strategy before trusting any rule.
2. Only trust a rule that also holds up out-of-sample and beats buy-and-hold after fees. Don't
   keep tweaking parameters until a backtest looks good; that fits noise. Say so when a result
   is weak.
3. When you act, paper_trade with a one-line reason, and log_prediction for the call with an
   honest confidence and a due date.
4. Every review, read your scorecard, save what you learned to memory (what works, what to stop,
   whether you are over- or under-confident), and write reusable methods down as skills.
5. Report plainly: numbers first, then what they mean, then what you're unsure about.
```

## The weekly self-review

Ask the bot to create this routine, or add it in its Routines tab:

- **Name:** Weekly review
- **Schedule:** `0 9 * * 1` (Mondays at 9:00)
- **Prompt:**

```text
Run review_scorecard and paper_portfolio with show_trades. Judge any research predictions that
are due with resolve_prediction. Then:
- Compare this week's results with your earlier lessons in memory.
- Save 1–3 new lessons to memory; remove any lesson the evidence now contradicts.
- If your calibration is off (e.g. your 80% calls are right 55% of the time), note how to adjust.
- Save a short report with save_file named review-<date>.md: equity, return, hit rate, Brier
  score, best and worst call, and what you'll do differently.
```

## Test

```bash
cd server && npx tsx scripts/quant-test.ts
```

It runs offline with a fake price feed and a throwaway database.
