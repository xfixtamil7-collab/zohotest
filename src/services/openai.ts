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
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1',
      });
      return transcription.text;
    } catch (error) {
      console.error('[OpenAIService] Whisper transcription failed:', error);
      throw error;
    }
  }

  /**
   * Parses order details from a text transcription using GPT-4o.
   */
  static async parseIntent(transcription: string): Promise<{
    draft: DraftOrder;
    action: 'CREATE' | 'CONFIRM' | 'CANCEL' | 'INVOICE' | 'NONE';
  }> {
    const cleanText = transcription.trim().toLowerCase();
    
    // Explicit Button and Keyword Action resolution
    let action: 'CREATE' | 'CONFIRM' | 'CANCEL' | 'INVOICE' | 'NONE' = 'CREATE';
    if (cleanText === 'btn_confirm' || cleanText.match(/\b(ok|confirm|approve|yes|seri)\b/)) {
      action = 'CONFIRM';
    } else if (cleanText === 'btn_cancel' || cleanText.match(/\b(cancel|vendam|discard)\b/)) {
      action = 'CANCEL';
    } else if (cleanText === 'btn_invoice_create' || cleanText.match(/\b(invoice|bill)\b/)) {
      action = 'INVOICE';
    }

    // For confirmation, cancellation, or invoicing actions, we don't need to parse a new draft.
    if (action !== 'CREATE') {
      return {
        action,
        draft: { spokenCustomerName: '', items: [] }
      };
    }

    if (config.MOCK_ALL) {
      console.log(`[OpenAIService] [MOCK] Parsing transcription: "${transcription}"`);
      
      // Simulate parsing of Murugan Stores
      if (cleanText.includes('murugan') || cleanText.includes('cement')) {
        return {
          action,
          draft: {
            spokenCustomerName: 'Murugan Stores',
            items: [
              { name: 'Cement', quantity: 10 },
              { name: 'Steel Rod', quantity: 5 }
            ],
            notes: 'Created via WhatsApp voice message'
          }
        };
      }

      // Standard fallback
      return {
        action,
        draft: {
          spokenCustomerName: 'Walk-in Customer',
          items: [
            { name: 'General Item', quantity: 1 }
          ]
        }
      };
    }

    try {
      const openai = this.getClient();
      const systemPrompt = `You are a Senior Order Parser AI. Your job is to extract business details from WhatsApp voice note transcriptions.
The language used by users can be English, Tamil, or Tanglish (Tamil transliterated in English alphabet, e.g. "Murugan Stores ku 10 cement, 5 steel rod podunga").

Analyze the transcription and extract:
1. Customer Name (spoken name)
2. List of Items (product name, quantity, rate if specified)
3. Action:
   - 'CONFIRM': if the message is a direct confirmation (e.g. "OK", "Confirm", "Approve", "Yes", "seri", "polaam", "podunga")
   - 'CANCEL': if they want to cancel the order (e.g. "Cancel", "vendam", "stop")
   - 'INVOICE': if they specifically ask to create an invoice/bill (e.g. "Invoice", "Create Invoice", "Bill", "Bill podunga")
   - 'CREATE': for new order details (default action)
4. Additional details like delivery date, notes, payment terms.

You must respond in strict JSON format matching the schema below:
{
  "action": "CREATE" | "CONFIRM" | "CANCEL" | "INVOICE",
  "spokenCustomerName": "extracted customer name or empty string if not found",
  "items": [
    {
      "name": "extracted item name",
      "quantity": number,
      "rate": number (optional, only if user explicitly states a price/rate)
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
      const action = result.action || 'CREATE';
      
      const draft: DraftOrder = {
        spokenCustomerName: result.spokenCustomerName || '',
        items: (result.items || []).map((i: any) => ({
          name: i.name,
          quantity: Number(i.quantity) || 1,
          rate: i.rate ? Number(i.rate) : undefined
        })),
        deliveryDate: result.deliveryDate,
        notes: result.notes,
        paymentTerms: result.paymentTerms
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
      if (correctionTranscription.toLowerCase().includes('steel rod') && correctionTranscription.toLowerCase().includes('8')) {
        const steelRodItem = updatedDraft.items.find(i => i.name.toLowerCase().includes('steel'));
        if (steelRodItem) {
          steelRodItem.quantity = 8;
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

Your job is to apply the corrections to the Draft Order, modifying only the fields/items explicitly mentioned. Maintain all other details (such as customer name, unchanged items, delivery dates, etc.) intact.
If the correction tells to change the quantity, rate, or add/remove products, do so.
Ensure the output is in the exact same Draft Order format.

Return ONLY a strict JSON object matching this schema:
{
  "spokenCustomerName": "customer name",
  "items": [
    {
      "name": "item name",
      "quantity": number,
      "rate": number (optional)
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
        items: (result.items || []).map((i: any) => ({
          name: i.name,
          quantity: Number(i.quantity) || 1,
          rate: i.rate ? Number(i.rate) : undefined
        })),
        deliveryDate: result.deliveryDate || oldDraft.deliveryDate,
        notes: result.notes || oldDraft.notes,
        paymentTerms: result.paymentTerms || oldDraft.paymentTerms
      };
    } catch (error) {
      console.error('[OpenAIService] GPT merge correction failed:', error);
      throw error;
    }
  }
}
