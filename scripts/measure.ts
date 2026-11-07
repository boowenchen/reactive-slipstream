import {createPublicClient,createWalletClient,serializeTransaction,defineChain,http,parseAbi,parseAbiItem,isAddress,keccak256,toHex,type Address,type Hash} from 'viem';
import {toAccount} from 'viem/accounts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {stats,dislocationInput,type Row} from './metrics.js';

// No network or key access without the explicit transaction flag.
if(!process.argv.includes('--execute-testnet')) {
  console.log('Testnet execution: npm run measure -- --execute-testnet [--resume FILE]. Requires config/deployed.json and the local offline forge signer helper. Sends the configured 1–200 dislocations per mode plus keeper trades. This help command does not transact.');
  process.exit(0);
}
const networks=JSON.parse(readFileSync('config/networks.json','utf8'));
process.on('uncaughtException',()=>{console.error('Measurement failed; inspect configuration and public receipts. Error details suppressed to protect credentials.');process.exit(1);});
process.on('unhandledRejection',()=>{console.error('RPC/transaction failure; reconcile public receipts before retrying. Error details suppressed.');process.exit(1);});
const cfg=JSON.parse(readFileSync('config/deployed.json','utf8'));
type Fixture={pool0:Address;pool1:Address;executor:Address;token0:Address;token1:Address};
for(const name of ['reactiveFixture','keeperFixture'])for(const key of ['pool0','pool1','executor','token0','token1']) {
  if(!isAddress(cfg[name]?.[key])||/^0x0{40}$/i.test(cfg[name][key]))throw Error(`Missing ${name}.${key}`);
}
if(!isAddress(cfg.reactive)||cfg.reactiveFixture.pool0===cfg.keeperFixture.pool0||cfg.reactiveFixture.executor===cfg.keeperFixture.executor)throw Error('Distinct fixtures and reactive address required');
for(const k of ['samplesPerMode','observerPollMs','keeperPollMs','timeoutMs','dislocationBps','ttlSeconds'])if(!Number.isSafeInteger(cfg[k])||cfg[k]<=0)throw Error(`Invalid ${k}`);
if((cfg.samplesPerMode<1||cfg.samplesPerMode>200)||cfg.observerPollMs<100||cfg.keeperPollMs<100||cfg.dislocationBps>1000||cfg.ttlSeconds>3600)throw Error('Invalid measurement bounds');
const account=toAccount({
  address:'0xa49e54E36f6B8130d0DF4105f3e594E2c80bBB86',
  signMessage:async()=>{throw Error('disabled');},signTypedData:async()=>{throw Error('disabled');},
  signTransaction:async (transaction)=>{
    if(transaction.chainId!==84532)throw Error('Base Sepolia only');
    const unsigned=serializeTransaction(transaction);
    const {stdout}=await execFileAsync('python',['-X','utf8','../tools/live.py','sign-base',unsigned]);
    const signature=JSON.parse(stdout);signature.v=BigInt(signature.v);
    return serializeTransaction(transaction,signature);
  }
});
const base=defineChain({id:networks.base.chainId,name:'Base Sepolia',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[networks.base.rpc]}}});
const lasna=defineChain({id:networks.lasna.chainId,name:'Reactive Lasna',nativeCurrency:{name:'lREACT',symbol:'lREACT',decimals:18},rpcUrls:{default:{http:[networks.lasna.rpc]}}});
const client=createPublicClient({chain:base,transport:http(process.env.BASE_RPC||networks.base.rpc)});
const reactive=createPublicClient({chain:lasna,transport:http(process.env.LASNA_RPC||networks.lasna.rpc)});
const wallet=createWalletClient({account,chain:base,transport:http(process.env.BASE_RPC||networks.base.rpc)});
const tokenAbi=parseAbi(['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)']);
const poolAbi=parseAbi(['function sequence() view returns(uint256)','function reserve0() view returns(uint112)','function reserve1() view returns(uint112)','function token0() view returns(address)','function token1() view returns(address)','function swap(bool,uint256,uint256,uint256,bytes32) returns(uint256)']);
const executorAbi=parseAbi(['function completed(bytes32) view returns(bool)','function quote(bool,uint256) view returns(uint256,uint256)','function owner() view returns(address)','function paused() view returns(bool)','function maxInput() view returns(uint256)','function minProfit() view returns(uint256)','function execute(bytes32,bool,uint256,uint256,uint256,uint256)']);
const rcAbi=parseAbi(['function enabled() view returns(bool)','function executor() view returns(address)','function amountIn() view returns(uint256)','function minProfit() view returns(uint256)','function reserves(uint256) view returns(uint256,uint112,uint112)']);
const decisionEvent=parseAbiItem('event Decision(bytes32 indexed id,bytes32 indexed originTx,uint256 logIndex,bytes32 stimulus,bool firstPool0,uint256 mid,uint256 out)');
const syncEvent=parseAbiItem('event Sync(bytes32 indexed stimulus,address indexed actor,uint256 sequence,uint112 reserve0,uint112 reserve1)');
const completeEvent=parseAbiItem('event Completed(bytes32 indexed id,uint256 amountIn,uint256 amountOut,uint256 profit)');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const epoch=Date.now(),start=performance.now();const now=()=>epoch+performance.now()-start;
const amount=BigInt(cfg.amountWei),profit=BigInt(cfg.minProfitWei);
if(amount<=0n||profit<=0n)throw Error('Positive amount and profit required');
if(await client.getChainId()!==base.id||await reactive.getChainId()!==lasna.id)throw Error('RPC chain mismatch');
for(const fixture of [cfg.reactiveFixture,cfg.keeperFixture] as Fixture[]) {
  for(const address of Object.values(fixture))if(!await client.getCode({address}))throw Error('Missing deployed code');
  if((await client.readContract({address:fixture.executor,abi:executorAbi,functionName:'owner'})).toLowerCase()!==account.address.toLowerCase())throw Error('Wrong benchmark owner');
  if(await client.readContract({address:fixture.executor,abi:executorAbi,functionName:'paused'}))throw Error('Executor paused');
  if(await client.readContract({address:fixture.executor,abi:executorAbi,functionName:'maxInput'})!==amount||await client.readContract({address:fixture.executor,abi:executorAbi,functionName:'minProfit'})!==profit)throw Error('Fixture parameter mismatch');
  for(const p of [fixture.pool0,fixture.pool1]) {
    for(const t of ['token0','token1'] as const)if((await client.readContract({address:p,abi:poolAbi,functionName:t})).toLowerCase()!==fixture[t].toLowerCase())throw Error('Fixture pair mismatch');
  }
}
if(!await reactive.readContract({address:cfg.reactive,abi:rcAbi,functionName:'enabled'})||(await reactive.readContract({address:cfg.reactive,abi:rcAbi,functionName:'executor'})).toLowerCase()!==cfg.reactiveFixture.executor.toLowerCase())throw Error('Reactive not linked/enabled');
for(const i of [0n,1n]){const r=await reactive.readContract({address:cfg.reactive,abi:rcAbi,functionName:'reserves',args:[i]});if(r[1]===0n||r[2]===0n)throw Error('Reactive has not observed both seed events');}
if(await reactive.readContract({address:cfg.reactive,abi:rcAbi,functionName:'amountIn'})!==amount||await reactive.readContract({address:cfg.reactive,abi:rcAbi,functionName:'minProfit'})!==profit)throw Error('Reactive parameter mismatch');
const resumeIndex=process.argv.indexOf('--resume');
const file=resumeIndex>=0?process.argv[resumeIndex+1]:`measurements/${randomUUID()}.json`;
if(!file||!/^measurements\/[a-zA-Z0-9-]+\.json$/.test(file))throw Error('Output must be measurements/<run-id>.json');
const run=resumeIndex>=0?JSON.parse(readFileSync(file,'utf8')):{runId:randomUUID(),kind:'live-testnet',observerVersion:'concurrent-offline-forge-v3',config:cfg,baseChainId:base.id,reactiveChainId:lasna.id,startedAt:new Date().toISOString(),rows:[] as Row[]};
if(run.kind!=='live-testnet'||JSON.stringify(run.config)!==JSON.stringify(cfg))throw Error('Resume configuration mismatch');
const rows:Row[]=run.rows;
if(resumeIndex<0&&existsSync(file))throw Error('Refusing overwrite');
mkdirSync('measurements',{recursive:true});
const persist=()=>{writeFileSync(file+'.tmp',JSON.stringify({...run,rows,summary:stats(rows)},null,2)+'\n');renameSync(file+'.tmp',file);};
// An interrupted submission is never silently resent: inspect any pending hash first.
if(rows.some(r=>r.status==='pending'))throw Error('Pending row: reconcile receipts manually before resuming; no automatic resend');
persist();
run.setupTransactions??=[];
for(const fixture of [cfg.reactiveFixture,cfg.keeperFixture] as Fixture[])for(const token of [fixture.token0,fixture.token1]) {
  const hash=await wallet.writeContract({address:token,abi:tokenAbi,functionName:'approve',args:[fixture.pool0,2n**256n-1n]});
  run.setupTransactions.push({kind:'approval',hash,token,spender:fixture.pool0});persist();
  if((await client.waitForTransactionReceipt({hash})).status!=='success')throw Error('Approval failed');
}
async function observe(row:Row,fixture:Fixture,baseStart:bigint,reactiveStart:bigint,hash:Hash) {
  const receipt=await client.waitForTransactionReceipt({hash,timeout:cfg.timeoutMs,pollingInterval:cfg.observerPollMs});
  row.originObservedMs=now();row.originBlockHash=receipt.blockHash;
  row.originBlockTimestamp=Number((await client.getBlock({blockNumber:receipt.blockNumber})).timestamp);
  if(receipt.status!=='success'){row.status='reverted';persist();return;}
  const phase=Math.random()*cfg.keeperPollMs;
  if(row.mode==='keeper')row.keeperInitialPhaseMs=phase;
  let bCursor=baseStart,rCursor=reactiveStart,nextKeeper=now()+phase;
  type Completion={hash:Hash;blockHash:Hash;blockNumber:bigint;observed:number;profit:bigint};
  const completions=new Map<string,Completion>();
  let keeperSent=false,keeperError=false;let keeperSubmission:Promise<void>|undefined;
  const deadline=now()+cfg.timeoutMs;
  while(now()<deadline){
    if(keeperError)throw Error('Keeper submission failed');
    await Promise.all([(async()=>{if(row.mode==='reactive'&&!row.decisionId){
      const latest=await reactive.getBlockNumber();
      if(latest>=rCursor){
        const logs=await reactive.getLogs({address:cfg.reactive,event:decisionEvent,args:{originTx:hash},fromBlock:rCursor,toBlock:latest});
        rCursor=latest+1n;
        if(logs.length){const log=logs[0];row.decisionId=log.args.id!;row.reactiveTx=log.transactionHash!;row.reactiveObservedMs=now();row.reactiveBlockTimestamp=Number((await reactive.getBlock({blockNumber:log.blockNumber!})).timestamp);persist();}
      }
    }})(),(async()=>{
      const latest=await client.getBlockNumber();
      if(latest>=bCursor){
        const logs=[];for(let from=bCursor;from<=latest;from+=200n)logs.push(...await client.getLogs({address:fixture.executor,event:completeEvent,fromBlock:from,toBlock:from+199n<latest?from+199n:latest}));
        const observed=now();bCursor=latest+1n;
        for(const log of logs)if(log.args.id&&!completions.has(log.args.id))completions.set(log.args.id,{hash:log.transactionHash!,blockHash:log.blockHash!,blockNumber:log.blockNumber!,observed,profit:log.args.profit!});
      }
    })()]);
    if(row.mode==='keeper'&&!keeperSent&&now()>=nextKeeper){
      nextKeeper+=cfg.keeperPollMs;
      const q0=await client.readContract({address:fixture.executor,abi:executorAbi,functionName:'quote',args:[true,amount]});
      const q1=await client.readContract({address:fixture.executor,abi:executorAbi,functionName:'quote',args:[false,amount]});
      const direction=q0[1]>q1[1],q=direction?q0:q1;
      if(q[1]>=amount+profit){
        const timestamp=(await client.getBlock()).timestamp;
        keeperSent=true;persist();
        keeperSubmission=wallet.writeContract({address:fixture.executor,abi:executorAbi,functionName:'execute',args:[row.decisionId as Hash,direction,amount,q[0],q[1],timestamp+BigInt(cfg.ttlSeconds)]}).then(h=>{row.callbackTx=h;persist();}).catch(()=>{keeperError=true;});
      }
    }
    if(row.decisionId){
        const log=completions.get(row.decisionId);
        if(log){row.callbackTx=log.hash;row.callbackObservedMs=log.observed;row.profitWei=log.profit.toString();
          row.observerOrderInverted=row.reactiveObservedMs!==undefined&&row.callbackObservedMs<row.reactiveObservedMs;
          const completion=await client.waitForTransactionReceipt({hash:log.hash,confirmations:2,timeout:cfg.timeoutMs});
          if(completion.status!=='success'||completion.blockHash!==log.blockHash)throw Error('Completion changed/reorg');
          const originAgain=await client.getTransactionReceipt({hash});if(originAgain.blockHash!==receipt.blockHash)throw Error('Origin changed/reorg');
          row.callbackBlockHash=completion.blockHash;row.callbackBlockTimestamp=Number((await client.getBlock({blockNumber:completion.blockNumber})).timestamp);
          await keeperSubmission;if(keeperError)throw Error('Keeper submission failed');row.status='success';persist();return;
        }
    }
    if(keeperSent&&row.callbackTx){const r=await client.getTransactionReceipt({hash:row.callbackTx as Hash}).catch(()=>null);if(r?.status==='reverted'){row.status='reverted';persist();return;}}
    await sleep(cfg.observerPollMs);
  }
  row.status='timeout';persist();
}
try {
  for(const mode of ['reactive','keeper'] as const)for(let i=0;i<cfg.samplesPerMode;i++){
    if(rows.some(r=>r.mode===mode&&r.index===i))continue;
    const fixture:Fixture=mode==='reactive'?cfg.reactiveFixture:cfg.keeperFixture;
    const stimulus=keccak256(toHex(`${run.runId}:${mode}:${i}`));
    const row:Row={mode,index:i,stimulus,status:'pending',submittedAtMs:now()};
    if(mode==='keeper')row.decisionId=stimulus;
    const [baseStart,reactiveStart]=await Promise.all([client.getBlockNumber(),reactive.getBlockNumber()]);
    // Alternate pressure; price impact is real and not counted as trading revenue.
    const direction=(i+(cfg.startIndex||0))%2===0;
    const reserves=await Promise.all([fixture.pool0,fixture.pool1].flatMap(address=>[
      client.readContract({address,abi:poolAbi,functionName:'reserve0'}),client.readContract({address,abi:poolAbi,functionName:'reserve1'})]));
    const input=dislocationInput(reserves[0],reserves[1],reserves[2],reserves[3],direction,BigInt(cfg.dislocationBps));
    const timestamp=(await client.getBlock()).timestamp;
    (row as any).payerBefore={reactiveWei:(await reactive.getBalance({address:cfg.reactive})).toString(),callbackWei:(await client.getBalance({address:fixture.executor})).toString()};
    if(mode==='reactive'&&cfg.maxRoundCostWei&&BigInt((row as any).payerBefore.reactiveWei)<BigInt(cfg.maxRoundCostWei))throw Error('Reactive budget exhausted before submission');
    rows.push(row);row.submittedAtMs=now();persist();
    let sendError:unknown;const submission=wallet.writeContract({address:fixture.pool0,abi:poolAbi,functionName:'swap',args:[direction,input,1n,timestamp+BigInt(cfg.ttlSeconds),stimulus]}).catch(e=>{sendError=e;return undefined;});
    let hash:Hash|undefined,cursor=baseStart;const sourceDeadline=Date.now()+cfg.timeoutMs;
    while(!hash&&Date.now()<sourceDeadline){
      if(sendError)throw Error('Origin submission failed');
      const latest=await client.getBlockNumber();
      for(let from=cursor;from<=latest;from+=200n){
        const logs=await client.getLogs({address:fixture.pool0,event:syncEvent,args:{stimulus},fromBlock:from,toBlock:from+199n<latest?from+199n:latest});
        if(logs.length)hash=logs[0].transactionHash!;
      }
      cursor=latest+1n;if(!hash)await sleep(cfg.observerPollMs);
    }
    if(!hash)throw Error('Source observation timeout; reconcile signer');
    row.originTx=hash;persist();
    await observe(row,fixture,baseStart,reactiveStart,hash);
    if(await submission!==hash)throw Error('Signer/source hash mismatch');
    if(row.status==='success'){
      (row as any).completedState=await client.readContract({address:fixture.executor,abi:executorAbi,functionName:'completed',args:[row.decisionId as Hash]});
      if(!(row as any).completedState)throw Error('Missing application state');
      if(mode==='reactive'){
        const deadline=Date.now()+cfg.timeoutMs;let settled=false;
        while(Date.now()<deadline){
          const seqs=await Promise.all([fixture.pool0,fixture.pool1].map(address=>client.readContract({address,abi:poolAbi,functionName:'sequence'})));
          const cache=await Promise.all([0n,1n].map(i=>reactive.readContract({address:cfg.reactive,abi:rcAbi,functionName:'reserves',args:[i]})));
          if(cache.every((r,i)=>r[0]===seqs[i])){settled=true;break;}
          await sleep(1000);
        }
        if(!settled)throw Error('Reactive cache not settled');
      }
    }
    (row as any).payerAfter={reactiveWei:(await reactive.getBalance({address:cfg.reactive})).toString(),callbackWei:(await client.getBalance({address:fixture.executor})).toString()};persist();
    console.log(`${mode} ${i+1}/${cfg.samplesPerMode} ${row.status}`);
    // Stop on missing completion so delayed callbacks cannot contaminate later samples.
    if(row.status!=='success')throw Error('Incomplete sample; reconcile before continuing');
  }
  run.finishedAt=new Date().toISOString();persist();console.log(`Saved ${file}`);
} catch {
  // RPC exceptions can contain URLs or signed requests; never dump them.
  persist();console.error('Measurement stopped. Inspect recorded public transaction hashes and RPC health. No automatic retry or fabricated sample.');process.exitCode=1;
}
