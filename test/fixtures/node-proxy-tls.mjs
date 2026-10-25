// Ephemeral local TLS smoke; creates no external resources and removes its test key/cert.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const dir = await mkdtemp(`${tmpdir()}/connecta-tls-proxy-`);
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const sockets = new Set();
const track = (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
let origin, proxy;
try {
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const tls = { key: await readFile(`${dir}/key.pem`), cert: await readFile(`${dir}/cert.pem`) };
  let bodies = 0, reads = 0, tunnels = 0;
  origin = createServer(tls, async (req, res) => {
    assert.equal(req.headers['proxy-authorization'], undefined);
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST') { assert.equal(body, 'fixture-write'); bodies++; }
    else reads++;
    if (req.url === '/reset') { req.socket.destroy(); return; }
    res.writeHead(req.url === '/421' ? 421 : req.url === '/503' ? 503 : 200).end('reply');
  });
  origin.on('connection', track);
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  proxy = createServer(tls, (_req, res) => res.writeHead(405).end());
  proxy.on('connection', track);
  proxy.on('connect', (req, incoming, head) => {
    tunnels++;
    assert.equal(req.headers['proxy-authorization'], `Basic ${Buffer.from('alice:fixture-secret').toString('base64')}`);
    const target = new URL(`http://${req.url}`);
    const upstream = track(connect({ host: target.hostname, port: Number(target.port) }));
    incoming.on('error', () => upstream.destroy());
    upstream.on('error', () => incoming.destroy());
    incoming.on('close', () => upstream.destroy());
    upstream.on('close', () => incoming.destroy());
    upstream.on('connect', () => {
      incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      incoming.pipe(upstream).pipe(incoming);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const target = `https://127.0.0.1:${origin.address().port}`;
  const proxyUrl = `https://alice:fixture-secret@127.0.0.1:${proxy.address().port}`;
  const source = `const {createNodeGuardedTransport}=await import(${JSON.stringify(`${cwd}/src/http/node-transport.ts`)}); const sender=createNodeGuardedTransport(${JSON.stringify(proxyUrl)}); let dispatched=0; const statuses=[]; for(const mode of ['421','reset','503','read']) { try { const r=await sender.send(new URL(${JSON.stringify(target)}+'/'+mode), mode==='read'?{}:{method:'POST',body:'fixture-write'},()=>{dispatched++}); statuses.push(r.status); await r.text(); } catch(e) { if(mode!=='reset') throw e; statuses.push('reset'); } } if(dispatched!==4) throw new Error('dispatch count'); console.log(JSON.stringify({statuses,dispatched}));`;
  for (const runtime of [process.version]) {
    const before = { bodies, reads, tunnels };
    let result;
    try { result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd, env: { ...process.env, NODE_EXTRA_CA_CERTS: `${dir}/cert.pem` }, timeout: 20_000 }); } catch (error) { console.error(JSON.stringify({runtime,phase:'child failed',stderr:error.stderr,code:error.code})); throw new Error('TLS smoke child failed'); }
    assert.deepEqual(JSON.parse(result.stdout), { statuses: [421, 'reset', 503, 200], dispatched: 4 });
    assert.equal(bodies-before.bodies, 3);
    assert.equal(reads-before.reads, 1);
    assert.equal(tunnels-before.tunnels, 4);
    console.log(JSON.stringify({runtime, bodyCount:3, readCount:1, tunnelCount:4, credentialsConfined:true, statuses:[421,'reset',503,200]}));
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/wrong-key.pem`, '-out', `${dir}/wrong-cert.pem`, '-days', '1', '-subj', '/CN=wrong.invalid', '-addext', 'subjectAltName=DNS:wrong.invalid']);
    proxy.setSecureContext({ key: await readFile(`${dir}/wrong-key.pem`), cert: await readFile(`${dir}/wrong-cert.pem`) });
    const refused = `const {createNodeGuardedTransport}=await import(${JSON.stringify(`${cwd}/src/http/node-transport.ts`)}); let dispatched=0; try { await createNodeGuardedTransport(${JSON.stringify(proxyUrl)}).send(new URL(${JSON.stringify(target)}), {method:'POST',body:'fixture-write'},()=>{dispatched++}); throw new Error('unexpected trusted mismatch'); } catch(error) { if(dispatched || !error.message.includes('was not sent')) throw error; console.log('certificate mismatch refused before dispatch'); }`;
    // The mismatched self-signed certificate IS trusted here: rejection must
    // be hostname verification, not an unknown issuer, with IP SNI omitted.
    const mismatch = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', refused], { cwd, env: { ...process.env, NODE_EXTRA_CA_CERTS: `${dir}/wrong-cert.pem` }, timeout: 20_000 });
    assert.match(mismatch.stdout, /certificate mismatch refused before dispatch/);
    assert.equal(bodies-before.bodies, 3);
    assert.equal(tunnels-before.tunnels, 4);
    console.log('certificate hostname verification preserved');
  }
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([origin,proxy].filter(Boolean).map(server=>new Promise(resolve=>server.close(resolve))));
  await rm(dir, {recursive:true,force:true});
}
