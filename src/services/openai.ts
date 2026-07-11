import { OpenAI } from 'openai';
import fs from 'fs';
import { config } from '../config';
import { DraftOrder } from '../types';

export class OpenAIService {
  private static openai: OpenAI | null = null;

  private static getClient(): OpenAI {
    if (!this.openai) {
      if (config.MOCK_ALL) {
        // Return a dummy client or we just check config.MOCK_ALL before calls
        this.openai = new OpenAI({ apiKey: 'mock-key' });
      } else {
        this.openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      }
    }
    return this.openai;
  }

  /**
   * Transcribes audio using OpenAI Whisper.
   */
  static async transcribeAudio(filePath: string): Promise<string> {
    if (config.MOCK_ALL) {
      console.log(`[OpenAIService] [MOCK] Transcribing audio file: ${filePath}`);
      // Return a simulated transcription based on filename or a default
      if (filePath.includes('steel_rod_quantity') || filePath.includes('correction')) {
        return 'Steel rod quantity 8 a maathunga.';
      }
      return 'Murugan Stores ku 10 cement, 5 steel rod podunga.';
    }

    try {
      const openai = this.getClient();
      // Note: No language lock - Whisper auto-detects Tamil/Tanglish/English.
      // The prompt below guides Whisper with key Tanglish vocabulary so it outputs
      // words like 'podunga', 'maathunga', 'vendam' correctly in Latin script.
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1',
        prompt: 'Murugan Stores ku 10 cement, 5 steel rod podunga. Maathunga. Vendam. Seri. Ok. Bill podunga. Invoice podunga. SO-12345 edit pannunga. INV-12345 maathunga. Quantity 10. Rate 500. Cement, steel rod, brick, sand, rice bag. Correct ah varanum. Polaam. Confirm pannunga. Cancel pannunga. Customer name, company name, order, total amount.',
      });
      return transcription.text;
    } catch (error) {
      console.error('[OpenAIService] Whisper transcription failed:', error);
      throw error;
    }
  }

  /**
   * Correctly parses a French company director's name into actual First Name and Last Name.
   */
  static async parseDirectorName(rawName: string): Promise<{ firstName: string; lastName: string }> {
    if (config.MOCK_ALL) {
      // Mock parsing for tests
      const parts = rawName.trim().split(/\s+/);
      return {
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' ') || ''
      };
    }

    try {
      const openai = this.getClient();
      const prompt = `You are a naming convention expert. 
Given a French company director's name, extract their actual given name (First Name) and family name (Last Name). 
Note that in French official databases (RCS/Sirene/RNE), foreign names (especially Tamil/Sri Lankan/Indian names) are frequently registered in reverse order (swapped) where the father's name or family name is registered as "prénoms" (First Name) and the person's own given name is registered as "nom" (Last Name).
Examples:
- Input: "Thangarajah AMALARAJA" -> Output JSON: {"firstName": "Amalaraja", "lastName": "Thangarajah"}
- Input: "Nitharsan YOLINGAM" -> Output JSON: {"firstName": "Nitharsan", "lastName": "Yolingam"}
- Input: "Marc LEBLANC" -> Output JSON: {"firstName": "Marc", "lastName": "Leblanc"}
- Input: "Laila MOHANNA (KALDAS)" -> Output JSON: {"firstName": "Laila", "lastName": "Mohanna Kaldas"}

Return ONLY a valid JSON object with keys "firstName" and "lastName". No markdown, no explanation.

Input name: "${rawName}"`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      });

      const resText = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(resText);
      return {
        firstName: parsed.firstName || '',
        lastName: parsed.lastName || ''
      };
    } catch (error) {
      console.error('[OpenAIService] Failed to parse director name:', error);
      // Fallback to simple split
      const parts = rawName.trim().split(/\s+/);
      return {
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' ') || ''
      };
    }
  }

  /**
   * Parses order details from a text transcription using GPT-4o.
   */
  static async parseIntent(transcription: string): Promise<{
    draft: DraftOrder;
    action: 'CREATE' | 'CONFIRM' | 'CANCEL' | 'INVOICE' | 'EDIT' | 'NONE';
  }> {
    const cleanText = transcription.trim().toLowerCase();
    
    // Explicit Button and Keyword Action resolution
    let action: 'CREATE' | 'CONFIRM' | 'CANCEL' | 'INVOICE' | 'EDIT' | 'NONE' = 'CREATE';
    if (cleanText === 'btn_confirm' || cleanText.match(/\b(ok|confirm|approve|yes|seri|polaam)\b/) || cleanText.includes('சரி') || cleanText.includes('ஓகே') || cleanText.includes('போலாம்')) {
      action = 'CONFIRM';
    } else if (cleanText === 'btn_cancel' || cleanText.match(/\b(cancel|vendam|discard)\b/) || cleanText.includes('வேண்டாம்')) {
      action = 'CANCEL';
    } else if (cleanText === 'btn_invoice_create' || cleanText.match(/\b(invoice|bill)\b/) || cleanText.includes('பில்')) {
      // Check if they are trying to edit an invoice instead of generating one
      const isInvoiceEdit = (cleanText.match(/\b(edit|update|change|maathu|maathunga)\b/) || cleanText.includes('மாத்து') || cleanText.includes('மாத்துங்க')) && cleanText.match(/\binv-?\d+\b/);
      if (!isInvoiceEdit) {
        action = 'INVOICE';
      }
    }

    const hasTamilEditKeyword = cleanText.includes('மாத்துங்க') || cleanText.includes('மாத்து') || cleanText.match(/\b(edit|update|change|maathu|maathunga)\b/);
    const isSalesOrderEdit = hasTamilEditKeyword && cleanText.match(/\bso-?\d+\b/);
    const isInvoiceEdit = hasTamilEditKeyword && cleanText.match(/\binv-?\d+\b/);
    if (isSalesOrderEdit || isInvoiceEdit) {
      action = 'EDIT';
    }

    // For confirmation, cancellation, or invoicing actions, we don't need to parse a new draft.
    if (action !== 'CREATE' && action !== 'EDIT') {
      return {
        action,
        draft: { spokenCustomerName: '', items: [] }
      };
    }

    if (config.MOCK_ALL) {
      console.log(`[OpenAIService] [MOCK] Parsing transcription: "${transcription}"`);

      // Mock scenario for editing
      if (cleanText.includes('edit') || cleanText.includes('update') || cleanText.includes('change') || cleanText.includes('maathu') || cleanText.includes('maathunga')) {
        const soMatch = cleanText.match(/\bso-?\d+\b/i);
        const invMatch = cleanText.match(/\binv-?\d+\b/i);
        if (soMatch) {
          const soNumber = soMatch[0].toUpperCase().replace(/SO-?/, 'SO-');
          return {
            action: 'EDIT',
            draft: {
              spokenCustomerName: 'Murugan Stores',
              editingSalesOrderNumber: soNumber,
              editCorrection: transcription.replace(new RegExp(soMatch[0], 'i'), '').replace(/\b(edit|update|change|maathu|maathunga)\b/ig, '').trim(),
              items: []
            }
          };
        } else if (invMatch) {
          const invNumber = invMatch[0].toUpperCase().replace(/INV-?/, 'INV-');
          return {
            action: 'EDIT',
            draft: {
              spokenCustomerName: 'Murugan Stores',
              editingInvoiceNumber: invNumber,
              editCorrection: transcription.replace(new RegExp(invMatch[0], 'i'), '').replace(/\b(edit|update|change|maathu|maathunga)\b/ig, '').trim(),
              items: []
            }
          };
        }
      }

      // Veera Ponni Rice 20kg scenario
      if (cleanText.includes('veera') || cleanText.includes('veera ponni') || (cleanText.includes('rice') && cleanText.includes('20'))) {
        const targetTotal = 37900;
        const priceMin = 30;
        const priceMax = 40;
        return {
          action: 'CREATE',
          draft: {
            spokenCustomerName: '',
            currency: '€',
            currencyCode: 'EUR',
            items: [
              {
                name: 'Veera Ponni Rice 20Kg',
                quantity: 1, // placeholder — queue.ts inferOptimalQuantity will compute the exact qty
                rate: 37.9,  // placeholder — will be corrected to exact rate
                priceRangeMin: priceMin,
                priceRangeMax: priceMax,
                inferredQuantity: true,
                targetTotal: targetTotal,
                currency: '€',
                currencyCode: 'EUR',
                unit: '20Kg Bags'
              }
            ],
            notes: `Qty auto-inferred from target total €${targetTotal} within price range €${priceMin}–€${priceMax}/bag`
          }
        };
      }

      // Rice bag 25Kg scenario
      if (cleanText.includes('rice') || cleanText.includes('rice bag')) {
        const targetTotal = 35961.34;
        const midRate = 35; // midpoint of 30-40
        const inferredQty = Math.round(targetTotal / midRate);
        return {
          action: 'CREATE',
          draft: {
            spokenCustomerName: '',
            currency: '€',
            currencyCode: 'EUR',
            items: [
              {
                name: 'Rice Bag 25Kg',
                quantity: inferredQty,
                rate: midRate,
                priceRangeMin: 30,
                priceRangeMax: 40,
                inferredQuantity: true,
                targetTotal: targetTotal,
                currency: '€',
                currencyCode: 'EUR',
                unit: '25Kg Bags'
              }
            ],
            notes: 'Qty auto-inferred from target total €35961.34 at midpoint rate €35/bag'
          }
        };
      }

      // Simulate parsing of Murugan Stores
      if (cleanText.includes('murugan') || cleanText.includes('cement')) {
        return {
          action: 'CREATE',
          draft: {
            spokenCustomerName: 'Murugan Stores',
            currency: '₹',
            currencyCode: 'INR',
            items: [
              { name: 'Cement', quantity: 10, currency: '₹', currencyCode: 'INR' },
              { name: 'Steel Rod', quantity: 5, currency: '₹', currencyCode: 'INR' }
            ],
            notes: 'Created via WhatsApp voice message'
          }
        };
      }

      // Standard fallback
      return {
        action: 'CREATE',
        draft: {
          spokenCustomerName: 'Walk-in Customer',
          currency: '₹',
          currencyCode: 'INR',
          items: [
            { name: 'General Item', quantity: 1 }
          ]
        }
      };
    }

    try {
      const openai = this.getClient();
      const systemPrompt = `You are a Senior Order Parser AI. Your job is to extract business details from WhatsApp voice note transcriptions, handling complex pricing and quantity inference scenarios.

The language used can be English, Tamil, or Tanglish (Tamil transliterated in English alphabet).
Common Tamil/Tanglish phrases and their meanings:
- "podunga" / "podu" / "போடுங்க" / "போடு" = place/put/add
- "maathunga" / "maathu" / "மாத்துங்க" / "மாத்து" = change/update
- "vendam" / "வேண்டாம்" = don't want / cancel
- "seri" / "ok" / "சரி" / "ஓகே" = confirmed / okay
- "sriya varanum" / "correct ah varanum" / "சரியா வரணும்" / "கரெக்டா வரணும்" / "சரியா வர மாதிரி" / "correct ahh vara maadhiri" = should come correctly (user instruction, NOT an order item)
- "qty your choice" / "quantity-a your choice set pannunga" / "அளவு உங்க இஷ்டம்" = let the system infer quantity
- "polaam" / "போலாம்" = let's go / confirm
- "vara maadhiri" / "வர மாதிரி" = should come like / should be
- "irukkanum" / "இருக்கணும்" = must be / should be

ANALYSIS RULES:
1. **Customer Name**: Extract spoken customer name, or empty string if none found.
2. **Currency Detection**: Detect currency from symbols (€=EUR, $=USD, ₹=INR, £=GBP) or words ("euro", "dollar", "rupee"). Return both the symbol and ISO code.
3. **Price Range Parsing**: If user says "price range 30€-40€" or "oru bag price €30–€40 range-kulla vara maadhiri", extract priceRangeMin and priceRangeMax.
4. **Exact Total Matching (CRITICAL)**: If user gives a target total (e.g. "Total €37900" or "Total Correct Amount €37900"), set targetTotal. Then find a quantity where qty × rate = targetTotal EXACTLY. Use the formula: quantity = targetTotal / rate where rate is within [priceRangeMin, priceRangeMax]. Set inferredQuantity=true. Prefer round quantities (1000, 500, 100).
5. **"qty your choice" or "quantity-a your choice"**: means infer the quantity from the target total. Set inferredQuantity=true.
6. **Product Size/Weight**: Include size in the name (e.g. "Veera Ponni Rice 20Kg") and set unit accordingly (e.g. "20Kg Bags").
7. **Meta-Instructions**: Phrases like "sriya varanum", "correct ah varanum", "vara maadhiri irukkanum" are user instructions, NOT items. Ignore them for item extraction.
8. **Action Detection**:
   - 'CONFIRM': "OK", "Confirm", "seri", "polaam", "சரி", "ஓகே", "போலாம்", "உறுதி செய்"
   - 'CANCEL': "Cancel", "vendam", "stop", "வேண்டாம்", "நிறுத்து"
   - 'INVOICE': "Invoice", "Bill", "Bill podunga", "பில்", "பில் போடுங்க" (Only when generating an invoice from a Sales Order)
   - 'EDIT': When the user explicitly requests to edit, update, or change an *already existing* Sales Order (e.g. referencing "SO-00001") or Invoice (e.g. referencing "INV-00001") using keywords like "edit", "update", "maathu", "மாத்து", "மாத்துங்க".
   - 'CREATE': default for new order details
9. **PRECISION RULE**: For inferred quantities, always compute quantity = Math.round(targetTotal / rate) where rate is the best rate within [priceRangeMin, priceRangeMax] that yields the cleanest round quantity. VERIFY: quantity × rate must equal targetTotal (or be within €0.01).

Respond in strict JSON:
{
  "action": "CREATE" | "CONFIRM" | "CANCEL" | "INVOICE" | "EDIT",
  "editTargetType": "salesorder" | "invoice" (only if action is EDIT),
  "editTargetNumber": "SO-XXXXX" or "INV-XXXXX" (only if action is EDIT),
  "editCorrection": "the instruction string of modifications, excluding the command to edit. E.g. 'quantity 8 a maathunga' or 'set steel rod quantity to 8'" (only if action is EDIT),
  "spokenCustomerName": "extracted customer name or empty string",
  "currency": "symbol e.g. € or ₹ or $",
  "currencyCode": "ISO code e.g. EUR or INR or USD",
  "items": [
    {
      "name": "extracted item name including size/weight if specified",
      "quantity": number,
      "rate": number,
      "reference": "line item reference e.g. '1 Pallet', 'Batch A', 'Lot 001'" (optional),
      "priceRangeMin": number (optional, lower bound of price range),
      "priceRangeMax": number (optional, upper bound of price range),
      "inferredQuantity": boolean (true if qty was computed from targetTotal/rate),
      "targetTotal": number (optional, stated total amount),
      "unit": "unit of measure e.g. Bags, Rods, Pcs, 20Kg Bags" (optional)
    }
  ],
  "deliveryDate": "YYYY-MM-DD" (optional),
  "notes": "any notes or instructions" (optional),
  "paymentTerms": "payment terms spoken" (optional)
}`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcription }
        ],
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      let action = result.action || 'CREATE';
      if (action === 'EDIT' && !result.editTargetNumber) {
        action = 'CREATE';
      }

      // Get the default organization currency
      let defaultCurrency = '₹';
      let defaultCurrencyCode = 'INR';
      try {
        const { ZohoService } = require('./zoho');
        const currencyDetails = await ZohoService.getOrganizationCurrency();
        defaultCurrency = currencyDetails.symbol;
        defaultCurrencyCode = currencyDetails.code;
      } catch (err) {
        // fallback
      }

      const draft: DraftOrder = {
        spokenCustomerName: result.spokenCustomerName || '',
        currency: result.currency || defaultCurrency,
        currencyCode: result.currencyCode || defaultCurrencyCode,
        items: (result.items || []).map((i: any) => ({
          name: i.name,
          quantity: Number(i.quantity) || 1,
          rate: i.rate ? Number(i.rate) : undefined,
          reference: i.reference || undefined,
          priceRangeMin: i.priceRangeMin ? Number(i.priceRangeMin) : undefined,
          priceRangeMax: i.priceRangeMax ? Number(i.priceRangeMax) : undefined,
          inferredQuantity: Boolean(i.inferredQuantity),
          targetTotal: i.targetTotal ? Number(i.targetTotal) : undefined,
          unit: i.unit,
          currency: result.currency || defaultCurrency,
          currencyCode: result.currencyCode || defaultCurrencyCode
        })),
        deliveryDate: result.deliveryDate,
        notes: result.notes,
        paymentTerms: result.paymentTerms,
        editingSalesOrderNumber: result.editTargetType === 'salesorder' ? result.editTargetNumber : undefined,
        editingInvoiceNumber: result.editTargetType === 'invoice' ? result.editTargetNumber : undefined,
        editCorrection: result.editCorrection
      };

      return { draft, action };
    } catch (error) {
      console.error('[OpenAIService] GPT parse intent failed:', error);
      throw error;
    }
  }

  /**
   * Merges a new voice correction with an existing draft order using GPT-4o.
   */
  static async mergeCorrection(oldDraft: DraftOrder, correctionTranscription: string): Promise<DraftOrder> {
    if (config.MOCK_ALL) {
      console.log(`[OpenAIService] [MOCK] Merging correction: "${correctionTranscription}"`);
      const updatedDraft = JSON.parse(JSON.stringify(oldDraft)) as DraftOrder;
      
      // Look for quantities to modify (mock logic)
      if (correctionTranscription.toLowerCase().includes('steel') && correctionTranscription.toLowerCase().includes('8')) {
        const steelRodItem = updatedDraft.items.find(i => i.name.toLowerCase().includes('steel'));
        if (steelRodItem) {
          steelRodItem.quantity = 8;
        }
      } else if (correctionTranscription.toLowerCase().includes('cement') && correctionTranscription.toLowerCase().includes('20')) {
        const cementItem = updatedDraft.items.find(i => i.name.toLowerCase().includes('cement'));
        if (cementItem) {
          cementItem.quantity = 20;
        }
      }
      
      // Update notes with correction log
      updatedDraft.notes = `${updatedDraft.notes || ''} (Updated: ${correctionTranscription})`;
      return updatedDraft;
    }

    try {
      const openai = this.getClient();
      const systemPrompt = `You are an Order Editor AI. You are provided with:
1. An existing Draft Order JSON.
2. A new transcription of a WhatsApp voice message containing corrections (which might be in English, Tamil, or Tanglish).

Your job is to apply the corrections to the Draft Order, modifying only the fields/items explicitly mentioned.
Maintain all other details (customer name, unchanged items, delivery dates, currency, priceRange fields, etc.) intact.
If the correction tells to change the quantity, rate, price range, or add/remove products, do so.
If the correction mentions a new target total with "qty your choice", recalculate quantity = Math.round(targetTotal / rate).
Preserve the currency symbol and currencyCode from the original draft unless explicitly changed.

Common Tamil/Tanglish correction phrases and their meanings:
- "maathunga" / "maathu" / "மாத்துங்க" / "மாத்து" = change/update/modify (e.g. "quantity 8 a maathunga" / "அளவை எட்டா மாத்துங்க" -> change quantity of the item to 8)
- "podunga" / "podu" / "போடுங்க" / "போடு" = place/put/add/insert
- "vendam" / "வேண்டாம்" = don't want / remove/delete
- "seri" / "ok" / "சரி" / "ஓகே" = confirmed / okay
- "so-12345 a edit pannunga" / "so-12345 a update pannunga" / "so-12345 a மாத்துங்க" = edit/update sales order SO-12345

Return ONLY a strict JSON object matching this schema:
{
  "spokenCustomerName": "customer name",
  "currency": "symbol",
  "currencyCode": "ISO code",
  "items": [
    {
      "name": "item name",
      "quantity": number,
      "rate": number (optional),
      "reference": "line item reference e.g. '1 Pallet', 'Batch A'" (optional),
      "priceRangeMin": number (optional),
      "priceRangeMax": number (optional),
      "inferredQuantity": boolean (optional),
      "targetTotal": number (optional),
      "unit": "unit" (optional)
    }
  ],
  "deliveryDate": "YYYY-MM-DD" (optional),
  "notes": "notes",
  "paymentTerms": "payment terms" (optional)
}`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Current Draft:\n${JSON.stringify(oldDraft, null, 2)}\n\nVoice Correction:\n"${correctionTranscription}"` }
        ],
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      return {
        spokenCustomerName: result.spokenCustomerName || oldDraft.spokenCustomerName,
        currency: result.currency || oldDraft.currency,
        currencyCode: result.currencyCode || oldDraft.currencyCode,
        items: (result.items || []).map((i: any) => {
          // Re-attach zohoLineItemId by matching name from original draft (GPT doesn't know Zoho internal IDs)
          const originalItem = oldDraft.items.find(
            old => old.name.toLowerCase() === (i.name || '').toLowerCase() ||
                   (old.zohoItemName || '').toLowerCase() === (i.name || '').toLowerCase()
          );
          return {
            name: i.name,
            quantity: Number(i.quantity) || 1,
            rate: i.rate ? Number(i.rate) : undefined,
            reference: i.reference !== undefined ? i.reference : originalItem?.reference,
            zohoLineItemId: originalItem?.zohoLineItemId,
            priceRangeMin: i.priceRangeMin ? Number(i.priceRangeMin) : undefined,
            priceRangeMax: i.priceRangeMax ? Number(i.priceRangeMax) : undefined,
            inferredQuantity: Boolean(i.inferredQuantity),
            targetTotal: i.targetTotal ? Number(i.targetTotal) : undefined,
            unit: i.unit,
            currency: result.currency || oldDraft.currency,
            currencyCode: result.currencyCode || oldDraft.currencyCode
          };
        }),
        deliveryDate: result.deliveryDate || oldDraft.deliveryDate,
        notes: result.notes || oldDraft.notes,
        paymentTerms: result.paymentTerms || oldDraft.paymentTerms,
        // Carry over edit-tracking fields so CONFIRM knows to UPDATE not CREATE
        editingSalesOrderId: oldDraft.editingSalesOrderId,
        editingSalesOrderNumber: oldDraft.editingSalesOrderNumber,
        editingInvoiceId: oldDraft.editingInvoiceId,
        editingInvoiceNumber: oldDraft.editingInvoiceNumber
      };
    } catch (error) {
      console.error('[OpenAIService] GPT merge correction failed:', error);
      throw error;
    }
  }

  /**
   * Converts Tamil text into Tanglish using GPT-4o.
   */
  static async convertToTanglish(text: string): Promise<string> {
    if (config.MOCK_ALL) {
      console.log(`[OpenAIService] [MOCK] Converting to Tanglish: "${text}"`);
      const clean = text.toLowerCase();
      if (clean.includes('எட்ட') || clean.includes('8') || clean.includes('மாத்துங்க')) {
        return 'Steel rod quantity 8 a maathunga.';
      }
      return 'Murugan Stores ku 10 cement, 5 steel rod podunga.';
    }

    try {
      const openai = this.getClient();
      const systemPrompt = `You are a helper AI that converts spoken Tamil text or English-Tamil mixtures into clean, readable Tanglish (Tamil language written in the English/Latin alphabet).
Rules:
1. Maintain the meaning and structure of the original text.
2. Transliterate all Tamil words phonetically using English letters (Latin script).
3. Do NOT translate Tamil words to English words (e.g. keep "poadunga" or "podunga" for "போடுங்க", don't write "put/place").
4. Keep standard English technical terms/nouns in English (e.g., "cement", "steel rod", "invoice", "quantity", customer names like "Murugan Stores").
5. Keep numbers as-is (e.g., "10", "5", "8").
6. Output ONLY the resulting Tanglish string, without any introduction, explanations, quotation marks, or notes.

Examples:
- "முருகன் ஸ்டோர்ஸ் க்கு 10 சிமெண்ட், 5 ஸ்டீல் ராடு போடுங்க" -> "Murugan Stores ku 10 cement, 5 steel rod podunga"
- "ஸ்டீல் ராடு அளவு எட்ட மாத்துங்க" -> "Steel rod quantity 8 a maathunga"
- "பில் போடுங்க" -> "Bill podunga"
- "சரி" -> "seri"
- "ஓகே" -> "ok"
- "வேண்டாம்" -> "vendam"
- "போலாம்" -> "polaam"
- "சிமெண்ட் அளவு 20 ஆ மாத்துங்க" -> "cement quantity 20 a maathunga"
- "SO-12345 a maathunga" -> "SO-12345 a maathunga"
- "INV-12345 a edit pannunga" -> "INV-12345 a edit pannunga"
- "கரெக்டா வரணும்" -> "correct ah varanum"
- "அளவு உங்க இஷ்டம் set pannunga" -> "quantity-a your choice set pannunga"`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0.3
      });

      return response.choices[0].message.content?.trim() || text;
    } catch (error) {
      console.error('[OpenAIService] Tanglish conversion failed:', error);
      throw error;
    }
  }
}
