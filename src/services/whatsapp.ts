import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface WhatsAppMessageLog {
  timestamp: string;
  to: string;
  type: string;
  content: string;
  buttons?: Array<{ id: string; title: string }>;
}

export class WhatsAppService {
  // Memory log for mock dashboard display
  static sentMessagesLog: WhatsAppMessageLog[] = [];

  /**
   * Logs a message send event for local developer dashboard visualization
   */
  private static logMessage(to: string, type: string, content: string, buttons?: Array<{ id: string; title: string }>) {
    this.sentMessagesLog.push({
      timestamp: new Date().toLocaleTimeString(),
      to,
      type,
      content,
      buttons
    });
    // Cap log at 100 entries
    if (this.sentMessagesLog.length > 100) {
      this.sentMessagesLog.shift();
    }
  }

  /**
   * Downloads WhatsApp audio attachment using Media API
   */
  static async downloadMedia(mediaId: string): Promise<string> {
    const tempDir = path.join(process.cwd(), 'scratch');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const localFilePath = path.join(tempDir, `audio_${mediaId}_${Date.now()}.ogg`);

    if (config.MOCK_ALL) {
      console.log(`[WhatsAppService] [MOCK] Downloading media ID ${mediaId} to ${localFilePath}`);
      // Write a tiny dummy file to satisfy fs checks
      fs.writeFileSync(localFilePath, 'dummy audio data');
      return localFilePath;
    }

    try {
      console.log(`[WhatsAppService] Fetching media URL for ${mediaId}...`);
      // Step 1: Get media URL
      const mediaResponse = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` }
      });

      const mediaUrl = mediaResponse.data?.url;
      if (!mediaUrl) {
        throw new Error('No media URL found in WhatsApp response');
      }

      console.log(`[WhatsAppService] Downloading binary from: ${mediaUrl}`);
      // Step 2: Download binary data
      const writer = fs.createWriteStream(localFilePath);
      const downloadResponse = await axios({
        method: 'get',
        url: mediaUrl,
        responseType: 'stream',
        headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}` }
      });

      downloadResponse.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(localFilePath));
        writer.on('error', (err) => {
          console.error('[WhatsAppService] File write error:', err);
          reject(err);
        });
      });
    } catch (error: any) {
      console.error('[WhatsAppService] Failed downloading WhatsApp media:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Sends a simple text message via WhatsApp Business API
   */
  static async sendTextMessage(to: string, text: string): Promise<void> {
    console.log(`[WhatsAppService] Sending text to ${to}:\n"""\n${text}\n"""`);
    this.logMessage(to, 'text', text);

    if (config.MOCK_ALL) {
      return;
    }

    try {
      await axios.post(
        `https://graph.facebook.com/v17.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: false,
            body: text
          }
        },
        {
          headers: {
            Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error: any) {
      console.error('[WhatsAppService] Error sending text message:', error.response?.data || error.message);
    }
  }

  /**
   * Sends interactive reply buttons to confirm/cancel an order
   */
  static async sendInteractiveButtons(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<void> {
    console.log(`[WhatsAppService] Sending buttons to ${to}:\n"${bodyText}"\nButtons: ${JSON.stringify(buttons)}`);
    this.logMessage(to, 'interactive-buttons', bodyText, buttons);

    if (config.MOCK_ALL) {
      return;
    }

    try {
      await axios.post(
        `https://graph.facebook.com/v17.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
              buttons: buttons.slice(0, 3).map((btn) => ({
                type: 'reply',
                reply: {
                  id: btn.id,
                  title: btn.title.substring(0, 20) // Meta button title limit is 20 chars
                }
              }))
            }
          }
        },
        {
          headers: {
            Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (error: any) {
      console.error('[WhatsAppService] Error sending interactive buttons:', error.response?.data || error.message);
      // Fallback to text message if buttons fail
      const buttonsLabel = buttons.map(b => `[${b.title}]`).join('  ');
      await this.sendTextMessage(to, `${bodyText}\n\nType: ${buttonsLabel}`);
    }
  }
}
