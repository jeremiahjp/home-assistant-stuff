const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');
let CPS_USER = '';
let CPS_PASS = '';

function loadCredentials() {
  if (process.env.CPS_USER) CPS_USER = process.env.CPS_USER;
  if (process.env.CPS_PASS) CPS_PASS = process.env.CPS_PASS;

  const OPTIONS_PATH = '/data/options.json';
  if (fs.existsSync(OPTIONS_PATH)) {
    try {
      const opts = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
      if (opts.cps_user) CPS_USER = opts.cps_user;
      if (opts.cps_pass) CPS_PASS = opts.cps_pass;
    } catch (e) {}
  }

  if ((!CPS_USER || !CPS_PASS) && fs.existsSync(ENV_PATH)) {
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('CPS_USER=')) CPS_USER = trimmed.substring('CPS_USER='.length);
      if (trimmed.startsWith('CPS_PASS=')) CPS_PASS = trimmed.substring('CPS_PASS='.length);
    }
  }
}

// In-memory token cache
let cachedToken = null;
let tokenExpiresAt = 0;

function req(urlStr, options = {}, cookieJar = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...options.headers
    };

    const cookieHeader = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    if (options.body) headers['Content-Length'] = Buffer.byteLength(options.body);

    const r = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers
    }, res => {
      // Update cookie jar
      const setCookies = res.headers['set-cookie'];
      if (setCookies) {
        (Array.isArray(setCookies) ? setCookies : [setCookies]).forEach(item => {
          const parts = item.split(';')[0].split('=');
          if (parts.length >= 2) cookieJar[parts[0].trim()] = parts.slice(1).join('=').trim();
        });
      }

      let body = '';
      res.on('data', ch => body += ch);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });

    r.on('error', reject);
    if (options.body) r.write(options.body);
    r.end();
  });
}

/**
 * Performs full 6-step handshake with CPS Energy and SilverBlaze portal
 * to obtain a fresh encrypted Base64 parameters token for ConsumptionV3 API.
 */
async function authenticateAndGetToken(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedToken && tokenExpiresAt > now + (5 * 60 * 1000)) {
    return cachedToken;
  }

  loadCredentials();
  if (!CPS_USER || !CPS_PASS) {
    throw new Error('CPS_USER and CPS_PASS must be configured in .env');
  }

  console.log('[CPS Auth] Performing fresh login and token acquisition...');
  const mmaCookies = {};

  // Step 1: Encrypt credentials
  const postData = querystring.stringify({ username: CPS_USER, password: CPS_PASS });
  const encRes = await req('https://www.cpsenergy.com/bin/cpsenergy/EncryptMmaCreds', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': 'https://www.cpsenergy.com',
      'Referer': 'https://www.cpsenergy.com/'
    },
    body: postData
  }, mmaCookies);

  let creds;
  try {
    creds = JSON.parse(encRes.body).creds;
  } catch (e) {
    throw new Error('Failed to parse credential encryption response: ' + encRes.body.slice(0, 200));
  }

  // Step 2: MMA Login flow
  await req('https://secure.cpsenergy.com/mma/doLogin?returnJSON=N&changePassword=no&u=&callFrwd=0&aemU=' + encodeURIComponent(creds), {}, mmaCookies);
  await req('https://secure.cpsenergy.com/mma/wssHome.jsp', {}, mmaCookies);
  await req('https://secure.cpsenergy.com/mma/silverBlaze.jsp', {}, mmaCookies);

  // Step 3: Request SilverBlaze SSO redirect URL
  const resRes = await req('https://secure.cpsenergy.com/mma/silverBlazeRes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: querystring.stringify({ isEnglish: 'true' })
  }, mmaCookies);

  let parsed;
  try {
    parsed = JSON.parse(resRes.body);
  } catch (e) {
    throw new Error('Failed to parse silverBlazeRes response: ' + resRes.body.slice(0, 200));
  }

  const returnUrl = parsed.returnString;
  if (!returnUrl) {
    throw new Error('No returnString in silverBlazeRes response: ' + resRes.body);
  }

  // Step 4: Follow Return URL redirect on SilverBlaze (use clean cookie jar for SilverBlaze)
  const silverCookies = {};
  const step1 = await req(returnUrl, {}, silverCookies);
  const loc = step1.headers['location'];
  if (!loc || !loc.includes('enc=')) {
    throw new Error('Expected 302 redirect with enc parameter, got: ' + step1.statusCode + ' ' + loc);
  }

  const enc = loc.split('enc=')[1];

  // Step 5: Get menu tabs to find Usage subtab URL
  const menuRes = await req(`https://acewebsite.silverblaze.com/Menu/GetMenuWithAllSubTabs?enc=${enc}`, {}, silverCookies);
  let menu;
  try {
    menu = JSON.parse(menuRes.body);
  } catch (e) {
    throw new Error('Failed to parse SilverBlaze menu: ' + menuRes.body.slice(0, 200));
  }

  let usageEnc = null;
  if (Array.isArray(menu.Tabs)) {
    menu.Tabs.forEach(tab => {
      if (tab.SubTabs) {
        tab.SubTabs.forEach(sub => {
          if (sub.Key === 'tab.usagesubnav' || sub.Key.includes('usage') || sub.Name?.toLowerCase().includes('usage')) {
            const m = sub.Url ? sub.Url.match(/enc=([^&]+)/) : null;
            if (m) usageEnc = m[1];
          }
        });
      }
      if (!usageEnc && (tab.Key.includes('usage') || tab.Name?.toLowerCase().includes('usage'))) {
        const m = tab.Url ? tab.Url.match(/enc=([^&]+)/) : null;
        if (m) usageEnc = m[1];
      }
    });
  }

  if (!usageEnc) {
    // Fallback: use the initial enc
    usageEnc = enc;
  }

  // Step 6: Get Page Parameters for Usage tab
  const usagePageRes = await req(`https://acewebsite.silverblaze.com/api/Page/GetPageParameters?enc=${usageEnc}`, {}, silverCookies);
  let usagePage;
  try {
    usagePage = JSON.parse(usagePageRes.body);
  } catch (e) {
    throw new Error('Failed to parse Usage PageParameters: ' + usagePageRes.body.slice(0, 200));
  }

  const rawParameters = usagePage.Layout?.Parameters;
  if (!rawParameters) {
    throw new Error('No Parameters found in Usage page response');
  }

  // Base64 encode for /api/ConsumptionV3/Data
  const base64Token = Buffer.from(rawParameters).toString('base64');
  cachedToken = base64Token;
  // SilverBlaze tokens are valid for ~1 hour; set cache expiry to 50 minutes
  tokenExpiresAt = Date.now() + (50 * 60 * 1000);

  console.log('[CPS Auth] Successfully acquired and cached new parameters token!');
  return cachedToken;
}

function getCachedToken() {
  return cachedToken;
}

function invalidateToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

module.exports = {
  authenticateAndGetToken,
  getCachedToken,
  invalidateToken
};
