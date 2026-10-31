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
