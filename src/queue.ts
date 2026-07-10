import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config';
import { prisma } from './prisma';
import { WebhookMessage, DraftOrder, DraftItem } from './types';
import { SessionService } from './services/session';
import { OpenAIService } from './services/openai';
import { ZohoService } from './services/zoho';
import { MatcherService } from './services/matcher';
import { WhatsAppService } from './services/whatsapp';

export class QueueService {
  private static queue: Queue | null = null;
  private static worker: Worker | null = null;
  private static redisConnected = false;

  // Simple in-memory queue fallback variables
  private static localQueue: any[] = [];
  private static localProcessing = false;

  /**
   * Initializes the queue. Checks Redis connectivity first to decide between BullMQ and Memory Queue.
   */
  static async init(): Promise<void> {
    if (config.MOCK_ALL) {
      console.log('[QueueService] Running in MOCK mode. Initializing In-Memory Queue.');
      this.initMemoryQueue();
      return;
    }

    try {
      console.log('[QueueService] Connecting to Redis...');
      const connection = new IORedis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
        connectTimeout: 3000
      });

      connection.on('connect', () => {
        this.redisConnected = true;
        console.log('[QueueService] Redis connected successfully. Initializing BullMQ.');
        
        this.queue = new Queue('whatsapp-webhook', { connection: connection as any });
        this.worker = new Worker('whatsapp-webhook', async (job) => {
          await this.processMessage(job.data);
        }, { connection: connection as any });

        this.worker.on('failed', (job, err) => {
          console.error(`[QueueService] Job ${job?.id} failed:`, err);
        });
      });

      connection.on('error', (err) => {
        if (!this.redisConnected) {
          console.warn('[QueueService] Redis connection failed. Falling back to In-Memory Queue. Error:', err.message);
          connection.disconnect(); // Disconnect to prevent infinite retry loops
          this.initMemoryQueue();
        }
      });
    } catch (e: any) {
      console.warn('[QueueService] Error connecting to Redis. Using In-Memory queue fallback:', e.message);
      this.initMemoryQueue();
    }
  }

  private static initMemoryQueue(): void {
    this.redisConnected = false;
    this.queue = null;
    this.worker = null;
    console.log('[QueueService] In-Memory Queue initialized.');
  }

  /**
   * Adds a new Webhook Message job to the processing queue
   */
  static async addJob(message: WebhookMessage): Promise<void> {
    if (this.queue && this.redisConnected) {
      await this.queue.add('webhook-msg', message, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      });
      console.log(`[QueueService] Message ${message.messageId} added to BullMQ.`);
    } else {
      this.localQueue.push(message);
      console.log(`[QueueService] Message ${message.messageId} queued in Memory.`);
      this.processMemoryQueue();
    }
  }

  /**
   * Processes the in-memory queue sequentially
   */
  private static async processMemoryQueue() {
    if (this.localProcessing || this.localQueue.length === 0) return;
    this.localProcessing = true;

    while (this.localQueue.length > 0) {
      const nextMessage = this.localQueue.shift();
      if (nextMessage) {
        try {
          await this.processMessage(nextMessage);
        } catch (error) {
          console.error(`[QueueService] [In-Memory] Error processing message ${nextMessage.messageId}:`, error);
        }
      }
    }

    this.localProcessing = false;
  }

  /**
   * Main Webhook Message Processor Worker Logic
   */
  static async processMessage(message: WebhookMessage): Promise<void> {
    const from = message.from;
    console.log(`[QueueService] Starting processing for message ${message.messageId} from ${from}`);

    try {
      // 1. Resolve text transcription (Speech-To-Text if audio, otherwise use raw text)
      let transcription = '';
      if (message.type === 'audio' && message.audioId) {
        // Download audio file from WhatsApp Cloud media server
        const audioPath = await WhatsAppService.downloadMedia(message.audioId);
        // Transcribe audio file to text
        transcription = await OpenAIService.transcribeAudio(audioPath);
      } else {
        transcription = message.text || '';
      }

      console.log(`[QueueService] Text transcription: "${transcription}"`);

      // 2. Parse text with GPT-4o for Intent & Details
      const { draft: parsedDraft, action } = await OpenAIService.parseIntent(transcription);
      console.log(`[QueueService] Extracted action: "${action}"`);

      // 3. Load active session
      const session = await SessionService.getSession(from);

      // 4. State Machine routing based on action & session state
      if (action === 'CANCEL') {
        await SessionService.clearSession(from);
        await WhatsAppService.sendTextMessage(from, '❌ Your draft order has been cancelled.');
        return;
      }

      // If user confirms a draft
      if (action === 'CONFIRM') {
        if (session.state === 'AWAITING_CONFIRMATION' && session.draft) {
          const draft = session.draft;
          
          if (!draft.zohoCustomerId) {
            await WhatsAppService.sendTextMessage(
              from,
              `⚠️ Cannot create Sales Order. Customer "${draft.spokenCustomerName}" was not found or verified. Please specify the customer name again.`
            );
            return;
          }

          const matchedItems = draft.items.filter(it => it.zohoItemId);
          if (matchedItems.length === 0) {
            await WhatsAppService.sendTextMessage(
              from,
              `⚠️ Cannot create Sales Order. No valid items matched. Please try ordering again.`
            );
            return;
          }

          // Create Sales Order in Zoho
          const salesOrderItems = matchedItems.map(it => ({
            itemId: it.zohoItemId!,
            quantity: it.quantity,
            rate: it.rate ?? it.zohoRate ?? 0
          }));

          const soResponse = await ZohoService.createSalesOrder({
            customerId: draft.zohoCustomerId,
            items: salesOrderItems,
            notes: draft.notes,
            deliveryDate: draft.deliveryDate
          });

          // Save created Sales Order in Log DB
          await prisma.orderLog.create({
            data: {
              phone: from,
              customerName: draft.zohoCustomerName || draft.spokenCustomerName,
              zohoCustomerId: draft.zohoCustomerId,
              salesOrderId: soResponse.salesOrderId,
              salesOrderNumber: soResponse.salesOrderNumber,
              salesOrderPdf: soResponse.pdfLink,
              status: 'SALES_ORDER_CREATED',
              totalAmount: draft.grandTotal || 0
            }
          });

          // Update active session state to AWAITING_INVOICE_DECISION
          const nextDraftState = {
            ...draft,
            zohoSalesOrderId: soResponse.salesOrderId,
            salesOrderNumber: soResponse.salesOrderNumber
          } as any;

          await SessionService.saveSession(from, 'AWAITING_INVOICE_DECISION', nextDraftState);

          // Send confirmation via WhatsApp with button to create Invoice
          const successMessage = `✅ *Sales Order Created!* \n\n*Order No:* ${soResponse.salesOrderNumber}\n*Customer:* ${draft.zohoCustomerName}\n*Total:* ₹${draft.grandTotal?.toFixed(2)}\n📄 *PDF:* ${soResponse.pdfLink}\n\nWould you like to generate the Invoice now?`;
          
          await WhatsAppService.sendInteractiveButtons(from, successMessage, [
            { id: 'btn_invoice_create', title: '📄 Create Invoice' },
            { id: 'btn_finish', title: '🏁 Finish Flow' }
          ]);
        } else {
          await WhatsAppService.sendTextMessage(from, "No active order draft found to confirm. Say e.g. 'Order for Murugan Stores 10 cement' to start a new order.");
        }
        return;
      }

      // If user triggers Invoice generation
      if (action === 'INVOICE' || (message.text?.trim() === 'btn_invoice_create')) {
        if (session.state === 'AWAITING_INVOICE_DECISION' && session.draft) {
          const draft: any = session.draft;
          const salesOrderId = draft.zohoSalesOrderId;
          
          if (!salesOrderId) {
            await WhatsAppService.sendTextMessage(from, '⚠️ Error: No active Sales Order ID found in session. Please start a new order.');
            return;
          }

          // Convert Sales Order to Invoice in Zoho
          const invResponse = await ZohoService.convertSalesOrderToInvoice(salesOrderId);

          // Update DB log
          await prisma.orderLog.updateMany({
            where: { salesOrderId },
            data: {
              invoiceId: invResponse.invoiceId,
              invoiceNumber: invResponse.invoiceNumber,
              invoicePdf: invResponse.pdfLink,
              status: 'INVOICED'
            }
          });

          // Clear active session
          await SessionService.clearSession(from);

          // Send confirmation message
          const invoiceMsg = `🧾 *Invoice Generated!* \n\n*Invoice No:* ${invResponse.invoiceNumber}\n📄 *PDF:* ${invResponse.pdfLink}\n\nThank you for using Zoho Voice Automation!`;
          await WhatsAppService.sendTextMessage(from, invoiceMsg);
        } else {
          await WhatsAppService.sendTextMessage(from, 'Please create a Sales Order first before requesting an Invoice.');
        }
        return;
      }

      if (message.text?.trim() === 'btn_finish') {
        await SessionService.clearSession(from);
        await WhatsAppService.sendTextMessage(from, '🏁 Workflow finished. Thank you!');
        return;
      }

      // Processing a creation or a correction:
      let newDraft: DraftOrder;
      
      if (session.state === 'AWAITING_CONFIRMATION' && session.draft) {
        // Step 9: Handle Voice Corrections (merge new transcription with previous draft)
        console.log(`[QueueService] Active draft exists for ${from}. Merging correction.`);
        newDraft = await OpenAIService.mergeCorrection(session.draft, transcription);
      } else {
        // Step 3: New Draft order
        newDraft = parsedDraft;
      }

      // Step 4 & 5: Validate customer and products against Zoho
      await this.validateAndEnrichDraft(newDraft);

      // Save draft in session and set state to AWAITING_CONFIRMATION
      await SessionService.saveSession(from, 'AWAITING_CONFIRMATION', newDraft);

      // Step 8: Send confirmation message
      await this.sendDraftConfirmation(from, newDraft);

    } catch (error: any) {
      console.error(`[QueueService] Error handling message ${message.messageId}:`, error);
      await WhatsAppService.sendTextMessage(from, `⚠️ An error occurred while processing your request: "${error.message}". Retrying is recommended.`);
    }
  }

  /**
   * Queries Zoho Inventory, performs fuzzy matching, and calculates prices and taxes
   */
  private static async validateAndEnrichDraft(draft: DraftOrder): Promise<void> {
    draft.warnings = [];

    // 1. Customer Verification
    if (draft.spokenCustomerName) {
      const customers = await ZohoService.searchCustomers();
      const match = MatcherService.match(draft.spokenCustomerName, customers, (c) => c.contact_name);
      
      if (match && match.status !== 'NOT_FOUND') {
        draft.zohoCustomerId = match.item.contact_id;
        draft.zohoCustomerName = match.item.contact_name;
        draft.customerMatchedStatus = match.status;
        draft.customerMatchScore = match.score;
        
        // Cache this mapping for future orders
        try {
          await prisma.customerMapping.upsert({
            where: { spokenName: draft.spokenCustomerName },
            update: { zohoCustomerId: match.item.contact_id, zohoCustomerName: match.item.contact_name },
            create: { spokenName: draft.spokenCustomerName, zohoCustomerId: match.item.contact_id, zohoCustomerName: match.item.contact_name }
          });
        } catch (e) {}
      } else {
        draft.customerMatchedStatus = 'NOT_FOUND';
        draft.warnings.push(`Customer "${draft.spokenCustomerName}" not found in Zoho.`);
      }
    } else {
      draft.customerMatchedStatus = 'NOT_FOUND';
      draft.warnings.push('No customer name was specified in the request.');
    }

    // 2. Product Verification & Stock Verification
    const zohoItems = await ZohoService.searchItems();
    let computedTotal = 0;
    let computedTax = 0;

    for (const item of draft.items) {
      const match = MatcherService.match(item.name, zohoItems, (i) => i.name);
      
      if (match && match.status !== 'NOT_FOUND') {
        const zItem = match.item;
        item.zohoItemId = zItem.item_id;
        item.zohoItemName = zItem.name;
        item.zohoRate = zItem.rate;
        item.sku = zItem.sku;
        item.stockAvailable = zItem.stock_on_hand;
        item.taxPercentage = zItem.tax_percentage || 0;
        item.unit = zItem.unit;
        item.matchedStatus = match.status;
        item.matchScore = match.score;

        // Auto-fill price logic: prioritize standard Zoho selling price unless overridden
        const finalRate = item.rate ?? zItem.rate;
        item.rate = finalRate;

        // Stock check
        if (item.quantity > zItem.stock_on_hand) {
          draft.warnings.push(`⚠️ Stock low for "${zItem.name}" (Requested: ${item.quantity}, Stock: ${zItem.stock_on_hand})`);
        }

        const lineTotal = item.quantity * finalRate;
        computedTotal += lineTotal;
        computedTax += lineTotal * (item.taxPercentage / 100);
      } else {
        item.matchedStatus = 'NOT_FOUND';
        draft.warnings.push(`⚠️ Product "${item.name}" not found in Zoho.`);
      }
    }

    draft.totalAmount = computedTotal;
    draft.taxAmount = computedTax;
    draft.grandTotal = computedTotal + computedTax;
  }

  /**
   * Prepares and sends the confirmation text block with quick replies
   */
  private static async sendDraftConfirmation(to: string, draft: DraftOrder): Promise<void> {
    const customerLine = draft.zohoCustomerName 
      ? `👤 *Customer:* ${draft.zohoCustomerName} ${draft.customerMatchedStatus === 'FUZZY_MATCHED' ? '(Fuzzy Matched)' : ''}`
      : `👤 *Customer:* ❌ Not Found (Spoke: "${draft.spokenCustomerName}")`;

    let itemsLines = '';
    draft.items.forEach((it, idx) => {
      const itemTitle = it.zohoItemName || it.name;
      const statusLabel = it.matchedStatus === 'NOT_FOUND' 
        ? '❌ Not Found'
        : (it.stockAvailable && it.quantity > it.stockAvailable)
          ? `⚠️ Low Stock (${it.stockAvailable} left)`
          : '✅ In Stock';
      
      const rateVal = it.rate ?? 0;
      itemsLines += `${idx + 1}. *${itemTitle}* x ${it.quantity} ${it.unit || 'units'} @ ₹${rateVal} = ₹${(it.quantity * rateVal).toFixed(2)} [${statusLabel}]\n`;
    });

    const warningsLine = (draft.warnings && draft.warnings.length > 0)
      ? `\n*Warnings:*\n${draft.warnings.map(w => `• ${w}`).join('\n')}\n`
      : '';

    const notesLine = draft.notes ? `*Notes:* ${draft.notes}\n` : '';

    const textTemplate = `📝 *Draft Sales Order Review* \n\n${customerLine}\n\n*Items:*\n${itemsLines}\n${notesLine}${warningsLine}\n*Subtotal:* ₹${draft.totalAmount?.toFixed(2)}\n*Tax:* ₹${draft.taxAmount?.toFixed(2)}\n*Grand Total:* ₹${draft.grandTotal?.toFixed(2)}\n\nReply with: \n✅ *OK / Confirm* to save.\n🎤 *Send Voice* to edit.\n❌ *Cancel* to discard.`;

    await WhatsAppService.sendInteractiveButtons(to, textTemplate, [
      { id: 'btn_confirm', title: '✅ Confirm Order' },
      { id: 'btn_cancel', title: '❌ Cancel' }
    ]);
  }
}
