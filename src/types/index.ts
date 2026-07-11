export interface DraftItem {
  name: string;             // Spoken or parsed product name
  quantity: number;
  rate?: number;            // Custom rate from user, if spoken (e.g. "at 500 rupees")
  reference?: string;       // Line item reference (Zoho custom field cf_reference, e.g. "1 Pallet")
  zohoLineItemId?: string;  // Existing line_item_id from Zoho — needed for updates to avoid duplicates

  // Price range support (e.g. "30€-40€ per bag")
  priceRangeMin?: number;   // Lower bound of price range
  priceRangeMax?: number;   // Upper bound of price range
  inferredQuantity?: boolean; // true if qty was auto-calculated from a target total
  targetTotal?: number;     // The stated total amount user wants to reach

  // Currency info (item-level, mirrors order-level)
  currency?: string;        // Symbol e.g. '€', '₹', '$'
  currencyCode?: string;    // ISO code e.g. 'EUR', 'INR', 'USD'

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

  // Currency info (order-level)
  currency?: string;        // Symbol e.g. '€', '₹', '$'
  currencyCode?: string;    // ISO code e.g. 'EUR', 'INR', 'USD'

  // Financial calculations
  totalAmount?: number;     // Excl. tax
  taxAmount?: number;
  grandTotal?: number;      // Incl. tax

  warnings?: string[];      // Alerts e.g. "Item Cement out of stock"
  editingSalesOrderId?: string;
  editingSalesOrderNumber?: string;
  editingInvoiceId?: string;
  editingInvoiceNumber?: string;
  editCorrection?: string;
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
