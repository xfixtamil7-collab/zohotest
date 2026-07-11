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

      if (action === 'EDIT') {
        const soNumber = parsedDraft.editingSalesOrderNumber;
        const invNumber = parsedDraft.editingInvoiceNumber;
        
        if (!soNumber && !invNumber) {
          await WhatsAppService.sendTextMessage(from, '⚠️ Please specify a valid Sales Order number (e.g. SO-12345) or Invoice number (e.g. INV-12345) to edit.');
          return;
        }

        let fetchedDraft: DraftOrder;

        try {
          if (soNumber) {
            console.log(`[QueueService] Fetching Sales Order details for ${soNumber}`);
            const salesOrder = await ZohoService.getSalesOrderByNumber(soNumber);
            const currencyDetails = await ZohoService.getOrganizationCurrency();
            fetchedDraft = {
              spokenCustomerName: salesOrder.customer_name,
              zohoCustomerId: salesOrder.customer_id,
              zohoCustomerName: salesOrder.customer_name,
              editingSalesOrderId: salesOrder.salesorder_id,
              editingSalesOrderNumber: salesOrder.salesorder_number,
              currency: salesOrder.currency_symbol || currencyDetails.symbol,
              currencyCode: salesOrder.currency_code || currencyDetails.code,
              items: (salesOrder.line_items || []).map((it: any) => ({
                name: it.name,
                zohoItemId: it.item_id,
                zohoItemName: it.name,
                zohoLineItemId: it.line_item_id,
                quantity: it.quantity,
                rate: it.rate,
                zohoRate: it.rate,
                unit: it.unit,
                reference: it.custom_field_hash?.cf_reference || undefined
              })),
              notes: salesOrder.notes,
              deliveryDate: salesOrder.shipment_date
            };
          } else {
            console.log(`[QueueService] Fetching Invoice details for ${invNumber}`);
            const invoice = await ZohoService.getInvoiceByNumber(invNumber!);
            const currencyDetails = await ZohoService.getOrganizationCurrency();
            fetchedDraft = {
              spokenCustomerName: invoice.customer_name,
              zohoCustomerId: invoice.role === 'customer' ? invoice.customer_id : (invoice.customer_id || ''),
              zohoCustomerName: invoice.customer_name,
              editingInvoiceId: invoice.invoice_id,
              editingInvoiceNumber: invoice.invoice_number,
              currency: invoice.currency_symbol || currencyDetails.symbol,
              currencyCode: invoice.currency_code || currencyDetails.code,
              items: (invoice.line_items || []).map((it: any) => ({
                name: it.name,
                zohoItemId: it.item_id,
                zohoItemName: it.name,
                zohoLineItemId: it.line_item_id,
                quantity: it.quantity,
                rate: it.rate,
                zohoRate: it.rate,
                unit: it.unit,
                reference: it.custom_field_hash?.cf_reference || undefined
              })),
              notes: invoice.notes
            };
          }
        } catch (err: any) {
          console.error(`[QueueService] Failed to fetch target details for edit:`, err.message);
          await WhatsAppService.sendTextMessage(from, `⚠️ Error: Could not find or load order details: ${err.message}`);
          return;
        }

        // Apply voice/text correction if correction details exist
        let newDraft = fetchedDraft;
        const correctionText = parsedDraft.editCorrection || transcription;
        // Check if there is actual editing content inside transcription beyond just loading the target
        const hasCorrection = correctionText.toLowerCase().replace(/so-?\d+|inv-?\d+|edit|update|change|maathu|maathunga/g, '').trim().length > 2;

        if (hasCorrection) {
          console.log(`[QueueService] Applying edit correction: "${correctionText}"`);
          newDraft = await OpenAIService.mergeCorrection(fetchedDraft, correctionText);
        }

        // Validate and enrich
        await this.validateAndEnrichDraft(newDraft);

        // Save session & set state to AWAITING_CONFIRMATION
        await SessionService.saveSession(from, 'AWAITING_CONFIRMATION', newDraft);

        // Send draft review confirmation message
        await this.sendDraftConfirmation(from, newDraft);
        return;
      }

      // If user confirms a draft
      if (action === 'CONFIRM') {
        if (session.state === 'AWAITING_CONFIRMATION' && session.draft) {
          const draft = session.draft;
          const activeAccount = await ZohoService.getActiveAccount();
          const zohoAccountId = activeAccount?.id || null;
          
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

          // If editing an existing Sales Order
          if (draft.editingSalesOrderId) {
            console.log(`[QueueService] Updating existing Sales Order ${draft.editingSalesOrderNumber}`);
            
            const salesOrderItems = matchedItems.map(it => ({
              itemId: it.zohoItemId!,
              quantity: it.quantity,
              rate: it.rate ?? it.zohoRate ?? 0,
              reference: it.reference,
              zohoLineItemId: it.zohoLineItemId
            }));

            const soResponse = await ZohoService.updateSalesOrder(draft.editingSalesOrderId, {
              customerId: draft.zohoCustomerId,
              items: salesOrderItems,
              notes: draft.notes,
              deliveryDate: draft.deliveryDate
            });

            // Update DB Log or create if missing
            const existingLog = await prisma.orderLog.findFirst({
              where: { salesOrderId: draft.editingSalesOrderId }
            });

            if (existingLog) {
              await prisma.orderLog.updateMany({
                where: { salesOrderId: draft.editingSalesOrderId },
                data: {
                  totalAmount: draft.grandTotal || 0,
                  status: 'SALES_ORDER_UPDATED',
                  zohoAccountId
                }
              });
            } else {
              await prisma.orderLog.create({
                data: {
                  phone: from,
                  customerName: draft.zohoCustomerName || draft.spokenCustomerName,
                  zohoCustomerId: draft.zohoCustomerId,
                  salesOrderId: draft.editingSalesOrderId,
                  salesOrderNumber: draft.editingSalesOrderNumber || '',
                  salesOrderPdf: soResponse.pdfLink,
                  status: 'SALES_ORDER_UPDATED',
                  totalAmount: draft.grandTotal || 0,
                  zohoAccountId
                }
              });
            }

            const nextDraftState = {
              ...draft,
              zohoSalesOrderId: soResponse.salesOrderId,
              salesOrderNumber: soResponse.salesOrderNumber
            } as any;

            await SessionService.saveSession(from, 'AWAITING_INVOICE_DECISION', nextDraftState);

            const successMessage = `✅ *Sales Order Updated!* \n\n*Order No:* ${soResponse.salesOrderNumber}\n*Customer:* ${draft.zohoCustomerName}\n*Total:* ${draft.currency || '₹'}${draft.grandTotal?.toFixed(2)}\n📄 *PDF:* ${soResponse.pdfLink}\n\nWould you like to generate the Invoice now?`;
            
            await WhatsAppService.sendInteractiveButtons(from, successMessage, [
              { id: 'btn_invoice_create', title: '📄 Create Invoice' },
              { id: 'btn_finish', title: '🏁 Finish Flow' }
            ]);
            return;
          }

          // If editing an existing Invoice
          if (draft.editingInvoiceId) {
            console.log(`[QueueService] Updating existing Invoice ${draft.editingInvoiceNumber}`);

            const invoiceItems = matchedItems.map(it => ({
              itemId: it.zohoItemId!,
              quantity: it.quantity,
              rate: it.rate ?? it.zohoRate ?? 0,
              reference: it.reference,
              zohoLineItemId: it.zohoLineItemId
            }));

            const invResponse = await ZohoService.updateInvoice(draft.editingInvoiceId, {
              customerId: draft.zohoCustomerId,
              items: invoiceItems,
              notes: draft.notes
            });

            const existingLog = await prisma.orderLog.findFirst({
              where: { invoiceId: draft.editingInvoiceId }
            });

            if (existingLog) {
              await prisma.orderLog.updateMany({
                where: { invoiceId: draft.editingInvoiceId },
                data: {
                  totalAmount: draft.grandTotal || 0,
                  status: 'INVOICE_UPDATED',
                  zohoAccountId
                }
              });
            } else {
              await prisma.orderLog.create({
                data: {
                  phone: from,
                  customerName: draft.zohoCustomerName || draft.spokenCustomerName,
                  zohoCustomerId: draft.zohoCustomerId,
                  salesOrderId: '',
                  salesOrderNumber: '',
                  invoiceId: draft.editingInvoiceId,
                  invoiceNumber: draft.editingInvoiceNumber,
                  invoicePdf: invResponse.pdfLink,
                  status: 'INVOICE_UPDATED',
                  totalAmount: draft.grandTotal || 0,
                  zohoAccountId
                }
              });
            }

            await SessionService.clearSession(from);

            const successMessage = `✅ *Invoice Updated!* \n\n*Invoice No:* ${draft.editingInvoiceNumber}\n📄 *PDF:* ${invResponse.pdfLink}\n\nThank you for using Zoho Voice Automation!`;
            await WhatsAppService.sendTextMessage(from, successMessage);
            return;
          }

          // Create Sales Order in Zoho
          const salesOrderItems = matchedItems.map(it => ({
            itemId: it.zohoItemId!,
            quantity: it.quantity,
            rate: it.rate ?? it.zohoRate ?? 0,
            reference: it.reference
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
              totalAmount: draft.grandTotal || 0,
              zohoAccountId
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
          const successMessage = `✅ *Sales Order Created!* \n\n*Order No:* ${soResponse.salesOrderNumber}\n*Customer:* ${draft.zohoCustomerName}\n*Total:* ${draft.currency || '₹'}${draft.grandTotal?.toFixed(2)}\n📄 *PDF:* ${soResponse.pdfLink}\n\nWould you like to generate the Invoice now?`;
          
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
          const activeAccount = await ZohoService.getActiveAccount();
          const zohoAccountId = activeAccount?.id || null;
          
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
              status: 'INVOICED',
              zohoAccountId
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

      // ✨ SMART QUANTITY INFERENCE: For items with a target total + price range,
      // find the optimal (qty, rate) pair that produces the EXACT total.
      for (const item of newDraft.items) {
        if (item.inferredQuantity && item.targetTotal && item.priceRangeMin !== undefined && item.priceRangeMax !== undefined) {
          const optimal = QueueService.inferOptimalQuantity(
            item.targetTotal,
            item.priceRangeMin,
            item.priceRangeMax
          );
          if (optimal) {
            console.log(`[QueueService] ✨ Optimal quantity for "${item.name}": ${optimal.quantity} bags @ €${optimal.rate} = €${(optimal.quantity * optimal.rate).toFixed(2)} (target: €${item.targetTotal})`);
            item.quantity = optimal.quantity;
            item.rate = optimal.rate;
          }
        }
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

    // Propagate currency from items if not already set at draft level
    if (!draft.currency && draft.items.length > 0) {
      const itemWithCurrency = draft.items.find(it => it.currency);
      if (itemWithCurrency) {
        draft.currency = itemWithCurrency.currency;
        draft.currencyCode = itemWithCurrency.currencyCode;
      }
    }
    // Default to Zoho organization's currency if still not set
    if (!draft.currency) {
      try {
        const currencyDetails = await ZohoService.getOrganizationCurrency();
        draft.currency = currencyDetails.symbol;
        draft.currencyCode = currencyDetails.code;
      } catch (err) {
        draft.currency = '₹';
        draft.currencyCode = 'INR';
      }
    }
  }

  /**
   * ✨ Finds the optimal (quantity, rate) pair that produces EXACTLY the target total.
   * Searches all valid quantities where rate is within [priceMin, priceMax].
   * Prefers round quantities (1000, 500, 100, 50, 10) for cleaner orders.
   *
   * Example: targetTotal=37900, priceMin=30, priceMax=40
   *   -> qty range: ceil(37900/40)=948 to floor(37900/30)=1263
   *   -> qty=1000: rate=37.90 ✔️ (round number, within range)
   *   -> Returns { quantity: 1000, rate: 37.90 } => 1000 × 37.90 = €37,900 ✅ exact!
   */
  private static inferOptimalQuantity(
    targetTotal: number,
    priceMin: number,
    priceMax: number
  ): { quantity: number; rate: number } | null {
    const qtyMin = Math.ceil(targetTotal / priceMax);
    const qtyMax = Math.floor(targetTotal / priceMin);

    if (qtyMin > qtyMax || qtyMin <= 0) return null;

    // Collect ALL valid (qty, rate) candidates
    const candidates: { quantity: number; rate: number; roundness: number }[] = [];

    for (let qty = qtyMin; qty <= qtyMax; qty++) {
      const rate = targetTotal / qty;
      // Rate must be within the specified price range
      if (rate >= priceMin && rate <= priceMax) {
        candidates.push({
          quantity: qty,
          rate: parseFloat(rate.toFixed(4)),
          roundness: QueueService.getRoundness(qty)
        });
      }
    }

    if (candidates.length === 0) {
      // Fallback: no exact match found, use best approximation (midpoint)
      const midRate = (priceMin + priceMax) / 2;
      const qty = Math.round(targetTotal / midRate);
      return { quantity: qty, rate: parseFloat(midRate.toFixed(4)) };
    }

    // Sort by roundness DESC (prefer 1000 > 500 > 100 > 50 > 10 > others)
    candidates.sort((a, b) => {
      if (b.roundness !== a.roundness) return b.roundness - a.roundness;
      // Tiebreak: prefer quantities closer to a 'nice' mid-range
      const midQty = (qtyMin + qtyMax) / 2;
      return Math.abs(a.quantity - midQty) - Math.abs(b.quantity - midQty);
    });

    const best = candidates[0];
    console.log(`[QueueService] ✨ inferOptimalQuantity: ${candidates.length} candidates found. Best: qty=${best.quantity}, rate=${best.rate} (roundness=${best.roundness})`);
    return { quantity: best.quantity, rate: best.rate };
  }

  /**
   * Rates how "round" a number is — used to prefer cleaner order quantities.
   * 1000 → 5, 500 → 4, 100 → 3, 50 → 2, 10 → 1, others → 0
   */
  private static getRoundness(n: number): number {
    if (n % 1000 === 0) return 5;
    if (n % 500 === 0) return 4;
    if (n % 100 === 0) return 3;
    if (n % 50 === 0) return 2;
    if (n % 10 === 0) return 1;
    return 0;
  }

  /**
   * Prepares and sends the confirmation text block with quick replies
   */
  private static async sendDraftConfirmation(to: string, draft: DraftOrder): Promise<void> {
    const cur = draft.currency || '₹';
    const customerLine = draft.zohoCustomerName
      ? `👤 *Customer:* ${draft.zohoCustomerName} ${draft.customerMatchedStatus === 'FUZZY_MATCHED' ? '(Fuzzy Matched)' : ''}`
      : `👤 *Customer:* ${draft.spokenCustomerName ? `❌ Not Found (Spoke: "${draft.spokenCustomerName}")` : 'Walk-in / Not Specified'}`;

    let itemsLines = '';
    draft.items.forEach((it, idx) => {
      const itemTitle = it.zohoItemName || it.name;
      const statusLabel = it.matchedStatus === 'NOT_FOUND'
        ? '❌ Not Found'
        : (it.stockAvailable && it.quantity > it.stockAvailable)
          ? `⚠️ Low Stock (${it.stockAvailable} left)`
          : '✅ In Stock';

      const rateVal = it.rate ?? 0;
      const lineTotal = it.quantity * rateVal;

      // Price range display — show exact rate if inferred, otherwise show range
      let priceDisplay: string;
      if (it.priceRangeMin !== undefined && it.priceRangeMax !== undefined) {
        priceDisplay = `${cur}${rateVal} (range: ${cur}${it.priceRangeMin}\u2013${cur}${it.priceRangeMax})`;
      } else {
        priceDisplay = `${cur}${rateVal}`;
      }

      const inferredBadge = it.inferredQuantity ? ' ⚡ Exact Qty Match' : '';
      itemsLines += `${idx + 1}. *${itemTitle}* x ${it.quantity} ${it.unit || 'units'} @ ${priceDisplay} = ${cur}${lineTotal.toFixed(2)} [${statusLabel}]${inferredBadge}\n`;
    });

    const warningsLine = (draft.warnings && draft.warnings.length > 0)
      ? `\n*Warnings:*\n${draft.warnings.map(w => `• ${w}`).join('\n')}\n`
      : '';

    const notesLine = draft.notes ? `*Notes:* ${draft.notes}\n` : '';

    let reviewTitle = '📝 *Draft Sales Order Review*';
    let confirmBtnText = '✅ Confirm Order';
    if (draft.editingSalesOrderNumber) {
      reviewTitle = `📝 *Draft Sales Order Edit Review (${draft.editingSalesOrderNumber})*`;
      confirmBtnText = '✅ Confirm Edit';
    } else if (draft.editingInvoiceNumber) {
      reviewTitle = `📝 *Draft Invoice Edit Review (${draft.editingInvoiceNumber})*`;
      confirmBtnText = '✅ Confirm Edit';
    }

    const textTemplate = `${reviewTitle} \n\n${customerLine}\n\n*Items:*\n${itemsLines}\n${notesLine}${warningsLine}\n*Subtotal:* ${cur}${draft.totalAmount?.toFixed(2)}\n*Tax:* ${cur}${draft.taxAmount?.toFixed(2)}\n*Grand Total:* ${cur}${draft.grandTotal?.toFixed(2)}\n\nReply with: \n✅ *OK / Confirm* to save.\n🎤 *Send Voice* to edit.\n❌ *Cancel* to discard.`;

    await WhatsAppService.sendInteractiveButtons(to, textTemplate, [
      { id: 'btn_confirm', title: confirmBtnText },
      { id: 'btn_cancel', title: '❌ Cancel' }
    ]);
  }
}
