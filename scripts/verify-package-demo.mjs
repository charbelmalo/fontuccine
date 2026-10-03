#!/usr/bin/env node
/** Build an npm tarball, install it into an isolated consumer, render and exercise
 * the demo. No source aliasing. Uses existing dev tools; no browser install.
 * Usage: node scripts/verify-package-demo.mjs --output /absolute/new-directory
 */
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const at=process.argv.indexOf('--output');if(at<0||!process.argv[at+1])throw Error('--output is required');
const out=path.resolve(process.argv[at+1]);
if(existsSync(out)&&(await fs.readdir(out)).length)throw Error('Output directory must be new or empty');
await fs.mkdir(out,{recursive:true});
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'fontuccine-consumer-')));
let server,browser;
const run=(cmd,args,cwd=root)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:20*1024*1024,timeout:180000});
try{
 await fs.writeFile(path.join(out,'build.log'),run('npm',['run','build']));
 const packed=JSON.parse(run('npm',['pack','--json','--pack-destination',out]))[0];
 const tarball=path.join(out,packed.filename);
 await fs.writeFile(path.join(temp,'package.json'),JSON.stringify({name:'fontuccine-portfolio-consumer',private:true,type:'module',dependencies:{fontuccine:'file:'+tarball}}));
 await fs.writeFile(path.join(out,'install.log'),run('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund'],temp));
 await fs.copyFile(path.join(root,'examples/portfolio/index.html'),path.join(temp,'index.html'));
 await fs.mkdir(path.join(temp,'public/fonts'),{recursive:true});
 for(const f of ['RobotoFlex-VF.ttf','OFL.txt'])await fs.copyFile(path.join(root,'playground/public/fonts',f),path.join(temp,'public/fonts',f));
 const vite=path.join(root,'playground/node_modules/vite/bin/vite.js');
 const config=path.join(temp,'vite.config.mjs');
 await fs.writeFile(config,`export default ${JSON.stringify({root:temp,base:'./',publicDir:path.join(temp,'public'),build:{outDir:path.join(out,'site'),emptyOutDir:true}})};`);
 await fs.writeFile(path.join(out,'consumer-build.log'),run(process.execPath,[vite,'build','--config',config],temp));
 await fs.copyFile(path.join(temp,'package-lock.json'),path.join(out,'consumer-package-lock.json'));
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf','.txt':'text/plain'};
 server=http.createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(path.join(out,'site'),'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(path.join(out,'site')+path.sep))throw Error('outside root');res.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));}catch{res.writeHead(404);res.end('not found');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
 const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--use-angle=metal','--no-first-run']});
 const checks=[];
 for(const scenario of [{tier:'webgl',width:1280},{tier:'svg',width:1280},{tier:'vf',width:1280},{tier:'webgl',width:390},{tier:'webgl',width:1280,reduced:true}]){
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.setViewport({width:scenario.width,height:1000,deviceScaleFactor:1});
  if(scenario.reduced)await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(url+'/?tier='+scenario.tier,{waitUntil:'networkidle0'});await page.waitForFunction(()=>window.__study?.ready||window.__study?.errors?.length,{timeout:20000});
  let state=await page.evaluate(()=>window.__study);assert.equal(state.ready,true,JSON.stringify(state));
  assert.match(await page.title(),/Horizontal type study/);assert.equal(await page.$('vite-error-overlay'),null);
  await page.evaluate(()=>new Promise(r=>setTimeout(r,300)));
  const stage=await page.$('#sample');const sampleStage=await stage.evaluateHandle(el=>el.parentElement);
  const before=await sampleStage.asElement().screenshot();
  if(scenario.reduced){assert.equal(await page.$eval('#ratio',el=>el.disabled),true);assert.equal(state.ratio,1);}
  else{await page.focus('#ratio');await page.keyboard.press('End');await page.waitForFunction(()=>window.__study?.ratio===Number(document.querySelector('#ratio').max));}
  await page.evaluate(()=>new Promise(r=>setTimeout(r,1800)));
  const after=await sampleStage.asElement().screenshot();
  const specimenHash=b=>createHash('sha256').update(b).digest('hex');
  const visual={before:specimenHash(before),after:specimenHash(after),changed:specimenHash(before)!==specimenHash(after)};
  assert.equal(visual.changed,!scenario.reduced,'specimen-only pixels must respond to width, or stay static under reduced motion');
  state=await page.evaluate(()=>window.__study);
  assert.equal(state.rendered,scenario.reduced?'svg':scenario.tier,JSON.stringify(state));
  const dimensions=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth,sample:document.querySelector('#sample').textContent,slider:document.querySelector('#ratio-value').textContent,canvas:!!document.querySelector('canvas'),svg:!!document.querySelector('#sample svg')}));
  assert.equal(dimensions.sample,'Flow & form');assert.ok(dimensions.page<=dimensions.viewport+1,'page overflow');
  assert.equal(errors.length,0,errors.join('\n'));
  const name=`${scenario.tier}-${scenario.width}${scenario.reduced?'-reduced':''}`;
  await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
  if(!scenario.reduced){await page.click('#reset');await page.waitForFunction(()=>window.__study?.ratio===1);}
  checks.push({scenario,state,dimensions,errors,visual,reset:scenario.reduced?'disabled in reduced motion':true,screenshot:name+'.png'});await page.close();
 }
 const hash=f=>fs.readFile(f).then(b=>createHash('sha256').update(b).digest('hex'));
 const report={schema_version:1,browser:await browser.version(),node:process.version,os:os.platform()+' '+os.release()+' '+os.arch(),consumer:'npm tarball installed in a fresh directory; Vite consumer has no source aliases',package:{filename:packed.filename,sha256:await hash(tarball)},font:{name:'RobotoFlex-VF.ttf',sha256:await hash(path.join(out,'site/fonts/RobotoFlex-VF.ttf')),license:'OFL.txt'},checks,limits:['Horizontal only','One TrueType variable font fixture','WebGL2/SVG/VF coverage on recorded Chrome/macOS only','VF demo is explicitly limited to 1.0–1.5× within the designed width range; no equivalence claim','Reduced motion uses SVG']};
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true,force:true});}
