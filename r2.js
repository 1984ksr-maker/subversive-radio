// Minimal Cloudflare R2 (S3-compatible) client: PUT / GET / DELETE / HEAD object.
// Signs requests with AWS Signature V4, no SDK needed.
//
// Configure with env vars:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   R2_ENDPOINT (optional, overrides https://<account>.r2.cloudflarestorage.com)

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');

const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding, keeping "/" in object keys
function encodeKey(key) {
  return key.split('/').map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

// Returns the headers (incl. Authorization) for one request.
function sign({ method, host, path, headers, payloadHash, accessKeyId, secretAccessKey, region, service, date }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = Object.assign({}, headers, { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate });
  const names = Object.keys(all).map(h => h.toLowerCase()).sort();
  const lower = {};
  for (const k of Object.keys(all)) lower[k.toLowerCase()] = String(all[k]).trim().replace(/\s+/g, ' ');
  const canonicalHeaders = names.map(n => n + ':' + lower[n] + '\n').join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const out = {};
  for (const k of Object.keys(all)) if (k.toLowerCase() !== 'host') out[k] = all[k];
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

function createR2(env = process.env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !(R2_ACCOUNT_ID || env.R2_ENDPOINT)) return null;
  const endpoint = new URL(env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  const lib = endpoint.protocol === 'http:' ? http : https;
  const host = endpoint.host;

  function request(method, key, { body, bodyStream, contentLength, contentType } = {}) {
    return new Promise((resolve, reject) => {
      const path = '/' + encodeURIComponent(R2_BUCKET) + '/' + encodeKey(key);
      const headers = {};
      if (contentType) headers['content-type'] = contentType;
      // stream uploads are sent unsigned-payload (allowed by R2/S3 over HTTPS)
      const payloadHash = body ? sha256(body) : bodyStream ? 'UNSIGNED-PAYLOAD' : EMPTY_HASH;
      const signed = sign({ method, host, path, headers, payloadHash, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, region: 'auto', service: 's3', date: new Date() });
      if (body) signed['content-length'] = Buffer.byteLength(body);
      else if (bodyStream) signed['content-length'] = contentLength;
      const req = lib.request({ method, host: endpoint.hostname, port: endpoint.port || undefined, path, headers: signed, timeout: 120000 }, (res) => resolve(res));
      req.on('timeout', () => req.destroy(new Error('R2 request timed out')));
      // connection errors (e.g. ECONNREFUSED) can come with an empty message
      req.on('error', (e) => reject(new Error('cannot reach R2: ' + (e.message || e.code || (e.errors && e.errors[0] && e.errors[0].code) || 'network error'))));
      if (body) req.end(body);
      else if (bodyStream) bodyStream.pipe(req);
      else req.end();
    });
  }

  async function readAll(res) {
    const chunks = [];
    for await (const c of res) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async function check(res, what) {
    if (res.statusCode >= 200 && res.statusCode < 300) return res;
    const text = (await readAll(res)).toString().slice(0, 300);
    const err = new Error(`R2 ${what} failed: HTTP ${res.statusCode} ${text.replace(/\s+/g, ' ')}`);
    err.status = res.statusCode;
    throw err;
  }

  return {
    bucket: R2_BUCKET,
    async putBuffer(key, buf, contentType) {
      const res = await request('PUT', key, { body: buf, contentType });
      await check(res, 'upload ' + key); res.resume();
    },
    async putFile(key, file, contentType) {
      const size = fs.statSync(file).size;
      const res = await request('PUT', key, { bodyStream: fs.createReadStream(file), contentLength: size, contentType });
      await check(res, 'upload ' + key); res.resume();
    },
    // resolves to Buffer, or null if the object does not exist
    async getBuffer(key) {
      const res = await request('GET', key);
      if (res.statusCode === 404) { res.resume(); return null; }
      await check(res, 'download ' + key);
      return readAll(res);
    },
    // downloads to a file (via .part, so a half download never looks complete)
    async getFile(key, file) {
      const res = await request('GET', key);
      if (res.statusCode === 404) { res.resume(); return false; }
      await check(res, 'download ' + key);
      const part = file + '.part';
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(part);
        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        res.on('error', reject);
      });
      fs.renameSync(part, file);
      return true;
    },
    async del(key) {
      const res = await request('DELETE', key);
      if (res.statusCode === 404) { res.resume(); return; }
      await check(res, 'delete ' + key); res.resume();
    }
  };
}

module.exports = { createR2, sign, encodeKey };
