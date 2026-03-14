const requiredEnvKeys = ['DISCORD_TOKEN', 'OPENAI_API_KEY'] as const;

type RequiredEnvKey = (typeof requiredEnvKeys)[number];

function getRequiredEnv(key: RequiredEnvKey): string {
  const value = process.env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

export const config = {
  discordToken: getRequiredEnv('DISCORD_TOKEN'),
  openAiApiKey: getRequiredEnv('OPENAI_API_KEY'),
} as const;
