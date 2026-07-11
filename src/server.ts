import express, { Request, Response } from 'express';
import session from 'express-session';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import axios from 'axios';
import { config } from './config';
import { QueueService } from './queue';
import { SessionService } from './services/session';
import { WhatsAppService } from './services/whatsapp';
import { ZohoService } from './services/zoho';
import { OpenAIService } from './services/openai';
import { WebhookMessage } from './types';
import { prisma } from './prisma';

declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
  }
}



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

  // Session Configuration (Auto-logout after 1 hour of inactivity)
  app.use(session({
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 60 * 60 * 1000 // 1 hour
    }
  }));

  // Authentication Middleware
  const requireAuth = (req: Request, res: Response, next: express.NextFunction) => {
    if (
      req.path === '/login' || 
      req.path === '/styles.css' || 
      req.path === '/favicon.ico' ||
      (req.path.startsWith('/webhook/whatsapp') && req.path !== '/webhook/whatsapp-simulate')
    ) {
      return next();
    }
    
    if (req.session && req.session.authenticated) {
      return next();
    }
    
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.redirect('/login');
    } else {
      res.status(401).json({ error: 'Unauthorized. Please login.' });
    }
  };

  app.use(requireAuth);

  // Serve Dashboard Static Assets
  app.use(express.static(path.join(__dirname, 'public')));

  // Auth Routes
  app.get('/login', (req: Request, res: Response) => {
    if (req.session && req.session.authenticated) {
      return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  app.post('/login', (req: Request, res: Response) => {
    const { username, password } = req.body;
    if (username === config.DASHBOARD_USERNAME && password === config.DASHBOARD_PASSWORD) {
      req.session.authenticated = true;
      res.redirect('/');
    } else {
      res.redirect('/login?error=invalid');
    }
  });

  app.post('/logout', (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('[Auth] Error destroying session on logout:', err);
      }
      res.redirect('/login');
    });
  });

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

  // Get current system configuration status
  app.get('/api/config', async (req: Request, res: Response) => {
    try {
      const active = await prisma.zohoAccount.findFirst({ where: { isActive: true } });
      const currencyDetails = await ZohoService.getOrganizationCurrency();
      res.json({
        mockMode: config.MOCK_ALL,
        region: active ? active.region : '',
        orgId: active ? active.orgId : '',
        accountName: active ? active.name : 'None',
        currencySymbol: currencyDetails.symbol,
        currencyCode: currencyDetails.code
      });
    } catch (e: any) {
      res.json({
        mockMode: config.MOCK_ALL,
        region: '',
        orgId: '',
        accountName: 'None',
        currencySymbol: '₹',
        currencyCode: 'INR'
      });
    }
  });

  // Get all connected Zoho accounts
  app.get('/api/zoho-accounts', async (req: Request, res: Response) => {
    try {
      const accounts = await prisma.zohoAccount.findMany({
        orderBy: { createdAt: 'desc' }
      });
      res.json(accounts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add new Zoho account
  app.post('/api/zoho-accounts', async (req: Request, res: Response) => {
    try {
      const { name, clientId, clientSecret, refreshToken, orgId, region } = req.body;
      if (!name || !clientId || !clientSecret || !refreshToken || !orgId || !region) {
        return res.status(400).json({ error: 'All fields are required.' });
      }

      let finalRefreshToken = refreshToken;

      // Check if credentials are valid
      if (!config.MOCK_ALL) {
        const validation = await ZohoService.validateCredentials({
          clientId,
          clientSecret,
          refreshToken,
          region
        });
        if (!validation.isValid) {
          return res.status(400).json({ error: `Failed to authenticate with Zoho: ${validation.error || 'Unknown error'}` });
        }
        if (validation.refreshToken) {
          finalRefreshToken = validation.refreshToken;
        }
      }

      // If this is the first account, make it active
      const count = await prisma.zohoAccount.count();
      const isActive = count === 0;

      const account = await prisma.zohoAccount.create({
        data: {
          name,
          clientId,
          clientSecret,
          refreshToken: finalRefreshToken,
          orgId,
          region,
          isActive
        }
      });

      res.json({ success: true, account });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Activate Zoho account
  app.post('/api/zoho-accounts/activate', async (req: Request, res: Response) => {
    try {
      const { id } = req.body;
      
      if (!id || id === 'none') {
        await prisma.zohoAccount.updateMany({
          data: { isActive: false }
        });
        return res.json({ success: true, account: { name: 'None' } });
      }

      // Set all other accounts to inactive
      await prisma.zohoAccount.updateMany({
        where: { id: { not: id } },
        data: { isActive: false }
      });

      // Set target account to active
      const updated = await prisma.zohoAccount.update({
        where: { id },
        data: { isActive: true }
      });

      res.json({ success: true, account: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete Zoho account
  app.delete('/api/zoho-accounts/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      const accountToDelete = await prisma.zohoAccount.findUnique({
        where: { id }
      });

      if (!accountToDelete) {
        return res.status(404).json({ error: 'Account not found' });
      }

      await prisma.zohoAccount.delete({
        where: { id }
      });

      // If the deleted account was active, make another one active
      if (accountToDelete.isActive) {
        const nextAccount = await prisma.zohoAccount.findFirst();
        if (nextAccount) {
          await prisma.zohoAccount.update({
            where: { id: nextAccount.id },
            data: { isActive: true }
          });
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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

  // Get all sales order and invoice logs — filtered by the currently active Zoho account
  app.get('/api/orders/logs', async (req: Request, res: Response) => {
    try {
      const activeAccount = await ZohoService.getActiveAccount();

      // Build filter: if an active account exists, only return logs belonging to it.
      // Logs with no zohoAccountId (created before this feature) are shown only when
      // there is no active account, or can be shown alongside for legacy compatibility.
      const where = activeAccount
        ? { zohoAccountId: activeAccount.id }
        : {};

      const logs = await prisma.orderLog.findMany({
        where,
        orderBy: { updatedAt: 'desc' }
      });
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ----------------------------------------------------
  // France Company Lookup via Official Open Data API
  // Uses: recherche-entreprises.api.gouv.fr (free, no key needed)
  // ----------------------------------------------------

  /**
   * GET /api/france/lookup?q=<siret_or_siren_or_name>
   * Looks up a French company by SIRET, SIREN, or company name using
   * the official French government open data API (free, no API key required).
   */
  app.get('/api/france/lookup', async (req: Request, res: Response) => {
    const query = (req.query.q as string || '').trim();
    if (!query || query.length < 3) {
      return res.status(400).json({ error: 'Query must be at least 3 characters.' });
    }

    try {
      const cleanQuery = query.replace(/\s/g, '');

      // Official French govt open-data API — no auth required
      const apiUrl = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=5&mtq=ph`;

      console.log(`[France Lookup] Querying: ${apiUrl}`);

      const apiRes = await axios.get(apiUrl, {
        headers: { Accept: 'application/json' },
        timeout: 10000
      });

      const data = apiRes.data;
      const rawResults: any[] = data.results || [];

      if (!rawResults || rawResults.length === 0) {
        return res.json({ found: false, results: [] });
      }

      /**
       * Compute French EU VAT number from SIREN
       * Official formula: "FR" + ((12 + 3 * (SIREN % 97)) % 97) + SIREN
       */
      function computeVAT(siren: string): string {
        const s = parseInt(siren, 10);
        if (isNaN(s)) return '';
        const key = (12 + 3 * (s % 97)) % 97;
        return `FR${String(key).padStart(2, '0')}${siren}`;
      }

      /**
       * Fallback to query societe.com search redirect to get the company page and parse dirigeants
       */
      async function fetchDirigeantFromSocieteCom(siren: string): Promise<{ name: string; jobTitle: string } | null> {
        try {
          const url = `https://www.societe.com/cgi-bin/search?q=${siren}`;
          console.log(`[France Lookup] [Societe.com Fallback] Fetching redirect search for SIREN: ${siren}`);
          const res = await axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html'
            },
            timeout: 5000
          });
          const html = res.data;
          const match = html.match(/"name"\s*:\s*"([^"]+)"\s*,\s*"jobTitle"/);
          if (match && match[1]) {
            const name = match[1].replace(/\\u([0-9a-fA-F]{4})/g, (g: string, m: string) => String.fromCharCode(parseInt(m, 16)));
            let jobTitle = 'Dirigeant';
            const jobMatch = html.match(/"jobTitle"\s*:\s*"([^"]+)"/);
            if (jobMatch && jobMatch[1]) {
              jobTitle = jobMatch[1].replace(/\\u([0-9a-fA-F]{4})/g, (g: string, m: string) => String.fromCharCode(parseInt(m, 16)));
            }
            return { name, jobTitle };
          }
        } catch (err: any) {
          console.warn(`[France Lookup] [Societe.com Fallback] Failed to fetch/parse for ${siren}: ${err.message}`);
        }
        return null;
      }

      const results = await Promise.all(rawResults.map(async (r: any) => {
        const siren: string = r.siren || '';
        const siege = r.siege || {};
        const siret: string = siege.siret || (siren ? siren + '00001' : '');
        const vatNumber = r.numero_tva_intra || computeVAT(siren);

        // Build street from adresse field or components
        const street: string = siege.adresse || [
          siege.numero_voie,
          siege.type_voie,
          siege.libelle_voie
        ].filter(Boolean).join(' ');

        const companyName: string =
          r.nom_complet ||
          r.denomination ||
          r.nom_raison_sociale ||
          '';

        // Extract first dirigeant (company director) name
        let dirigeantName = '';
        let dirigeantQualite = '';
        const dirigeants: any[] = r.dirigeants || [];
        if (dirigeants.length > 0) {
          const d = dirigeants[0];
          if (d.type_dirigeant === 'personne physique') {
            // Physical person: format as "Firstname LASTNAME"
            const prenom = d.prenoms ? d.prenoms.split(' ')[0] : '';
            const nom = d.nom || '';
            // Capitalize first letter of firstname, uppercase lastname
            const prenomFmt = prenom.charAt(0).toUpperCase() + prenom.slice(1).toLowerCase();
            dirigeantName = [prenomFmt, nom.toUpperCase()].filter(Boolean).join(' ');
          } else {
            // Legal entity: use denomination
            dirigeantName = d.denomination || '';
          }
          dirigeantQualite = d.qualite || '';
        }

        // Fallback to societe.com if official API has no dirigentes listed
        if (!dirigeantName && siren) {
          const fb = await fetchDirigeantFromSocieteCom(siren);
          if (fb) {
            dirigeantName = fb.name;
            dirigeantQualite = fb.jobTitle;
          }
        }

        let dirigeantFirstName = '';
        let dirigeantLastName = '';
        if (dirigeantName) {
          const parsed = await OpenAIService.parseDirectorName(dirigeantName);
          dirigeantFirstName = parsed.firstName;
          dirigeantLastName = parsed.lastName;
          // Re-format complete display name correctly
          dirigeantName = `${dirigeantFirstName} ${dirigeantLastName}`.trim();
        }

        return {
          siret,
          siren,
          companyName,
          vatNumber,
          dirigeantName,
          dirigeantFirstName,
          dirigeantLastName,
          dirigeantQualite,
          address: {
            street,
            city: siege.libelle_commune || siege.commune || '',
            postalCode: siege.code_postal || '',
            country: 'France',
            countryCode: 'FR'
          }
        };
      }));




      return res.json({ found: true, results });

    } catch (error: any) {
      if (error.response?.status === 404) {
        return res.json({ found: false, results: [] });
      }
      const errMsg = error.response?.data?.message || error.message || 'Unknown error';
      console.error('[France Lookup] API error:', error.response?.status, errMsg);
      return res.status(500).json({
        error: `Company lookup failed: ${errMsg}. Please try again.`
      });
    }
  });

  /**
   * POST /api/zoho/create-customer
   * Creates a new customer contact in Zoho Inventory.
   */
  app.post('/api/zoho/create-customer', async (req: Request, res: Response) => {
    try {
      const { contactName, companyName, email, phone, vatNumber, billingAddress, siret, siren } = req.body;

      if (!contactName || !companyName) {
        return res.status(400).json({ error: 'contactName and companyName are required.' });
      }

      const result = await ZohoService.createCustomer({
        contactName,
        companyName,
        email,
        phone,
        vatNumber,
        billingAddress,
        siret,
        siren
      });

      console.log(`[API] Created customer: ${result.companyName} (${result.contactId})`);
      res.json({ success: true, contact: result });
    } catch (error: any) {
      console.error('[API] Failed to create customer:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });


  app.post('/api/transcribe-tanglish', upload.single('audio'), async (req: Request, res: Response) => {
    let renamedPath: string | null = null;
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No audio file provided' });
      }

      // Whisper requires a file with a proper extension to detect audio format.
      // Multer saves files without extensions, so we must rename before transcribing.
      const mimeToExt: Record<string, string> = {
        'audio/webm': 'webm',
        'audio/ogg': 'ogg',
        'audio/mp4': 'mp4',
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
        'audio/flac': 'flac',
        'audio/m4a': 'm4a',
        'audio/x-m4a': 'm4a',
      };
      const baseMime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
      const ext = mimeToExt[baseMime] || 'webm';
      renamedPath = `${file.path}.${ext}`;

      fs.renameSync(file.path, renamedPath);
      console.log(`[Transcription API] Audio saved as: ${renamedPath} (MIME: ${file.mimetype})`);

      // Step 1: Transcribe using OpenAIService
      const transcriptionText = await OpenAIService.transcribeAudio(renamedPath);
      console.log(`[Transcription API] Raw transcription: "${transcriptionText}"`);

      // Step 2: Convert/transliterate transcription to Tanglish
      const tanglishText = await OpenAIService.convertToTanglish(transcriptionText);
      console.log(`[Transcription API] Converted Tanglish: "${tanglishText}"`);

      res.json({ success: true, transcription: transcriptionText, tanglish: tanglishText });
    } catch (error: any) {
      console.error('[Transcription API] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to transcribe audio' });
    } finally {
      // Clean up the renamed temp file
      if (renamedPath) {
        fs.unlink(renamedPath, (err) => {
          if (err) console.error('[Transcription API] Failed to delete temp file:', err);
        });
      }
    }
  });

  // Download Sales Order PDF
  app.get('/api/download/salesorder/:id', async (req: Request, res: Response) => {
    try {
      const salesOrderId = req.params.id;
      let fileName = `SalesOrder_${salesOrderId}.pdf`;
      try {
        const orderLog = await prisma.orderLog.findFirst({
          where: { salesOrderId }
        });
        if (orderLog && orderLog.salesOrderNumber) {
          fileName = `${orderLog.salesOrderNumber}.pdf`;
        }
      } catch (err) {
        // Ignore and use default filename
      }

      const pdfBuffer = await ZohoService.getSalesOrderPdf(salesOrderId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error('[API] Failed to download sales order PDF:', error.message);
      res.status(500).json({ error: 'Failed to download PDF.' });
    }
  });

  // Download Invoice PDF
  app.get('/api/download/invoice/:id', async (req: Request, res: Response) => {
    try {
      const invoiceId = req.params.id;
      let fileName = `Invoice_${invoiceId}.pdf`;
      try {
        const orderLog = await prisma.orderLog.findFirst({
          where: { invoiceId }
        });
        if (orderLog && orderLog.invoiceNumber) {
          fileName = `${orderLog.invoiceNumber}.pdf`;
        }
      } catch (err) {
        // Ignore and use default filename
      }

      const pdfBuffer = await ZohoService.getInvoicePdf(invoiceId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error('[API] Failed to download invoice PDF:', error.message);
      res.status(500).json({ error: 'Failed to download PDF.' });
    }
  });

  return app;
}
