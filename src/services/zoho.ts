import axios from 'axios';
import { config } from '../config';
import { ZohoContact, ZohoItem } from '../types';

export class ZohoService {
  private static accessToken: string | null = null;
  private static tokenExpiry: number = 0; // Timestamp when token expires

  // Predefined mock data for local testing
  private static mockCustomers: ZohoContact[] = [
    { contact_id: 'c_murugan_123', contact_name: 'Murugan Stores', company_name: 'Murugan Stores Ltd' },
    { contact_id: 'c_siva_456', contact_name: 'Siva Traders', company_name: 'Siva Traders' },
    { contact_id: 'c_balaji_789', contact_name: 'Balaji Agency', company_name: 'Balaji Agency Corp' }
  ];

  private static mockItems: ZohoItem[] = [
    { item_id: 'i_cement_101', name: 'Cement (Standard Grade)', sku: 'CEM-STD', rate: 450, stock_on_hand: 120, tax_percentage: 18, unit: 'Bags' },
    { item_id: 'i_steel_102', name: 'Steel Rod 12mm', sku: 'STL-12MM', rate: 800, stock_on_hand: 4, tax_percentage: 18, unit: 'Rods' }, // Note: Stock is 4 (triggers out-of-stock warning for quantity 5)
    { item_id: 'i_brick_103', name: 'Clay Brick Red', sku: 'BRK-RED', rate: 9, stock_on_hand: 5000, tax_percentage: 5, unit: 'Pcs' },
    { item_id: 'i_paint_104', name: 'Asian Paints White 20L', sku: 'PNT-AP-20L', rate: 3200, stock_on_hand: 15, tax_percentage: 18, unit: 'Buckets' }
  ];

  /**
   * Retrieves Zoho accounts API domain based on region
   */
  private static getAccountsDomain(): string {
    const region = config.ZOHO_REGION.toLowerCase();
    switch (region) {
      case 'com': return 'https://accounts.zoho.com';
      case 'eu': return 'https://accounts.zoho.eu';
      case 'com.au': return 'https://accounts.zoho.com.au';
      case 'com.cn': return 'https://accounts.zoho.com.cn';
      default: return 'https://accounts.zoho.in';
    }
  }

  /**
   * Retrieves Zoho inventory API base URL based on region
   */
  private static getInventoryDomain(): string {
    const region = config.ZOHO_REGION.toLowerCase();
    switch (region) {
      case 'com': return 'https://www.zohoapis.com/inventory/v1';
      case 'eu': return 'https://www.zohoapis.eu/inventory/v1';
      case 'com.au': return 'https://www.zohoapis.com.au/inventory/v1';
      case 'com.cn': return 'https://www.zohoapis.com.cn/inventory/v1';
      default: return 'https://www.zohoapis.in/inventory/v1';
    }
  }

  /**
   * Fetches/refreshes the OAuth 2.0 Access Token
   */
  private static async getAccessToken(): Promise<string> {
    if (config.MOCK_ALL) {
      return 'mock-access-token';
    }

    const now = Date.now();
    // If token exists and has at least 30s left, use it
    if (this.accessToken && this.tokenExpiry > now + 30000) {
      return this.accessToken;
    }

    try {
      console.log('[ZohoService] Refreshing OAuth 2.0 Access Token...');
      const accountsUrl = `${this.getAccountsDomain()}/oauth/v2/token`;
      
      const response = await axios.post(accountsUrl, null, {
        params: {
          refresh_token: config.ZOHO_REFRESH_TOKEN,
          client_id: config.ZOHO_CLIENT_ID,
          client_secret: config.ZOHO_CLIENT_SECRET,
          grant_type: 'refresh_token'
        }
      });

      if (response.data && response.data.access_token) {
        this.accessToken = response.data.access_token;
        // Zoho tokens typically last 1 hour (3600 seconds)
        const expiresIn = response.data.expires_in || 3600;
        this.tokenExpiry = now + expiresIn * 1000;
        console.log('[ZohoService] OAuth Token refreshed successfully.');
        return this.accessToken!;
      } else {
        throw new Error(`Failed to refresh token: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      console.error('[ZohoService] OAuth token refresh failed:', error.response?.data || error.message);
      throw new Error('Zoho Authentication Failure');
    }
  }

  /**
   * Searches customers (contacts) in Zoho Inventory
   */
  static async searchCustomers(): Promise<ZohoContact[]> {
    if (config.MOCK_ALL) {
      console.log('[ZohoService] [MOCK] Searching customers');
      return this.mockCustomers;
    }

    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.getInventoryDomain()}/contacts`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': config.ZOHO_ORG_ID
        },
        params: {
          contact_type: 'customer',
          status: 'active'
        }
      });

      return (response.data?.contacts || []).map((c: any) => ({
        contact_id: c.contact_id,
        contact_name: c.contact_name,
        company_name: c.company_name,
        email: c.email
      }));
    } catch (error: any) {
      console.error('[ZohoService] Error fetching customers from Zoho:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Searches items (products) in Zoho Inventory
   */
  static async searchItems(): Promise<ZohoItem[]> {
    if (config.MOCK_ALL) {
      console.log('[ZohoService] [MOCK] Searching items');
      return this.mockItems;
    }

    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.getInventoryDomain()}/items`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': config.ZOHO_ORG_ID
        },
        params: {
          status: 'active'
        }
      });

      return (response.data?.items || []).map((i: any) => ({
        item_id: i.item_id,
        name: i.name,
        sku: i.sku,
        rate: i.rate,
        stock_on_hand: i.stock_on_hand || 0,
        tax_percentage: i.tax_percentage || 0,
        unit: i.unit
      }));
    } catch (error: any) {
      console.error('[ZohoService] Error fetching items from Zoho:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Creates a Sales Order in Zoho Inventory
   */
  static async createSalesOrder(params: {
    customerId: string;
    items: Array<{ itemId: string; quantity: number; rate: number }>;
    notes?: string;
    deliveryDate?: string;
  }): Promise<{ salesOrderId: string; salesOrderNumber: string; pdfLink: string }> {
    if (config.MOCK_ALL) {
      const orderNum = `SO-${Math.floor(10000 + Math.random() * 90000)}`;
      const orderId = `so_mock_${Math.floor(100000 + Math.random() * 900000)}`;
      console.log(`[ZohoService] [MOCK] Creating Sales Order for customer ${params.customerId}. Order Number: ${orderNum}`);
      return {
        salesOrderId: orderId,
        salesOrderNumber: orderNum,
        pdfLink: `https://inventory.zoho.in/mock-portal/salesorders/${orderId}/pdf`
      };
    }

    try {
      const token = await this.getAccessToken();
      const formattedItems = params.items.map((it) => ({
        item_id: it.itemId,
        quantity: it.quantity,
        rate: it.rate
      }));

      const payload = {
        customer_id: params.customerId,
        line_items: formattedItems,
        notes: params.notes || 'Created automatically via WhatsApp Voice Automation',
        shipment_date: params.deliveryDate || new Date().toISOString().split('T')[0]
      };

      const response = await axios.post(`${this.getInventoryDomain()}/salesorders`, payload, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': config.ZOHO_ORG_ID,
          'Content-Type': 'application/json'
        }
      });

      const so = response.data?.salesorder;
      if (!so) {
        throw new Error(`Zoho API responded without salesorder details: ${JSON.stringify(response.data)}`);
      }

      return {
        salesOrderId: so.salesorder_id,
        salesOrderNumber: so.salesorder_number,
        pdfLink: `${this.getInventoryDomain()}/salesorders/${so.salesorder_id}?print=true&accept=pdf`
      };
    } catch (error: any) {
      console.error('[ZohoService] Error creating Sales Order in Zoho:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Converts a Sales Order into an Invoice in Zoho Inventory
   */
  static async convertSalesOrderToInvoice(salesOrderId: string): Promise<{ invoiceId: string; invoiceNumber: string; pdfLink: string }> {
    if (config.MOCK_ALL) {
      const invNum = `INV-${Math.floor(10000 + Math.random() * 90000)}`;
      const invId = `inv_mock_${Math.floor(100000 + Math.random() * 900000)}`;
      console.log(`[ZohoService] [MOCK] Converting Sales Order ${salesOrderId} to Invoice. Invoice Number: ${invNum}`);
      return {
        invoiceId: invId,
        invoiceNumber: invNum,
        pdfLink: `https://inventory.zoho.in/mock-portal/invoices/${invId}/pdf`
      };
    }

    try {
      const token = await this.getAccessToken();
      // Zoho Inventory API allows creating invoice from Sales Order
      // Path: POST /invoices?salesorder_id={salesorder_id}
      const response = await axios.post(
        `${this.getInventoryDomain()}/invoices`,
        {},
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'X-com-zoho-inventory-organizationid': config.ZOHO_ORG_ID,
            'Content-Type': 'application/json'
          },
          params: {
            salesorder_id: salesOrderId
          }
        }
      );

      const inv = response.data?.invoice;
      if (!inv) {
        throw new Error(`Zoho API responded without invoice details: ${JSON.stringify(response.data)}`);
      }

      return {
        invoiceId: inv.invoice_id,
        invoiceNumber: inv.invoice_number,
        pdfLink: `${this.getInventoryDomain()}/invoices/${inv.invoice_id}?print=true&accept=pdf`
      };
    } catch (error: any) {
      console.error('[ZohoService] Error converting Sales Order to Invoice in Zoho:', error.response?.data || error.message);
      throw error;
    }
  }
}
