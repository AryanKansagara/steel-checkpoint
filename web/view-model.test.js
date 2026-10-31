import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRun,presentation,settingsLabel,exportName} from './view-model.js';
function fixture() {const policy={state:'verified',attempts:1,records:1,duplicates:0,events:[{state:'verified',reason:'Receipt matched'}],history:[],receipt:{id:1,reference:'synthetic',amount:1250}}; return {runId:'fixture-1',naive:structuredClone(policy),reconcile:structuredClone(policy),summary:{}};}
test('accepts declared actual evidence shape without altering it',()=>{const value=fixture();assert.equal(validateRun(value),value);});
test('rejects boolean and missing outcome counts',()=>{for(const bad of [true,undefined,-1,NaN]){const value=fixture();value.naive.attempts=bad;assert.throws(()=>validateRun(value));}});
test('rejects missing evidence instead of implying success',()=>{for(const field of ['runId','reconcile','summary']){const value=fixture();delete value[field];assert.throws(()=>validateRun(value));}});
test('rejects malformed receipt and journal fields',()=>{const value=fixture();value.reconcile.receipt=[];assert.throws(()=>validateRun(value));value.reconcile.receipt=null;value.reconcile.events=[{state:'verified',reason:42}];assert.throws(()=>validateRun(value));});
test('malformed history is rejected before rendering any partial outcome',()=>{for(const row of [null,{state:'pending',elapsedMs:Infinity},{state:'pending',elapsedMs:true}]){const value=fixture();value.naive.history=[row];assert.throws(()=>validateRun(value));}});
test('duplicate outcome remains visibly dangerous despite verified acknowledgement',()=>{const p=presentation({state:'verified',duplicates:1});assert.equal(p.label,'Verified');assert.equal(p.tone,'danger');assert.match(p.note,/duplicate/);});
test('review and pending do not masquerade as failed actions',()=>{assert.equal(presentation({state:'needs_review',duplicates:0}).label,'Needs review');assert.match(presentation({state:'pending',duplicates:0}).note,/does not prove failure/);});
test('scenario label preserves actual selected control values',()=>assert.equal(settingsLabel({mode:'opaque',fault:'after_commit',visibilityDelayMs:275}),'Opaque · After commit · 275 ms visibility delay'));
test('download filename cannot contain path components or injected extension',()=>assert.equal(exportName('../<script>.html'),'checkpoint-____script__html.json'));

import {themePreference,resolveTheme,createThemeController} from './view-model.js';
function themeFixture({saved=null,dark=false,blocked=false}={}) {
  const element=()=>({dataset:{},hidden:false,textContent:'',attributes:{},listeners:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){this.listeners[k]=v;}});
  const root=element(),button=element(),systemButton=element(),status=element(),meta=element(),media={matches:dark,addEventListener(name,fn){this.change=fn;}};
  const values=new Map(saved===null?[]:[['checkpoint-theme',saved]]);
  const storage={getItem(k){if(blocked)throw new Error('denied');return values.get(k)??null;},setItem(k,v){if(blocked)throw new Error('denied');values.set(k,v);},removeItem(k){values.delete(k);}};
  const controller=createThemeController({root,button,systemButton,status,meta,media,storage});
  return {root,button,systemButton,status,meta,media,values,controller};
}
test('theme defaults to system and ignores arbitrary saved strings',()=>{assert.equal(themePreference('system'),null);assert.equal(resolveTheme('<script>',true),'dark');assert.equal(themeFixture({dark:true}).root.dataset.theme,'dark');assert.equal(themeFixture().root.dataset.theme,'light');});
test('user toggle persists override and accessible pressed state',()=>{const f=themeFixture();f.button.listeners.click();assert.equal(f.root.dataset.theme,'dark');assert.equal(f.values.get('checkpoint-theme'),'dark');assert.equal(f.button.attributes['aria-pressed'],'true');assert.equal(f.systemButton.hidden,false);assert.match(f.status.textContent,/Dark theme/);});
test('saved preference wins over OS changes and restores on a fresh load',()=>{const f=themeFixture({saved:'light',dark:true});f.media.change();assert.equal(f.root.dataset.theme,'light');assert.equal(themeFixture({saved:'dark'}).root.dataset.theme,'dark');});
test('use system clears override and follows subsequent OS changes',()=>{const f=themeFixture({saved:'dark'});f.systemButton.listeners.click();assert.equal(f.values.has('checkpoint-theme'),false);assert.equal(f.root.dataset.theme,'light');assert.equal(f.systemButton.hidden,true);f.media.matches=true;f.media.change();assert.equal(f.root.dataset.theme,'dark');});
test('blocked localStorage never prevents theme switching or initialization',()=>{const f=themeFixture({blocked:true,dark:true});f.button.listeners.click();assert.equal(f.root.dataset.theme,'light');assert.equal(f.button.attributes['aria-pressed'],'false');});
test('storage sync applies another tab preference without changing run state',()=>{const f=themeFixture();f.values.set('checkpoint-theme','dark');f.controller.sync();assert.equal(f.root.dataset.theme,'dark');assert.equal(f.meta.attributes.content,'#181d18');});
