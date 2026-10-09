import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
// Compiles the new slice independently before the shell integration imports it.
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kairo-knowledge-build-'));
try {
 await build({configFile:false,logLevel:'warn',build:{outDir:directory,emptyOutDir:true,lib:{entry:path.resolve('src/CompanyKnowledge.jsx'),formats:['es'],fileName:'company-knowledge'},rollupOptions:{external:['react']}}});
 const files=await fs.readdir(directory);const bundle=await fs.readFile(path.join(directory,files.find(file=>file.endsWith('.js'))),'utf8');
 assert(bundle.includes('company-knowledge'));assert(bundle.includes('Company admins only'));assert(!bundle.includes('dangerouslySetInnerHTML'));
 const edge=await fs.readFile('backend/candidate/edge/company-knowledge/handler.mjs','utf8');assert(!edge.includes('service_role'));assert(!edge.includes('fetch('));
 const css=await fs.readFile(path.join(directory,files.find(file=>file.endsWith('.css'))),'utf8');assert(css.includes('680px'));assert(css.includes('focus-visible'));
 console.log('Company Knowledge component bundle, responsive CSS and plain-text/no-provider checks passed. Pixel/browser QA was not run.');
} finally {await fs.rm(directory,{recursive:true,force:true})}
