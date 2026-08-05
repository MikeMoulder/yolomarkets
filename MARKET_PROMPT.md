# Market-drafting prompt template

Paste this into any AI model (ChatGPT, Claude, Gemini …) to turn a rough idea
into a market you can send straight to the YOLO Telegram bot. The output is a
ready-to-paste `/create` one-liner — everything except the cover image, which
you attach in Telegram by sending a photo.

Rules below mirror the real validators in [web/lib/market-draft.ts](web/lib/market-draft.ts);
anything that breaks them is rejected by the bot, not silently accepted.

---

## The template

```text
You are helping me write a binary prediction market for YOLO Markets, a
prediction-market platform on Arc testnet. I will give you a topic; you return
one market definition, ready to paste into a Telegram bot.

TOPIC: <<< describe your idea here, e.g. "something about the Fed's September
meeting" or paste a news headline / link >>>

TODAY'S DATE: <<< YYYY-MM-DD >>>

Return EXACTLY this one line and nothing else — no preamble, no code fence,
no bullet points:

/create QUESTION | DEADLINE | SEED | CATEGORY | CRITERIA

Field rules (all are enforced; a violation is rejected):

1. QUESTION
   - A single yes/no question that will be unambiguously TRUE or FALSE at the
     deadline. No "which/how many/who" phrasing — those aren't binary.
   - 8-200 characters.
   - Must NOT contain the "|" character (it is the field separator).
   - Bake the threshold and the date into the text, e.g. "Will BTC close above
     $150,000 on Dec 31 2026?" — not "Will BTC go up?".

2. DEADLINE — the moment the outcome becomes checkable. One of:
   - a relative span: 90m, 36h, 7d, 2w
   - a date: 2026-12-31  (interpreted as 23:59:59 UTC that day)
   - a date + time: 2026-12-31 18:00  (UTC)
   - Must be at least 10 minutes from now and at most 2 years out.
   - Set it AFTER the result is publicly known, not when the event starts. A
     market that expires before the source publishes cannot be settled.

3. SEED — initial liquidity in USDC, between 0.1 and 10000. This is the LMSR
   depth: bigger seed = flatter prices and more capital at risk. Use 5 unless
   the topic is high-traffic, then 10-25.

4. CATEGORY — exactly one of:
   Crypto, Sports, Politics, Geopolitics, Tech, Macro, Culture, Science, Other
   ("Arc Special" also exists, but it is a hand-picked house rail — choose it
   yourself when you want the market featured, don't let the model pick it.)

5. CRITERIA — 10-1000 characters. This market is settled MANUALLY by a human at
   the deadline, so it must be checkable by one person in under a minute:
   - name the single authoritative public source (exact publication, feed, or
     official body) that decides it;
   - state the exact threshold, units and timezone;
   - say what happens in the ambiguous cases (source unavailable, event
     postponed, tie, rounding).
   - "|" IS allowed here.

Before answering, check your own line: is the question strictly binary, is the
deadline after the source publishes, and could two people reading the criteria
ever disagree on the outcome? Fix it before you reply.
```

---

## Worked example

**Topic given:** `"something about the Fed's September meeting"`, today `2026-08-01`

**Model returns:**

```text
/create Will the FOMC cut the federal funds target range at its September 2026 meeting? | 2026-09-17 | 10 | Macro | Resolves YES if the FOMC statement published at fomc.gov on 2026-09-16 announces a lower target range for the federal funds rate than the range in effect beforehand. Resolves NO if the range is unchanged or raised. If the meeting is postponed past 2026-09-16, the market is cancelled and stakes refunded.
```

Paste that into the bot, then send a photo to set the cover image.

---

## Notes

- **Send the photo with the command.** A photo whose caption is the `/create …`
  line does both in one message.
- **Duplicate guard.** The market address is derived from
  `keccak256(question, deadline)`, so the identical question *and* deadline can
  never be created twice — vary one of them if you want a rerun.
- **Cover art matters.** Markets with no artwork are hidden from the catalog
  (they stay tradeable by direct link), so set an image unless you deliberately
  want the market unlisted.
- **Shorter form.** `CATEGORY` and `CRITERIA` are optional in the bot —
  `/create QUESTION | DEADLINE | SEED` auto-classifies the category and
  generates default criteria. The template asks for all five because a
  hand-written criteria is far better than the generic template for a market a
  human has to settle.
