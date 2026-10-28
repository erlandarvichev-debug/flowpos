import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DomainError, EsfStore, SyntheticGateway } from './core.ts';
import { authorize, EsfApplication, FixtureAuthProvider, type AuthProvider } from './access.ts';

export function createStandServer(store: EsfStore, gateway = new SyntheticGateway(),auth:AuthProvider=new FixtureAuthProvider()) {
  const token = randomBytes(32).toString('hex');
  const app=new EsfApplication(store,gateway);
  return createServer(async (req,res) => {
    const send = (status: number, data: unknown) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const address = req.socket.localAddress;
    if (address !== '127.0.0.1' && address !== '::ffff:127.0.0.1') { send(403,{code:'LOOPBACK_ONLY'}); return; }
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) { send(403,{code:'ORIGIN_DENIED'}); return; }
    try {
      if (req.method === 'GET' && ['/', '/ui.js', '/ui.css'].includes(req.url ?? '')) {
        const file = req.url === '/' ? 'index.html' : req.url!.slice(1);
        res.writeHead(200,{'Content-Type':file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'});
        res.end(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'ui',file))); return;
      }
      const principal=await auth.authenticate(req);
      if(!principal || !principal.enabled || principal.expiresAt<=Date.now())throw new DomainError('UNAUTHENTICATED');
      const org=req.headers['x-flowpos-organization'];
      if (req.method === 'GET' && req.url === '/api/session') { send(200,{token,mode:'SYNTHETIC',identitySource:'LOCAL_FIXTURE',gate:'CONTRACT_UNVERIFIED',subject:principal.subject,organizations:principal.grants.filter(g=>g.actions.includes('read')).map(g=>({id:g.orgId,actions:g.actions}))}); return; }
      if (req.method === 'GET' && req.url === '/api/documents') { send(200,app.list(principal,org)); return; }
      const detail=/^\/api\/documents\/([a-f0-9-]{36})$/.exec(req.url??'');
      if(req.method==='GET' && detail){send(200,app.get(principal,org,detail[1]));return;}
      if (req.method !== 'POST') { send(404,{code:'NOT_FOUND'}); return; }
      if (req.headers['x-flowpos-local'] !== token || !req.headers['content-type']?.startsWith('application/json')) { send(403,{code:'LOCAL_TOKEN_REQUIRED'}); return; }
      // Authorize organization before parsing body; identity is never read from the body.
      authorize(principal,org,'read');
      const chunks:Buffer[]=[];let size=0;
      for await (const chunk of req) { const bytes=Buffer.from(chunk);size+=bytes.length;if(size>65_536){send(413,{code:'BODY_TOO_LARGE'});return;}chunks.push(bytes); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const fields=(allowed:string[])=>{if(!input || typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw new DomainError('UNEXPECTED_FIELD');};
      if (req.url === '/api/fixtures/inbound') {
        fields(['fixture']);send(200,app.ingest(principal,org,input.fixture)); return;
      }
      if (req.url === '/api/outbound') { fields(['operationId','invoice']);send(201,app.create(principal,org,input.operationId,input.invoice)); return; }
      const match = /^\/api\/documents\/([a-f0-9-]{36})\/(approve|send|reconcile|reset-approval)$/.exec(req.url ?? '');
      if (!match) { send(404,{code:'NOT_FOUND'}); return; }
      const [,id,action] = match;
      fields(action==='approve'?['payloadHash','expiresAt','expectedVersion']:['expectedVersion']);
      const result = action === 'approve' ? app.approve(principal,org,id,input.payloadHash,input.expiresAt,input.expectedVersion) : action === 'reset-approval'?app.resetApproval(principal,org,id,input.expectedVersion): action === 'send' ? await app.send(principal,org,id,input.expectedVersion) : await app.reconcile(principal,org,id,input.expectedVersion);
      send(200,result);
    } catch (error) {
      if (error instanceof DomainError) send(error.code==='UNAUTHENTICATED'?401:error.code==='ACCESS_DENIED'?403:error.code === 'NOT_FOUND' ? 404 : 409,{code:error.code});
      else if (error instanceof SyntaxError) send(400,{code:'INVALID_JSON'});
      else if(error && typeof error==='object' && 'errcode' in error && error.errcode===5)send(503,{code:'STORAGE_BUSY',retryable:true});
      else send(500,{code:'INTERNAL_ERROR'});
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.FLOWPOS_ESF_MODE && process.env.FLOWPOS_ESF_MODE !== 'synthetic') throw new DomainError('CONTRACT_UNVERIFIED');
  const data = join(dirname(fileURLToPath(import.meta.url)),'.local-stand'); mkdirSync(data,{recursive:true});
  const store = new EsfStore(join(data,'stand.sqlite'));
  const server = createStandServer(store);
  server.listen(14840,'127.0.0.1',() => console.log('SYNTHETIC ONLY: http://127.0.0.1:14840 | CONTRACT_UNVERIFIED'));
  const stop = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
}
