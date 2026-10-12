// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

const fs=require('fs');const base=process.argv[2].replace(/\.json$/,'');const r=JSON.parse(fs.readFileSync(base+'.json'));const p=JSON.parse(fs.readFileSync(base+'.cpuprofile'));
const byId=new Map(p.nodes.map(n=>[n.id,n]));const parent=new Map();for(const n of p.nodes)for(const c of n.children||[])parent.set(c,n.id);
const agg={};let t=0,i=0;for(const id of p.samples){t+=p.timeDeltas[i++];const ms=t/1000;if(ms<r.modelLoadedAt||ms>r.overlayHiddenAt)continue;
 let c=id,chain=[];while(c){const f=byId.get(c).callFrame;chain.push(f.functionName||'(anon)');c=parent.get(c);}
 if(!chain.some(f=>/getUniforms/.test(f)))continue;
 // keep frames from index (app) + three render entry, outermost 12 app-level frames
 const k=chain.slice(0,40).filter((f,j)=>j>3).slice(0,18).join(' < ');agg[k]=(agg[k]||0)+p.timeDeltas[i-1]/1000;}
for(const [k,v] of Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,6))console.log(v.toFixed(0),'ms',k,'\n');
