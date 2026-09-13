import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../lib/storage';
import { createAccessStore, handleEarlyAccess, validateRegistration } from '../lib/earlyAccess/service';
import { isProductionPath } from '../src/middleware';

const valid = { name:'Launch QA',email:'launch-qa@example.com',device:'iphone',phone:'',source:'linkedin' };
const request = (body: unknown, headers = {}) => new Request('http://localhost/api/early-access', {method:'POST',headers:{origin:'http://localhost','content-type':'application/json',...headers},body:JSON.stringify(body)});
test('registration validates required fields and optional phone on server',()=>{
  assert.equal(Object.keys(validateRegistration(valid).errors).length,0);
  assert.deepEqual(Object.keys(validateRegistration({name:' ',email:'bad',device:'desktop',phone:'abc'}).errors),['name','email','device','phone']);
  assert.equal(validateRegistration({...valid,phone:'+972 599 123 456'}).value.phone,'+972 599 123 456');
});
test('concurrent duplicate submissions persist one record and preserve original attribution',async()=>{
  const db=createMemoryStorage();const store=createAccessStore(db);
  const results=await Promise.all(Array.from({length:12},()=>handleEarlyAccess(request(valid),()=>store)));
  assert.ok(results.every(r=>r.status===200));
  await handleEarlyAccess(request({...valid,email:'LAUNCH-QA@EXAMPLE.COM',name:'Overwrite',source:'changed'}),()=>store);
  const rows=await db.list<any>('earlyAccessRegistrations');assert.equal(rows.length,1);assert.equal(rows[0].data.source,'linkedin');assert.equal(rows[0].data.name,'Launch QA');assert.ok(Date.parse(rows[0].data.registeredAt));assert.equal(rows[0].data.phone,null);
  const metrics=await db.list<any>('earlyAccessMetrics');assert.equal(metrics[0].data.count,1);
});
test('no success on storage failure; metrics failure does not undo persisted signup',async()=>{
  const store=createAccessStore(createMemoryStorage());
  assert.equal((await handleEarlyAccess(request(valid),()=>{throw new Error('offline')})).status,503);
  store.event=async()=>{throw new Error('metrics unavailable')};
  assert.equal((await handleEarlyAccess(request(valid),()=>store)).status,200);
});
test('origin, malformed input, honeypot and body limits enforced',async()=>{
  const db=createMemoryStorage();const factory=()=>createAccessStore(db);
  assert.equal((await handleEarlyAccess(request(valid,{origin:'https://untrusted.example'}),factory)).status,403);
  assert.equal((await handleEarlyAccess(request(null),factory)).status,400);
  assert.equal((await handleEarlyAccess(request({...valid,name:'x'.repeat(5000)}),factory)).status,400);
  assert.equal((await handleEarlyAccess(request({...valid,email:'bad'}),factory)).status,422);
  assert.equal((await handleEarlyAccess(request({...valid,website:'spam'}),factory)).status,200);
  assert.equal((await db.list('earlyAccessRegistrations')).length,0);
});
test('atomic rate cap and production route boundary remain narrow',async()=>{
  const store=createAccessStore(createMemoryStorage());
  assert.equal(await store.allow('test',100,1),true);assert.equal(await store.allow('test',101,1),false);assert.equal(await store.allow('test',3600200,1),true);
  assert.equal(isProductionPath('/api/early-access'),true);assert.equal(isProductionPath('/api/early-access/events'),true);assert.equal(isProductionPath('/api/early-access/export'),false);assert.equal(isProductionPath('/api/state'),false);
});
