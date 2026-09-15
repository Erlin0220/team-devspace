import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopController} from '../client/desktop-controller.mjs';
const healthy={ready:true,devspace:true,bridge:true,tunnel:true,gateway:'active',remoteAccess:'active',desiredRemoteAccess:'active'};

test('a failed update check result cannot claim the installed version is latest',async t=>{
 const controller=createDesktopController('unused',{operations:{status:async()=>healthy,'update-check':async()=>({available:false,error:'Update policy unavailable'})}});
 t.after(()=>controller.dispose());
 await controller.dispatch('update-check').catch(()=>{});
 assert.doesNotMatch(controller.snapshot().notice??'',/最新/);
 assert.ok(controller.snapshot().updates?.error || controller.snapshot().alert);
});

test('a subsequently verified healthy connection resolves old connection-action failures',async t=>{
 const controller=createDesktopController('unused',{operations:{status:async()=>healthy,restart:async()=>{throw new Error('Connection restart was not confirmed')}}});
 t.after(()=>controller.dispose());
 await assert.rejects(controller.dispatch('restart'));
 await controller.dispatch('check');
 assert.equal(controller.snapshot().status,'ready');
 assert.equal(controller.snapshot().alert,undefined);
});

test('healthy connection polling does not conceal an unresolved access-key replacement error',async t=>{
 const controller=createDesktopController('unused',{operations:{status:async()=>healthy,'switch-key':async()=>{throw new Error('Replacement key is invalid')}}});
 t.after(()=>controller.dispose());
 await assert.rejects(controller.dispatch('switch-key'));
 await controller.dispatch('check');
 assert.match(controller.snapshot().alert,/Replacement key is invalid/);
});

test('a concurrent first update check without a verified policy cannot claim latest',async t=>{
 const controller=createDesktopController('unused',{operations:{status:async()=>healthy,'update-check':async()=>({available:false,required:false,automatic:true})}});
 t.after(()=>controller.dispose());
 await controller.dispatch('update-check').catch(()=>{});
 assert.doesNotMatch(controller.snapshot().notice??'',/最新/);
});
