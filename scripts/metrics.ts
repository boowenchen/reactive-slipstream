export type Row = {
  mode: 'reactive' | 'keeper'; index: number; stimulus: string;
  status: 'pending' | 'success' | 'timeout' | 'reverted' | 'observer-order';
  originTx?: string; reactiveTx?: string; callbackTx?: string; decisionId?: string;
  submittedAtMs: number; originObservedMs?: number; reactiveObservedMs?: number;
  callbackObservedMs?: number; originBlockTimestamp?: number; reactiveBlockTimestamp?: number;
  callbackBlockTimestamp?: number; originBlockHash?: string; callbackBlockHash?: string;
  observerOrderInverted?: boolean;
  keeperInitialPhaseMs?: number;
  profitWei?: string; error?: string;
};
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(q*sorted.length)-1)];
}
// Find the actual input needed to cross a price target relative to the other pool.
// Alternating fixed-size swaps can cancel the previous dislocation and yield no signal.
export function dislocationInput(r0:bigint,r1:bigint,other0:bigint,other1:bigint,direction:boolean,bps:bigint):bigint {
  if([r0,r1,other0,other1].some(x=>x<=0n)||bps<=0n||bps>1000n)throw Error('Invalid reserves/target');
  const rin=direction?r0:r1,rout=direction?r1:r0;
  const reaches=(input:bigint)=>{
    const out=input*997n*rout/(rin*1000n+input*997n);
    const a=direction?r0+input:r0-out,b=direction?r1-out:r1+input;
    const left=b*other0*10000n,right=other1*a*(direction?10000n-bps:10000n+bps);
    return direction?left<=right:left>=right;
  };
  if(reaches(0n))throw Error('Pool already beyond target: reconcile fixture before next sample');
  let lo=1n,hi=rin/2n;
  if(!reaches(hi))throw Error('Dislocation exceeds bounded input');
  while(lo<hi){const mid=(lo+hi)/2n;if(reaches(mid))hi=mid;else lo=mid+1n;}
  return lo;
}
export function stats(rows: Row[]) {
  return Object.fromEntries((['reactive','keeper'] as const).map(mode=>{
    const all=rows.filter(r=>r.mode===mode), good=all.filter(r=>r.status==='success');
    const metric=(f:(r:Row)=>number)=>{
      const values=good.map(f).filter(x=>Number.isFinite(x)&&x>=0);
      return {n:values.length,p50:quantile(values,.5),p95:quantile(values,.95)};
    };
    return [mode,{attempts:all.length,successes:good.length,failures:all.filter(r=>r.status!=='success').length,observerOrderInversions:good.filter(r=>r.observerOrderInverted).length,
      submissionToCompletionMs:metric(r=>r.callbackObservedMs!-r.submittedAtMs),
      originToCompletionObservedMs:metric(r=>r.callbackObservedMs!-r.originObservedMs!),
      originToReactiveObservedMs:metric(r=>r.reactiveObservedMs!-r.originObservedMs!),
      reactiveToCallbackObservedMs:metric(r=>r.callbackObservedMs!-r.reactiveObservedMs!),
      sameChainBlockDeltaSeconds:metric(r=>r.callbackBlockTimestamp!-r.originBlockTimestamp!)}];
  }));
}
