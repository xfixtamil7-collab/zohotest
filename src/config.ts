import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  MOCK_ALL: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  DATABASE_URL: z.string().default('file:./dev.db'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  
  // APIs (Optional when MOCK_ALL is true)
  OPENAI_API_KEY: z.string().default('mock-key'),
  ZOHO_CLIENT_ID: z.string().default('mock-client-id'),
  ZOHO_CLIENT_SECRET: z.string().default('mock-client-secret'),
  ZOHO_REFRESH_TOKEN: z.string().default('mock-refresh-token'),
  ZOHO_ORG_ID: z.string().default('mock-org-id'),
  ZOHO_REGION: z.string().default('in'),
  
  WHATSAPP_TOKEN: z.string().default('mock-whatsapp-token'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default('mock-phone-id'),
  WHATSAPP_VERIFY_TOKEN: z.string().default('mock-verify-token'),
});

// Run validation
const parsedConfig = configSchema.safeParse(process.env);

if (!parsedConfig.success) {
  console.error('❌ Invalid environment variables:', parsedConfig.error.format());
  process.exit(1);
}

export const config = parsedConfig.data;

export type Config = typeof config;
