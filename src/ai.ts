import OpenAI from 'openai';
import { z } from 'zod';

import { config } from './config.js';
import { zodResponseFormat } from 'openai/helpers/zod.js';

const judgementSchema = z.object({
  prosecution: z
    .string()
    .min(1)
    .describe("The prosecution's argument considering the evidence and rules."),
  defence: z
    .string()
    .min(1)
    .describe("The defence's argument considering the evidence and rules."),
  judgement: z
    .string()
    .min(1)
    .describe(
      "Weighing the evidence, prosecution's arguments, and defence's arguments, an executive judgement summary of the case.",
    ),
  punishment: z.enum(['BAN', 'KICK', 'MUTE', 'NONE']),
});
export type JudgementResult = z.infer<typeof judgementSchema>;

export type AttachmentModerationResult = {
  status: 'CLEAN' | 'IMPROPER';
  raw: string;
};

export const openai = new OpenAI({ apiKey: config.openAiApiKey });

export async function moderateAttachment(
  url: string,
): Promise<AttachmentModerationResult> {
  const input = [{ type: 'image_url', image_url: { url } } as const];
  const moderation = await openai.moderations.create({
    input,
    model: 'omni-moderation-latest',
  });

  const improper = moderation.results.some(result => result.flagged);

  return {
    status: improper ? 'IMPROPER' : 'CLEAN',
    raw: JSON.stringify(moderation),
  };
}

export async function generateJudgement(
  evidenceReport: string,
): Promise<JudgementResult> {
  const response = await openai.chat.completions.parse({
    model: 'gpt-5-mini',
    reasoning_effort: 'low',
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: `Your honours. The following evidence is brought to your attention from a Discord server.

This server has these rules:
- Respect others: No hate speech, slurs, harassment, doxing, impersonation, or shaming.
- Keep it clean: No threatening language, and no adult themes.
- No spam, ads, or solicitation: Don't flood chats with messages/media. No advertisements, and no begging for e.g. money or Nitro. Advertisement exceptions: your own music in ⁠#music; your own games in ⁠#games; your own art in #⁠your-art-pics-and-pets.
- No trolling or inciting drama: Keep interactions constructive.

Punishments:
- BAN: User is banned from the server permanently.
- KICK: User is kicked from the server, but can rejoin.
- MUTE: User can read messages but cannot send messages for eight hours - a severe warning.
- NONE: No action is taken against the user.

Consider that the removal of mildly controversial members can negatively impact the community, as they might be contributing positively in other ways. Therefore, if the evidence is not clear-cut, it is better to opt for no punishment at all.
People are free to speak their minds, and we should be cautious about over-moderation. If the evidence is ambiguous, it's often best to err on the side of leniency, as another case can always be opened with stronger evidence.

We shall now discuss the evidence. Judgement will only affect [SUBJECT] - if there is bad behaviour by others, this will be dealt with in a separate case.`,
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: evidenceReport }] },
    ],
    response_format: zodResponseFormat(judgementSchema, 'judgement'),
  });

  const parsed = response.choices[0]?.message.parsed;

  if (!parsed) {
    throw new Error('OpenAI did not return a judgement payload.');
  }

  return parsed;
}
