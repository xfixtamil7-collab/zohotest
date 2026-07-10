import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import { config } from './config';
import { QueueService } from './queue';
import { SessionService } from './services/session';
import { WhatsAppService } from './services/whatsapp';
import { ZohoService } from './services/zoho';
import { WebhookMessage } from './types';

// Configure file upload handler for simulator
const upload = multer({
  dest: path.join(process.cwd(), 'scratch/uploads/'),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

export function createServer() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve Dashboard Static Assets
  app.use(express.static(path.join(__dirname, 'public')));

  // Standard index route fallback to dashboard
  app.get('/', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // ----------------------------------------------------
  // Meta WhatsApp Cloud API Webhook Endpoints
  // ----------------------------------------------------

  /**
   * Webhook Verification (GET)
   * Meta sends a GET request to verify the webhook webhook endpoint settings.
   */
  app.get('/webhook/whatsapp', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
        console.log('[Webhook] Webhook verified successfully by Meta.');
        res.status(200).send(challenge);
      } else {
        console.warn('[Webhook] Verification token mismatch.');
        res.sendStatus(403);
      }
    } else {
      res.sendStatus(400);
    }
  });

  /**
   * Webhook Message Receiver (POST)
   * Receives incoming text and voice messages from WhatsApp customers.
   */
  app.post('/webhook/whatsapp', async (req: Request, res: Response) => {
    try {
      const body = req.body;

      // Verify that this is a WhatsApp API webhook trigger
      if (body.object === 'whatsapp_business_account') {
        const entries = body.entry || [];
        
        for (const entry of entries) {
          const changes = entry.changes || [];
          for (const change of changes) {
            const val = change.value;
            const messages = val.messages || [];
            
            for (const msg of messages) {
              const from = msg.from; // Sender phone number
              const messageId = msg.id;
              const timestamp = Number(msg.timestamp);

              // 1. Text Message processing
              if (msg.type === 'text') {
                const text = msg.text?.body;
                const webhookMsg: WebhookMessage = {
                  from,
                  messageId,
                  timestamp,
                  type: 'text',
                  text
                };
                await QueueService.addJob(webhookMsg);
              } 
              // 2. Audio/Voice Note processing
              else if (msg.type === 'audio') {
                const audioId = msg.audio?.id;
                const webhookMsg: WebhookMessage = {
                  from,
                  messageId,
                  timestamp,
                  type: 'audio',
                  audioId
                };
                await QueueService.addJob(webhookMsg);
              }
              // 3. Interactive Quick Replies (Buttons)
              else if (msg.type === 'interactive') {
                const buttonReply = msg.interactive?.button_reply;
                if (buttonReply && buttonReply.id) {
                  const webhookMsg: WebhookMessage = {
                    from,
                    messageId,
                    timestamp,
                    type: 'text',
                    text: buttonReply.id // Route button ID as text command (e.g. btn_confirm)
                  };
                  await QueueService.addJob(webhookMsg);
                }
              }
            }
          }
        }
        // Respond with 200 OK immediately to stop retries from WhatsApp
        res.status(200).send('EVENT_RECEIVED');
      } else {
        res.sendStatus(404);
      }
    } catch (error) {
      console.error('[Webhook] Error receiving WhatsApp webhook:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  // ----------------------------------------------------
  // Dashboard Simulator webhook (Simulates WhatsApp actions)
  // ----------------------------------------------------
  app.post('/webhook/whatsapp-simulate', upload.single('audio'), async (req: Request, res: Response) => {
    try {
      const from = req.body.from || '+919876543210';
      const type = req.body.type || 'text';
      const text = req.body.text;
      const file = req.file;

      const messageId = `sim_msg_${Math.floor(Math.random() * 1000000)}`;
      const timestamp = Math.floor(Date.now() / 1000);

      let webhookMsg: WebhookMessage;

      if (type === 'audio' && file) {
        webhookMsg = {
          from,
          messageId,
          timestamp,
          type: 'audio',
          audioId: `sim_audio_id_${file.filename}` // Pass filename to indicate local path download mock
        };
        console.log(`[Simulator Webhook] Received audio file: ${file.originalname}. Simulating event...`);
      } else {
        webhookMsg = {
          from,
          messageId,
          timestamp,
          type: 'text',
          text
        };
        console.log(`[Simulator Webhook] Received text: "${text}". Simulating event...`);
      }

      // Add to pipeline execution queue
      await QueueService.addJob(webhookMsg);
      res.status(200).json({ success: true, messageId, message: 'Simulated webhook event accepted and queued.' });
    } catch (error: any) {
      console.error('[Simulator Webhook] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ----------------------------------------------------
  // Dashboard Support JSON APIs
  // ----------------------------------------------------

  // Get active session status
  app.get('/api/session', async (req: Request, res: Response) => {
    const phone = req.query.phone as string;
    if (!phone) {
      return res.status(400).json({ error: 'Missing phone number' });
    }
    const session = await SessionService.getSession(phone);
    res.json(session);
  });

  // Reset active session
  app.post('/api/session/reset', async (req: Request, res: Response) => {
    const phone = req.body.phone;
    if (!phone) {
      return res.status(400).json({ error: 'Missing phone number' });
    }
    await SessionService.clearSession(phone);
    res.json({ success: true, message: 'Session reset successfully.' });
  });

  // Retrieve mock Zoho DB items for display
  app.get('/api/mocks/items', async (req: Request, res: Response) => {
    try {
      const items = await ZohoService.searchItems();
      res.json(items);
    } catch (err: any) {
      console.error('[API] Failed to load Zoho items:', err.message);
      res.status(500).json({ error: 'Failed to connect to Zoho Inventory. Check your credentials in .env.' });
    }
  });

  // Retrieve mock Zoho DB customers for display
  app.get('/api/mocks/customers', async (req: Request, res: Response) => {
    try {
      const customers = await ZohoService.searchCustomers();
      res.json(customers);
    } catch (err: any) {
      console.error('[API] Failed to load Zoho customers:', err.message);
      res.status(500).json({ error: 'Failed to connect to Zoho Inventory. Check your credentials in .env.' });
    }
  });

  // Outgoing messages logs for dashboard chat frame
  app.get('/api/whatsapp/logs', (req: Request, res: Response) => {
    res.json(WhatsAppService.sentMessagesLog);
  });

  // Clear outgoing message logs
  app.post('/api/whatsapp/logs/clear', (req: Request, res: Response) => {
    WhatsAppService.sentMessagesLog = [];
    res.json({ success: true });
  });

  return app;
}
