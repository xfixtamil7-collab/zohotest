import { prisma } from '../prisma';
import { SessionData, DraftOrder } from '../types';

export class SessionService {
  /**
   * Retrieves an active session for a phone number or returns a fresh IDLE session if none exists.
   */
  static async getSession(phone: string): Promise<SessionData> {
    try {
      const session = await prisma.session.findUnique({
        where: { phone }
      });

      if (!session) {
        return {
          phone,
          state: 'IDLE',
          draft: null
        };
      }

      return {
        phone: session.phone,
        state: session.state as any,
        draft: session.draftJson ? JSON.parse(session.draftJson) : null
      };
    } catch (error) {
      console.error(`[SessionService] Error fetching session for ${phone}:`, error);
      // Fallback to in-memory state on DB error to maintain resilience
      return { phone, state: 'IDLE', draft: null };
    }
  }

  /**
   * Saves or updates a session for a phone number.
   */
  static async saveSession(phone: string, state: SessionData['state'], draft: DraftOrder | null): Promise<void> {
    try {
      const draftJson = draft ? JSON.stringify(draft) : '';
      await prisma.session.upsert({
        where: { phone },
        update: {
          state,
          draftJson
        },
        create: {
          phone,
          state,
          draftJson
        }
      });
      console.log(`[SessionService] Saved session for ${phone} (State: ${state})`);
    } catch (error) {
      console.error(`[SessionService] Error saving session for ${phone}:`, error);
    }
  }

  /**
   * Resets a session to IDLE.
   */
  static async clearSession(phone: string): Promise<void> {
    await this.saveSession(phone, 'IDLE', null);
  }
}
