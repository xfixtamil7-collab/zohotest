import axios from 'axios';
import { config } from '../config';
import { ZohoContact, ZohoItem } from '../types';
import { prisma } from '../prisma';

export interface ZohoCredentials {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId: string;
  region: string;
}

export class ZohoService {
  private static tokenCache = new Map<string, { accessToken: string; tokenExpiry: number }>();
  private static orgCurrencyCache = new Map<string, { symbol: string; code: string }>();

  // Predefined mock data for local testing
  private static mockCustomers: ZohoContact[] = [
    { contact_id: 'c_murugan_123', contact_name: 'Murugan Stores', company_name: 'Murugan Stores Ltd' },
    { contact_id: 'c_siva_456', contact_name: 'Siva Traders', company_name: 'Siva Traders' },
    { contact_id: 'c_balaji_789', contact_name: 'Balaji Agency', company_name: 'Balaji Agency Corp' },
    { contact_id: 'c_sriya_eu_001', contact_name: 'Sriya Exports EU', company_name: 'Sriya Global Foods GmbH' }
  ];

  private static mockItems: ZohoItem[] = [
    { item_id: 'i_cement_101', name: 'Cement (Standard Grade)', sku: 'CEM-STD', rate: 450, stock_on_hand: 120, tax_percentage: 18, unit: 'Bags' },
    { item_id: 'i_steel_102', name: 'Steel Rod 12mm', sku: 'STL-12MM', rate: 800, stock_on_hand: 4, tax_percentage: 18, unit: 'Rods' }, // Note: Stock is 4 (triggers out-of-stock warning for quantity 5)
    { item_id: 'i_brick_103', name: 'Clay Brick Red', sku: 'BRK-RED', rate: 9, stock_on_hand: 5000, tax_percentage: 5, unit: 'Pcs' },
    { item_id: 'i_paint_104', name: 'Asian Paints White 20L', sku: 'PNT-AP-20L', rate: 3200, stock_on_hand: 15, tax_percentage: 18, unit: 'Buckets' },
    { item_id: 'i_rice_105', name: 'Rice Bag 25Kg', sku: 'RICE-25KG', rate: 35, stock_on_hand: 2000, tax_percentage: 0, unit: '25Kg Bags' },
    { item_id: 'i_veeraponni_106', name: 'Veera Ponni Rice 20Kg', sku: 'RICE-VP-20KG', rate: 37.9, stock_on_hand: 3000, tax_percentage: 0, unit: '20Kg Bags' },
    { item_id: 'i_uraddal_107', name: 'Urad Dal 26Kg', sku: 'DAL-URAD-26KG', rate: 38, stock_on_hand: 1500, tax_percentage: 0, unit: '26Kg Bags' },
    { item_id: 'i_maaza_av_108', name: 'Maaza Aloe Vera', sku: 'MZA-AV', rate: 10, stock_on_hand: 5000, tax_percentage: 5, unit: 'packs' },
    { item_id: 'i_maaza_bn_109', name: 'Maaza Banana', sku: 'MZA-BANANA', rate: 12, stock_on_hand: 5000, tax_percentage: 5, unit: 'packs' }
  ];

  /**
   * Retrieves Zoho accounts API domain based on region
   */
  private static getAccountsDomain(region: string): string {
    const r = region.toLowerCase();
    switch (r) {
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
  private static getInventoryDomain(region: string): string {
    const r = region.toLowerCase();
    switch (r) {
      case 'com': return 'https://www.zohoapis.com/inventory/v1';
      case 'eu': return 'https://www.zohoapis.eu/inventory/v1';
      case 'com.au': return 'https://www.zohoapis.com.au/inventory/v1';
      case 'com.cn': return 'https://www.zohoapis.com.cn/inventory/v1';
      default: return 'https://www.zohoapis.in/inventory/v1';
    }
  }

  /**
   * Fetches the base currency symbol and code for the active Zoho organization.
   */
  static async getOrganizationCurrency(): Promise<{ symbol: string; code: string }> {
    if (config.MOCK_ALL) {
      const active = await this.getActiveAccount();
      if (active && active.region === 'com') {
        if (active.name.includes('Geo 360')) {
          return { symbol: '£', code: 'GBP' };
        }
        return { symbol: '$', code: 'USD' };
      }
      return { symbol: '₹', code: 'INR' };
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      return { symbol: '₹', code: 'INR' };
    }

    const cached = this.orgCurrencyCache.get(credentials.id);
    if (cached) {
      return cached;
    }

    try {
      const token = await this.getAccessToken(credentials);
      const domain = this.getInventoryDomain(credentials.region);
      const response = await axios.get(`${domain}/organizations`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`
        }
      });

      const orgs = response.data?.organizations || [];
      const activeOrg = orgs.find((o: any) => o.organization_id === credentials.orgId) || orgs[0];
      if (activeOrg) {
        const symbol = activeOrg.currency_symbol || '₹';
        const code = activeOrg.currency_code || 'INR';
        const res = { symbol, code };
        this.orgCurrencyCache.set(credentials.id, res);
        return res;
      }
    } catch (e: any) {
      console.error('[ZohoService] Failed to fetch organization currency:', e.response?.data || e.message);
    }

    // Fallback based on region if API call fails
    if (credentials.region === 'com') {
      if (credentials.name.includes('Geo 360')) {
        return { symbol: '£', code: 'GBP' };
      }
      return { symbol: '$', code: 'USD' };
    }
    if (credentials.region === 'eu') {
      return { symbol: '€', code: 'EUR' };
    }
    return { symbol: '₹', code: 'INR' };
  }

  /**
   * Resolves the active Zoho account configuration from the database.
   * If database is empty or none is active, falls back to the .env config.
   */
  static async getActiveAccount(): Promise<ZohoCredentials | null> {
    try {
      const active = await prisma.zohoAccount.findFirst({
        where: { isActive: true }
      });
      if (active) {
        return {
          id: active.id,
          name: active.name,
          clientId: active.clientId,
          clientSecret: active.clientSecret,
          refreshToken: active.refreshToken,
          orgId: active.orgId,
          region: active.region
        };
      }
    } catch (e) {
      console.warn('[ZohoService] Failed to query active Zoho account from database:', e);
    }

    return null;
  }

  /**
   * Fetches/refreshes the OAuth 2.0 Access Token for the specified credentials
   */
  private static async getAccessToken(credentials: ZohoCredentials): Promise<string> {
    if (config.MOCK_ALL) {
      return 'mock-access-token';
    }

    const now = Date.now();
    const cached = this.tokenCache.get(credentials.id);
    // If token exists and has at least 30s left, use it
    if (cached && cached.tokenExpiry > now + 30000) {
      return cached.accessToken;
    }

    try {
      console.log(`[ZohoService] Refreshing OAuth 2.0 Access Token for account "${credentials.name}"...`);
      const accountsUrl = `${this.getAccountsDomain(credentials.region)}/oauth/v2/token`;
      
      const response = await axios.post(
        accountsUrl,
        new URLSearchParams({
          refresh_token: credentials.refreshToken,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'refresh_token'
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      if (response.data && response.data.access_token) {
        const accessToken = response.data.access_token;
        // Zoho tokens typically last 1 hour (3600 seconds)
        const expiresIn = response.data.expires_in || 3600;
        const tokenExpiry = now + expiresIn * 1000;
        
        this.tokenCache.set(credentials.id, { accessToken, tokenExpiry });
        console.log(`[ZohoService] OAuth Token refreshed successfully for account "${credentials.name}".`);
        return accessToken;
      } else {
        throw new Error(`Failed to refresh token: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      console.error(`[ZohoService] OAuth token refresh failed for account "${credentials.name}":`, error.response?.data || error.message);
      throw new Error(`Zoho Authentication Failure for account "${credentials.name}"`);
    }
  }

  static async validateCredentials(params: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    region: string;
  }): Promise<{ isValid: boolean; refreshToken?: string; error?: string }> {
    try {
      const region = params.region.toLowerCase();
      let accountsDomain = 'https://accounts.zoho.in';
      switch (region) {
        case 'com': accountsDomain = 'https://accounts.zoho.com'; break;
        case 'eu': accountsDomain = 'https://accounts.zoho.eu'; break;
        case 'com.au': accountsDomain = 'https://accounts.zoho.com.au'; break;
        case 'com.cn': accountsDomain = 'https://accounts.zoho.com.cn'; break;
      }
      
      // Step 1: Try treating input as a refresh token
      try {
        const response = await axios.post(
          `${accountsDomain}/oauth/v2/token`,
          new URLSearchParams({
            refresh_token: params.refreshToken,
            client_id: params.clientId,
            client_secret: params.clientSecret,
            grant_type: 'refresh_token'
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );
        if (response.data && response.data.access_token) {
          return { isValid: true, refreshToken: params.refreshToken };
        }
      } catch (e) {
        // Fall through to try exchanging as an authorization code
      }

      // Step 2: Try treating input as a temporary authorization code
      try {
        const response = await axios.post(
          `${accountsDomain}/oauth/v2/token`,
          new URLSearchParams({
            code: params.refreshToken,
            client_id: params.clientId,
            client_secret: params.clientSecret,
            grant_type: 'authorization_code'
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        if (response.data && response.data.refresh_token) {
          return { isValid: true, refreshToken: response.data.refresh_token };
        } else if (response.data && response.data.error) {
          return { isValid: false, error: response.data.error };
        }
      } catch (e: any) {
        const zohoError = e.response?.data?.error || e.response?.data?.message || e.message;
        console.error('[ZohoService] Exchange validation failed:', e.response?.data || e.message);
        return { isValid: false, error: zohoError };
      }

      return { isValid: false, error: 'Could not authenticate or exchange token.' };
    } catch (e: any) {
      return { isValid: false, error: e.message };
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

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const response = await axios.get(`${this.getInventoryDomain(credentials.region)}/contacts`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId
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

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const response = await axios.get(`${this.getInventoryDomain(credentials.region)}/items`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId
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
    items: Array<{ itemId: string; quantity: number; rate: number; reference?: string; zohoLineItemId?: string }>;
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

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const CF_REFERENCE_ID = '38808000000093146';
      const formattedItems = params.items.map((it) => ({
        item_id: it.itemId,
        quantity: it.quantity,
        rate: it.rate,
        ...(it.zohoLineItemId ? { line_item_id: it.zohoLineItemId } : {}),
        ...(it.reference ? {
          item_custom_fields: [{ customfield_id: CF_REFERENCE_ID, value: it.reference }]
        } : {})
      }));

      const payload = {
        customer_id: params.customerId,
        line_items: formattedItems,
        notes: params.notes || 'Created automatically via WhatsApp Voice Automation',
        shipment_date: params.deliveryDate || new Date().toISOString().split('T')[0]
      };

      const response = await axios.post(`${this.getInventoryDomain(credentials.region)}/salesorders`, payload, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId,
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
        pdfLink: `${this.getInventoryDomain(credentials.region)}/salesorders/${so.salesorder_id}?print=true&accept=pdf`
      };
    } catch (error: any) {
      console.error('[ZohoService] Error creating Sales Order in Zoho:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Creates a new Customer (Contact) in Zoho Inventory
   */
  static async createCustomer(params: {
    contactName: string;
    companyName: string;
    email?: string;
    phone?: string;
    vatNumber?: string;
    billingAddress?: {
      address: string;
      city: string;
      state?: string;
      zip: string;
      country: string;
      countryCode: string;
    };
    siret?: string;
    siren?: string;
  }): Promise<{ contactId: string; contactName: string; companyName: string }> {
    if (config.MOCK_ALL) {
      const mockId = `c_mock_${Math.floor(100000 + Math.random() * 900000)}`;
      console.log(`[ZohoService] [MOCK] Creating customer: ${params.companyName} (${mockId})`);

      // Add to mock list so it shows up immediately in the UI
      this.mockCustomers.push({
        contact_id: mockId,
        contact_name: params.contactName,
        company_name: params.companyName,
        email: params.email
      });

      return {
        contactId: mockId,
        contactName: params.contactName,
        companyName: params.companyName
      };
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);

      // Build notes with French company registration details
      const noteLines: string[] = ['Created via Zoho Voice Automation Dashboard.'];
      if (params.siret) noteLines.push(`SIRET: ${params.siret}`);
      if (params.siren) noteLines.push(`SIREN: ${params.siren}`);
      if (params.vatNumber) noteLines.push(`TVA (VAT): ${params.vatNumber}`);

      const payload: any = {
        contact_name: params.companyName,
        company_name: params.companyName,
        contact_type: 'customer',
        notes: noteLines.join('\n')
      };

      if (params.phone) payload.phone = params.phone;
      if (params.email) payload.email = params.email;

      // Extract First Name and Last Name for Primary Contact Person
      let firstName = (params.contactName || '').trim();
      let lastName = '';
      const nameParts = firstName.split(/\s+/);
      if (nameParts.length > 1) {
        firstName = nameParts[0];
        lastName = nameParts.slice(1).join(' ');
      }

      payload.contact_persons = [
        {
          first_name: firstName,
          last_name: lastName || '.',
          email: params.email || '',
          phone: params.phone || '',
          is_primary_contact: true
        }
      ];

      if (params.billingAddress) {
        const ba = params.billingAddress;
        payload.billing_address = {
          address: ba.address || '',
          city: ba.city || '',
          state: ba.state || '',
          zip: ba.zip || '',
          country: ba.country || 'France',
          country_code: ba.countryCode || 'FR'
        };
        // Shipping address same as billing
        payload.shipping_address = payload.billing_address;
      }

      // Add Custom Fields (Siret and VAT Number)
      const customFields: any[] = [];
      if (params.siret) {
        customFields.push({
          customfield_id: '38808000000093582',
          api_name: 'cf_siret',
          value: params.siret
        });
      }
      if (params.vatNumber) {
        customFields.push({
          customfield_id: '38808000000093598',
          api_name: 'cf_vat_number',
          value: params.vatNumber
        });
      }
      if (customFields.length > 0) {
        payload.custom_fields = customFields;
      }

      console.log('[ZohoService] Creating customer payload:', JSON.stringify(payload, null, 2));

      const response = await axios.post(`${this.getInventoryDomain(credentials.region)}/contacts`, payload, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId,
          'Content-Type': 'application/json'
        }
      });

      const contact = response.data?.contact;
      if (!contact) {
        throw new Error(`Zoho API responded without contact details: ${JSON.stringify(response.data)}`);
      }

      return {
        contactId: contact.contact_id,
        contactName: contact.contact_name,
        companyName: contact.company_name
      };
    } catch (error: any) {
      // Log detailed Zoho error for debugging
      const zohoError = error.response?.data;
      console.error('[ZohoService] Error creating customer in Zoho:');
      console.error('  HTTP Status:', error.response?.status);
      console.error('  Zoho Response:', JSON.stringify(zohoError, null, 2));

      // Throw a friendlier message that includes the Zoho error code/message
      const zohoMsg = zohoError?.message || zohoError?.error || error.message;
      const zohoCode = zohoError?.code ? ` (Code: ${zohoError.code})` : '';
      throw new Error(`Zoho error: ${zohoMsg}${zohoCode}`);
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

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      // Zoho Inventory API allows creating invoice from Sales Order
      // Path: POST /invoices?salesorder_id={salesorder_id}
      const response = await axios.post(
        `${this.getInventoryDomain(credentials.region)}/invoices`,
        {},
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'X-com-zoho-inventory-organizationid': credentials.orgId,
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
        pdfLink: `${this.getInventoryDomain(credentials.region)}/invoices/${inv.invoice_id}?print=true&accept=pdf`
      };
    } catch (error: any) {
      console.error('[ZohoService] Error converting Sales Order to Invoice in Zoho:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Searches and retrieves a Sales Order from Zoho Inventory by its order number
   */
  static async getSalesOrderByNumber(salesOrderNumber: string): Promise<any> {
    if (config.MOCK_ALL) {
      const currencyDetails = await this.getOrganizationCurrency();
      console.log(`[ZohoService] [MOCK] Fetching Sales Order by number: ${salesOrderNumber}`);

      // SO-00028 mock: contains Maaza Aloe Vera and Maaza Banana
      if (salesOrderNumber.toUpperCase() === 'SO-00028') {
        return {
          salesorder_id: `so_mock_00028`,
          salesorder_number: 'SO-00028',
          customer_id: 'c_sriya_eu_001',
          customer_name: 'Sriya Exports EU',
          currency_symbol: currencyDetails.symbol,
          currency_code: currencyDetails.code,
          line_items: [
            { item_id: 'i_maaza_av_108', name: 'Maaza Aloe Vera', quantity: 10, rate: 10, unit: 'packs', line_item_id: 'li_maaza_av_001' },
            { item_id: 'i_maaza_bn_109', name: 'Maaza Banana', quantity: 10, rate: 12, unit: 'packs', line_item_id: 'li_maaza_bn_002' }
          ],
          notes: 'Created via WhatsApp Voice Automation',
          shipment_date: new Date().toISOString().split('T')[0]
        };
      }

      return {
        salesorder_id: `so_mock_${salesOrderNumber.replace(/\D/g, '') || '12345'}`,
        salesorder_number: salesOrderNumber,
        customer_id: 'c_murugan_123',
        customer_name: 'Murugan Stores',
        currency_symbol: currencyDetails.symbol,
        currency_code: currencyDetails.code,
        line_items: [
          { item_id: 'i_cement_101', name: 'Cement (Standard Grade)', quantity: 10, rate: 450, unit: 'Bags' },
          { item_id: 'i_steel_102', name: 'Steel Rod 12mm', quantity: 5, rate: 800, unit: 'Rods' }
        ],
        notes: 'Created via WhatsApp Voice Automation',
        shipment_date: new Date().toISOString().split('T')[0]
      };
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const domain = this.getInventoryDomain(credentials.region);
      
      const listResponse = await axios.get(`${domain}/salesorders`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId
        },
        params: {
          salesorder_number: salesOrderNumber
        }
      });

      const salesorders = listResponse.data?.salesorders || [];
      const exactMatch = salesorders.find((so: any) => so.salesorder_number.toLowerCase() === salesOrderNumber.toLowerCase()) || salesorders[0];
      
      if (!exactMatch) {
        throw new Error(`Sales Order ${salesOrderNumber} not found in Zoho.`);
      }

      const detailResponse = await axios.get(`${domain}/salesorders/${exactMatch.salesorder_id}`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId
        }
      });

      const so = detailResponse.data?.salesorder;
      if (!so) {
        throw new Error(`Failed to fetch details for Sales Order ${salesOrderNumber}`);
      }

      return so;
    } catch (error: any) {
      console.error(`[ZohoService] Error fetching Sales Order ${salesOrderNumber}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Searches and retrieves an Invoice from Zoho Inventory by its invoice number
   */
  static async getInvoiceByNumber(invoiceNumber: string): Promise<any> {
    if (config.MOCK_ALL) {
      const currencyDetails = await this.getOrganizationCurrency();
      console.log(`[ZohoService] [MOCK] Fetching Invoice by number: ${invoiceNumber}`);
      return {
        invoice_id: `inv_mock_${invoiceNumber.replace(/\D/g, '') || '12345'}`,
        invoice_number: invoiceNumber,
        customer_id: 'c_murugan_123',
        customer_name: 'Murugan Stores',
        currency_symbol: currencyDetails.symbol,
        currency_code: currencyDetails.code,
        line_items: [
          { item_id: 'i_cement_101', name: 'Cement (Standard Grade)', quantity: 10, rate: 450, unit: 'Bags' }
        ],
        notes: 'Created via WhatsApp Voice Automation',
        invoice_date: new Date().toISOString().split('T')[0]
      };
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const domain = this.getInventoryDomain(credentials.region);
      
      const listResponse = await axios.get(`${domain}/invoices`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId
        },
        params: {
          invoice_number: invoiceNumber
        }
      });

      const invoices = listResponse.data?.invoices || [];
      const exactMatch = invoices.find((inv: any) => inv.invoice_number.toLowerCase() === invoiceNumber.toLowerCase()) || invoices[0];
      
      if (!exactMatch) {
        throw new Error(`Invoice ${invoiceNumber} not found in Zoho.`);
      }

      const detailResponse = await axios.get(`${domain}/invoices/${exactMatch.invoice_id}`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId
        }
      });

      const inv = detailResponse.data?.invoice;
      if (!inv) {
        throw new Error(`Failed to fetch details for Invoice ${invoiceNumber}`);
      }

      return inv;
    } catch (error: any) {
      console.error(`[ZohoService] Error fetching Invoice ${invoiceNumber}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Updates an existing Sales Order in Zoho Inventory
   */
  static async updateSalesOrder(
    salesOrderId: string,
    params: {
      customerId: string;
      items: Array<{ itemId: string; quantity: number; rate: number; reference?: string; zohoLineItemId?: string }>;
      notes?: string;
      deliveryDate?: string;
    }
  ): Promise<{ salesOrderId: string; salesOrderNumber: string; pdfLink: string }> {
    if (config.MOCK_ALL) {
      console.log(`[ZohoService] [MOCK] Updating Sales Order ${salesOrderId}.`);
      return {
        salesOrderId: salesOrderId,
        salesOrderNumber: salesOrderId.includes('mock_') ? `SO-${salesOrderId.replace('so_mock_', '')}` : 'SO-12345',
        pdfLink: `https://inventory.zoho.in/mock-portal/salesorders/${salesOrderId}/pdf`
      };
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const CF_REFERENCE_ID = '38808000000093146';
      const formattedItems = params.items.map((it) => ({
        item_id: it.itemId,
        quantity: it.quantity,
        rate: it.rate,
        ...(it.zohoLineItemId ? { line_item_id: it.zohoLineItemId } : {}),
        ...(it.reference !== undefined ? {
          item_custom_fields: [{ customfield_id: CF_REFERENCE_ID, value: it.reference }]
        } : {})
      }));

      const payload = {
        customer_id: params.customerId,
        line_items: formattedItems,
        notes: params.notes || 'Updated automatically via WhatsApp Voice Automation',
        shipment_date: params.deliveryDate || new Date().toISOString().split('T')[0]
      };

      const response = await axios.put(`${this.getInventoryDomain(credentials.region)}/salesorders/${salesOrderId}`, payload, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId,
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
        pdfLink: `${this.getInventoryDomain(credentials.region)}/salesorders/${so.salesorder_id}?print=true&accept=pdf`
      };
    } catch (error: any) {
      console.error('[ZohoService] Error updating Sales Order in Zoho:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Updates an existing Invoice in Zoho Inventory
   */
  static async updateInvoice(
    invoiceId: string,
    params: {
      customerId: string;
      items: Array<{ itemId: string; quantity: number; rate: number; reference?: string; zohoLineItemId?: string }>;
      notes?: string;
    }
  ): Promise<{ invoiceId: string; invoiceNumber: string; pdfLink: string }> {
    if (config.MOCK_ALL) {
      console.log(`[ZohoService] [MOCK] Updating Invoice ${invoiceId}.`);
      return {
        invoiceId: invoiceId,
        invoiceNumber: invoiceId.includes('mock_') ? `INV-${invoiceId.replace('inv_mock_', '')}` : 'INV-12345',
        pdfLink: `https://inventory.zoho.in/mock-portal/invoices/${invoiceId}/pdf`
      };
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured. Please connect an account first.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const formattedItems = params.items.map((it) => ({
        item_id: it.itemId,
        quantity: it.quantity,
        rate: it.rate,
        ...(it.reference ? { description: it.reference } : {})
      }));

      const payload = {
        customer_id: params.customerId,
        line_items: formattedItems,
        notes: params.notes || 'Updated automatically via WhatsApp Voice Automation'
      };

      const response = await axios.put(`${this.getInventoryDomain(credentials.region)}/invoices/${invoiceId}`, payload, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId,
          'Content-Type': 'application/json'
        }
      });

      const inv = response.data?.invoice;
      if (!inv) {
        throw new Error(`Zoho API responded without invoice details: ${JSON.stringify(response.data)}`);
      }

      return {
        invoiceId: inv.invoice_id,
        invoiceNumber: inv.invoice_number,
        pdfLink: `${this.getInventoryDomain(credentials.region)}/invoices/${inv.invoice_id}?print=true&accept=pdf`
      };
    } catch (error: any) {
      console.error('[ZohoService] Error updating Invoice in Zoho:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Fetches the PDF file for a Sales Order from Zoho Inventory
   */
  static async getSalesOrderPdf(salesOrderId: string): Promise<Buffer> {
    if (config.MOCK_ALL || salesOrderId.startsWith('so_mock_') || salesOrderId.includes('12345') || salesOrderId === 'none') {
      return this.generateMockPDF(`Sales Order`, `Order ID: ${salesOrderId}\nStatus: Confirmed\nGenerated via Mock Mode.`);
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const domain = this.getInventoryDomain(credentials.region);
      const response = await axios.get(`${domain}/salesorders/${salesOrderId}`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId,
          'Accept': 'application/pdf'
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error: any) {
      console.error(`[ZohoService] Error fetching Sales Order PDF:`, error.response?.data || error.message);
      return this.generateMockPDF(`Sales Order`, `Order ID: ${salesOrderId}\nStatus: Error fetching from Zoho.\nError: ${error.message}`);
    }
  }

  /**
   * Fetches the PDF file for an Invoice from Zoho Inventory
   */
  static async getInvoicePdf(invoiceId: string): Promise<Buffer> {
    if (config.MOCK_ALL || invoiceId.startsWith('inv_mock_') || invoiceId.includes('12345') || invoiceId === 'none') {
      return this.generateMockPDF(`Invoice`, `Invoice ID: ${invoiceId}\nStatus: Paid/Sent\nGenerated via Mock Mode.`);
    }

    const credentials = await this.getActiveAccount();
    if (!credentials) {
      throw new Error('No active Zoho account configured.');
    }

    try {
      const token = await this.getAccessToken(credentials);
      const domain = this.getInventoryDomain(credentials.region);
      const response = await axios.get(`${domain}/invoices/${invoiceId}`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'X-com-zoho-inventory-organizationid': credentials.orgId,
          'Accept': 'application/pdf'
        },
        responseType: 'arraybuffer'
      });

      return Buffer.from(response.data);
    } catch (error: any) {
      console.error(`[ZohoService] Error fetching Invoice PDF:`, error.response?.data || error.message);
      return this.generateMockPDF(`Invoice`, `Invoice ID: ${invoiceId}\nStatus: Error fetching from Zoho.\nError: ${error.message}`);
    }
  }

  private static generateMockPDF(title: string, content: string): Buffer {
    const lines = content.split('\n');
    let contentStream = `BT\n/F1 24 Tf\n70 750 Td\n(${title.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) Tj\n/F1 12 Tf\n0 -30 Td\n`;
    for (const line of lines) {
      const escapedLine = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      contentStream += `(${escapedLine}) Tj\n0 -18 Td\n`;
    }
    contentStream += `ET`;

    const streamLength = contentStream.length;

    const pdfData = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 595.27 841.89] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${streamLength} >>
stream
${contentStream}
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000056 00000 n 
0000000111 00000 n 
0000000250 00000 n 
0000000318 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
${318 + streamLength + 20}
%%EOF`;
    return Buffer.from(pdfData, 'utf-8');
  }
}
