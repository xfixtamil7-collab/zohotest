export interface DraftItem {
  name: string;             // Spoken or parsed product name
  quantity: number;
  rate?: number;            // Custom rate from user, if spoken (e.g. "at 500 rupees")
  
  // Resolved info from Zoho Inventory lookup & fuzzy matching
  zohoItemId?: string;
  zohoItemName?: string;
  zohoRate?: number;        // Rate stored in Zoho Inventory
  sku?: string;
  stockAvailable?: number;
  taxPercentage?: number;
  unit?: string;
  matchedStatus?: 'MATCHED' | 'FUZZY_MATCHED' | 'NOT_FOUND';
  matchScore?: number;
}

export interface DraftOrder {
  spokenCustomerName: string;
  
  // Resolved info from Zoho Contact lookup
  zohoCustomerId?: string;
  zohoCustomerName?: string;
  customerMatchedStatus?: 'MATCHED' | 'FUZZY_MATCHED' | 'NOT_FOUND';
  customerMatchScore?: number;
  
  items: DraftItem[];
  deliveryDate?: string;
  notes?: string;
  paymentTerms?: string;
  
  // Financial calculations
  totalAmount?: number;     // Excl. tax
  taxAmount?: number;
  grandTotal?: number;      // Incl. tax
  
  warnings?: string[];       // Alerts e.g. "Item Cement out of stock"
}

export interface SessionData {
  phone: string;
  state: 'IDLE' | 'AWAITING_CONFIRMATION' | 'AWAITING_INVOICE_DECISION';
  draft: DraftOrder | null;
}

export interface MatchResult<T> {
  item: T;
  score: number;
  status: 'MATCHED' | 'FUZZY_MATCHED' | 'NOT_FOUND';
}

export interface ZohoContact {
  contact_id: string;
  contact_name: string;
  company_name?: string;
  email?: string;
}

export interface ZohoItem {
  item_id: string;
  name: string;
  sku?: string;
  rate: number;
  stock_on_hand: number;
  tax_percentage?: number;
  unit?: string;
}

export interface WebhookMessage {
  from: string;
  messageId: string;
  timestamp: number;
  type: 'text' | 'audio';
  text?: string;
  audioId?: string; // WhatsApp media ID for the audio file
}
