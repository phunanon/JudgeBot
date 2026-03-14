# JudgeBot

Discord moderation workflow bot using `discord.js`, TypeScript, Prisma + SQLite, and OpenAI.

## Overview

- `/cases-here` sets the server's cases channel.
- `Use as evidence` captures the selected message plus nearby context, deduplicates evidence, and opens/reuses an active case.
- Cases support `View evidence`, `Make judgement`, `Prosecute`, and `Clean up inappropriate messages` actions.
- Attachments and message text are moderated with `omni-moderation-latest`.
- Judgements are generated with `gpt-5-nano` and include a summary plus punishment recommendation (`BAN`, `KICK`, `MUTE`, `NONE`).

## Quick start

1. Create `.env` with `DISCORD_TOKEN` and `OPENAI_API_KEY`.
2. Run `pnpm migrate`.
3. Run `pnpm build`.
4. Run `pnpm start`.
5. Optionally run `pm2 start --name JudgeBot pnpm -- start`
