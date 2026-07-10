import axios from 'axios';
import { config } from '../config';

async function getRefreshToken() {
  const grantToken = process.argv[2];

  if (!grantToken) {
    console.error('❌ Error: Please provide the Grant Token (Authorization Code) as an argument.');
    console.log('Usage: npx tsx src/scripts/get-refresh-token.ts <YOUR_GRANT_TOKEN>');
    process.exit(1);
  }

  // Determine domain based on region
  const region = config.ZOHO_REGION.toLowerCase();
  const accountsDomain = region === 'in' ? 'https://accounts.zoho.in' : 'https://accounts.zoho.com';
  
  console.log(`📡 Connecting to Zoho OAuth Server (${accountsDomain})...`);

  try {
    const body = new URLSearchParams();
    body.append('code', grantToken);
    body.append('client_id', config.ZOHO_CLIENT_ID);
    body.append('client_secret', config.ZOHO_CLIENT_SECRET);
    body.append('grant_type', 'authorization_code');
    body.append('redirect_uri', 'http://localhost:3000');

    const response = await axios.post(`${accountsDomain}/oauth/v2/token`, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (response.data && response.data.refresh_token) {
      console.log('\n======================================================');
      console.log('✅ SUCCESS! Refresh Token Generated:');
      console.log('======================================================');
      console.log(`ZOHO_REFRESH_TOKEN="${response.data.refresh_token}"`);
      console.log('======================================================\n');
      console.log('Copy the ZOHO_REFRESH_TOKEN value above and paste it into your .env file.');
    } else {
      console.error('\n❌ Zoho OAuth Error response:', response.data);
    }
  } catch (error: any) {
    console.error('\n❌ Request failed:', error.response?.data || error.message);
  }
}

getRefreshToken();
