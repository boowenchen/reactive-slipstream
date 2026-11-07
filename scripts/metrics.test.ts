import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quantile,stats,dislocationInput,type Row} from './metrics.js';
test('nearest rank percentiles and empty data',()=>{
  assert.equal(quantile([], .95),null);
  assert.equal(quantile(Array.from({length:200},(_,i)=>i+1),.95),190);
  assert.equal(quantile([10,1,3],.5),3);
});
test('alternating real swaps reach opposite price targets on successive trials',()=>{
  let a=1000000n*10n**18n,b=a;const other=a;
  for(let i=0;i<200;i++){
    const direction=i%2===0,input=dislocationInput(a,b,other,other,direction,500n);
    const rin=direction?a:b,rout=direction?b:a,out=input*997n*rout/(rin*1000n+input*997n);
    if(direction){a+=input;b-=out;assert.ok(b*10000n<=a*9500n);}
    else {b+=input;a-=out;assert.ok(b*10000n>=a*10500n);}
  }
});
test('failed and missing observations do not become zero latency',()=>{
  const rows:Row[]=[{mode:'reactive',index:0,stimulus:'unit-test-only',status:'timeout',submittedAtMs:0},
    {mode:'reactive',index:1,stimulus:'unit-test-only',status:'success',submittedAtMs:1,originObservedMs:2,reactiveObservedMs:4,callbackObservedMs:7}];
  const s=stats(rows).reactive;
  assert.equal(s.attempts,2);assert.equal(s.successes,1);assert.equal(s.originToCompletionObservedMs.p50,5);
  assert.equal(s.sameChainBlockDeltaSeconds.p50,null);
});
test('RPC observation inversion remains counted but negative segment is excluded',()=>{
  const row:Row={mode:'reactive',index:0,stimulus:'unit-test-only',status:'success',submittedAtMs:0,originObservedMs:1,reactiveObservedMs:5,callbackObservedMs:4,observerOrderInverted:true};
  const s=stats([row]).reactive;
  assert.equal(s.successes,1);assert.equal(s.observerOrderInversions,1);
  assert.equal(s.originToCompletionObservedMs.p50,3);assert.equal(s.reactiveToCallbackObservedMs.n,0);
});
