# Helpers

Helpers are people you invite to help with some of your bots, such as volunteers on a research project, with limited access.

| A helper can | A helper can't |
|---|---|
| See results a bot shared with helpers | See a bot's chat, memory, files, screen or settings |
| Review a result: looks right / looks wrong / not sure, with a note | See a routine's instructions |
| Run the routines you marked as safe for helpers, up to 10 runs a day | Create bots, connect apps, or use any other part of the app |

Everything a helper does is written to the activity log in **Settings → Helpers**.

## Inviting someone

1. **Settings → Helpers**: enter their email, tick the bots they may help with, and press **Invite**.
2. They open the app's address and sign in with that email. Invited helpers can sign in even when `ALLOWED_EMAILS` is set; they get a helper account with no bots of their own and don't count toward the bot limit.
3. To let them run a routine, switch it on under **Routines helpers can run**.

**Remove** takes away their access and their reviews, and signs them out at once.

## How bots share

A bot shares with the `share_with_helpers` tool. Each share shows you an approval card first, unless you choose **Always allow**. Before saving, the app blanks out obvious personal details: emails, phone numbers, ID and record numbers, dates of birth and street addresses. This is a safety net, not a guarantee: bots are told to share only de-identified results, and the approval card is where you check.

Bots read reviews with `read_helper_reviews` and can turn them into lessons in their memory.

## Sensitive data

Don't put identifiable patient data on the shared computer: all bots there can reach each other's files. Keep helpers to public or de-identified data, and check the terms of any data source or model you share results from (AlphaGenome, for example, is free for non-commercial research only).

## Test

```bash
cd server && npx tsx scripts/helpers-test.ts
```
