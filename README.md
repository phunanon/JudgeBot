# JudgeBot

Discord moderation bot built with `discord.js`, TypeScript, Prisma 7, SQLite, and the OpenAI Node SDK.

## Setup

1. Fill in [.env](.env).
2. Run `pnpm db:migrate`.
3. Run `pnpm build`.
4. Start the bot with `pnpm start`.

## Features

- `/cases-here` stores the current channel as the cases channel for the guild.
- Message context menu command: `Use as evidence`.
- Evidence is deduplicated per Discord message.
- Open cases are created automatically per accused user.
- Case messages provide a `View evidence` button.
- Evidence review provides a `Make judgement` button.
- Attachment URLs are checked with `omni-moderation-latest` before judgement.
- Judgements are generated with `gpt-5-nano` and posted back into the cases channel.
- Judgements can recommend a prosecution action: mute, kick, or ban.
