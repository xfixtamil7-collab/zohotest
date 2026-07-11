import axios from 'axios';

const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN!;
const CLIENT_ID = process.env.ZOHO_CLIENT_ID!;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET!;
const ORG_ID = process.env.ZOHO_ORG_ID!;

async function main() {
  // 1. Get access token
  const tokenResp = await axios.post(
    'https://accounts.zoho.com/oauth/v2/token',
    new URLSearchParams({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token'
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const token = tokenResp.data.access_token;
  console.log('Token obtained ✓');

  // 2. Fetch SO list for SO-00028
  const listResp = await axios.get('https://www.zohoapis.com/inventory/v1/salesorders', {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'X-com-zoho-inventory-organizationid': ORG_ID },
    params: { salesorder_number: 'SO-00028' }
  });
  const soList = listResp.data?.salesorders || [];
  const soEntry = soList[0];
  if (!soEntry) { console.error('SO-00028 not found'); return; }
  console.log('\n=== SO list entry salesorder_id ===', soEntry.salesorder_id);

  // 3. Fetch full SO detail
  const detailResp = await axios.get(`https://www.zohoapis.com/inventory/v1/salesorders/${soEntry.salesorder_id}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'X-com-zoho-inventory-organizationid': ORG_ID }
  });
  const detail = detailResp.data?.salesorder;
  console.log('\n=== Full SO line_items ===');
  console.log(JSON.stringify(detail?.line_items, null, 2));
  console.log('\n=== SO custom_fields ===');
  console.log(JSON.stringify(detail?.custom_fields, null, 2));
}

main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
