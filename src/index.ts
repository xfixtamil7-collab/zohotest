import { config } from './config';
import { prisma } from './prisma';
import { QueueService } from './queue';
import { createServer } from './server';

async function bootstrap() {
  console.log('🏁 Starting WhatsApp Voice to Zoho Inventory Automation Backend...');

  try {
    // 1. Verify Database Connectivity
    console.log('[Bootstrap] Testing database connection...');
    await prisma.$connect();
    console.log('[Bootstrap] Database connected successfully.');

    // 2. Initialize processing Queue
    console.log('[Bootstrap] Initializing message processing queue...');
    await QueueService.init();

    // 3. Initialize Express Web Server
    const app = createServer();
    const port = config.PORT;

    app.listen(port, () => {
      console.log(`\n🚀 ========================================================`);
      console.log(`🚀 Server listening on port ${port}`);
      console.log(`🚀 Mode: ${config.MOCK_ALL ? 'DEVELOPER MOCK MODE (Zero-Config)' : 'PRODUCTION'}`);
      console.log(`🚀 Web Dashboard URL: http://localhost:${port}`);
      console.log(`🚀 Meta Webhook URL:  http://[your-domain]/webhook/whatsapp`);
      console.log(`🚀 ========================================================\n`);
    });
  } catch (error) {
    console.error('❌ Bootstrap failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
