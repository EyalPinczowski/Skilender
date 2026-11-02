// TEST INFRASTRUCTURE. Loaded into the e2e API process only (NODE_OPTIONS=--import=...), never into
// a real deployment. Sends the two AI providers' HTTPS calls to the local scripted stub instead of
// the internet, so the real provider code (request body, error mapping, switching) runs unchanged.
// Every other URL (the local JWKS server, for one) goes to the real fetch.
/* global process, URL */
const stub = process.env.E2E_AI_STUB_URL;
if (stub) {
  const target = new URL(stub);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname)) {
    throw new Error('E2E_AI_STUB_URL must be a local http address.');
  }
  const routes = { 'api.groq.com': 'groq', 'api.cloudflare.com': 'cloudflare-ai' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let host = '';
    try {
      host = new URL(typeof input === 'string' ? input : (input.url ?? String(input))).hostname;
    } catch {
      // not a URL: leave it to the real fetch to complain
    }
    const provider = routes[host];
    return provider ? realFetch(`${stub}/${provider}`, init) : realFetch(input, init);
  };
}
