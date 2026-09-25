// Local workerd measurement for #578. Never deploys or contacts a provider.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = process.cwd();
const rows = [];
const versions = {};
for (const name of ['miniflare', 'workerd', '@modelcontextprotocol/client', '@modelcontextprotocol/server']) {
  versions[name] = JSON.parse(await readFile(resolve('node_modules', name, 'package.json'), 'utf8')).version;
}
for (let repeat = 0; repeat < 3; repeat++) {
  for (const preload of [true, false]) {
    let removed = 0;
    const result = await build({
      stdin: { contents: `import worker from './examples/worker/src/index.ts'; globalThis.probeWorker = worker; export default {fetch(){ return new Response('loaded'); }};`, resolveDir: root },
      bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
      conditions: ['workerd', 'worker', 'browser', 'import', 'default'], mainFields: ['browser', 'module', 'main'],
      external: ['node:*', 'cloudflare:*'],
      alias: {
        '@zackbart/connecta/ui': resolve('src/ui.ts'),
        '@zackbart/connecta/credentials': resolve('src/credentials.ts'),
        '@zackbart/connecta/auth/cloudflare-access': resolve('src/auth/cloudflare-access.ts'),
        '@zackbart/connecta': resolve('src/index.ts'),
      },
      plugins: [{name: 'remove-preload-for-measurement', setup(builder) {
        if (!preload) builder.onLoad({filter: /shimsWorkerd\.mjs$/}, async ({path}) => {
          let contents = await readFile(path, 'utf8');
          if (!contents.includes('preloadSchemas();')) throw new Error(`Missing preload in ${path}`);
          removed++;
          contents = contents.replace('preloadSchemas();', '');
          return {contents, loader: 'js'};
        });
      }}],
    });
    if (!preload && removed !== 2) throw new Error(`Expected two shims; saw ${removed}`);
    const mf = new Miniflare({modules:true, script:result.outputFiles[0].text, compatibilityDate:'2025-01-01', compatibilityFlags:['nodejs_compat'], inspectorPort:0});
    let ws;
    try {
      await mf.ready;
      await (await mf.dispatchFetch('http://probe/')).text();
      const inspector = await mf.getInspectorURL();
      inspector.protocol = 'http:';
      const targets = await fetch(new URL('/json/list', inspector)).then(r => r.json());
      const target = targets.find(t => t.id === 'core:user:');
      if (!target) throw new Error('Expected example Worker inspector target core:user:');
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
      let id=0;
      const rpc = (method) => new Promise((res,rej)=>{
        const requestId=++id;
        const timer=setTimeout(()=>{ws.removeEventListener('message',handler);rej(new Error(`Inspector timed out: ${method}`));},10000);
        const handler = e=>{const msg=JSON.parse(e.data);if(msg.id!==requestId)return;clearTimeout(timer);ws.removeEventListener('message',handler);if(msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);};
        ws.addEventListener('message',handler);ws.send(JSON.stringify({id:requestId,method}));
      });
      await rpc('Runtime.enable');
      const usage=await rpc('Runtime.getHeapUsage');
      rows.push({repeat,preload,removed,targetId:target.id,bundleBytes:result.outputFiles[0].contents.length,...usage});
      console.log(rows.at(-1));
    } finally { ws?.close(); await mf.dispose(); }
  }
}
const output = process.argv[2] ?? 'eval/results/schema-preload.json';
await mkdir(dirname(output), {recursive:true});
await writeFile(output,JSON.stringify({testedAt:new Date().toISOString(), node:process.version, versions, scope:'Worker example cold import after one synthetic request without forced GC; local workerd, not production isolate churn',rows},null,2)+'\n');
