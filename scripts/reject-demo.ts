// Live demonstration that a callback whose quote went stale is rejected on-chain.
// One dislocation swap creates an opportunity; a second swap in the opposite direction, sent right
// behind it, closes the gap before the Reactive callback lands. The callback must then fail the
// executor's slippage/profit guards, leave completed(id) false and move no funds.
import {createPublicClient,createWalletClient,defineChain,http,parseAbi,parseAbiItem,keccak256,toHex,type Address,type Hash} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {readFileSync,writeFileSync} from 'node:fs';
import {dislocationInput} from './metrics.js';

if(!process.argv.includes('--execute-testnet')) {
  console.log('Usage: PRIVATE_KEY=0x… npm run reject-demo -- --execute-testnet. Sends two swaps on the Reactive fixture (Base Sepolia). Executor must be unpaused and the Reactive contract enabled.');
  process.exit(0);
}
const key=process.env.PRIVATE_KEY;
if(!key||!/^0x[0-9a-fA-F]{64}$/.test(key))throw Error('Set PRIVATE_KEY to the 0x-prefixed testnet key that owns the fixture');
const account=privateKeyToAccount(key as Hash);
const networks=JSON.parse(readFileSync('config/networks.json','utf8'));
const cfg=JSON.parse(readFileSync('config/deployed.json','utf8'));
const fx=cfg.reactiveFixture as {pool0:Address;pool1:Address;executor:Address};
const base=defineChain({id:networks.base.chainId,name:'Base Sepolia',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[networks.base.rpc]}}});
const lasna=defineChain({id:networks.lasna.chainId,name:'Reactive Lasna',nativeCurrency:{name:'lREACT',symbol:'lREACT',decimals:18},rpcUrls:{default:{http:[networks.lasna.rpc]}}});
const client=createPublicClient({chain:base,transport:http(process.env.BASE_RPC||networks.base.rpc)});
const reactive=createPublicClient({chain:lasna,transport:http(process.env.LASNA_RPC||networks.lasna.rpc)});
const wallet=createWalletClient({account,chain:base,transport:http(process.env.BASE_RPC||networks.base.rpc)});
const poolAbi=parseAbi(['function reserve0() view returns(uint112)','function reserve1() view returns(uint112)','function quote(bool,uint256) view returns(uint256)','function swap(bool,uint256,uint256,uint256,bytes32) returns(uint256)']);
const executorAbi=parseAbi(['function completed(bytes32) view returns(bool)','function paused() view returns(bool)']);
const rcAbi=parseAbi(['function enabled() view returns(bool)']);
const decisionEvent=parseAbiItem('event Decision(bytes32 indexed id,bytes32 indexed originTx,uint256 logIndex,bytes32 stimulus,bool firstPool0,uint256 mid,uint256 out)');
const completeEvent=parseAbiItem('event Completed(bytes32 indexed id,uint256 amountIn,uint256 amountOut,uint256 profit)');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

if(await client.getChainId()!==84532||await reactive.getChainId()!==5318007)throw Error('RPC chain mismatch');
if(await client.readContract({address:fx.executor,abi:executorAbi,functionName:'paused'}))throw Error('Executor paused');
if(!await reactive.readContract({address:cfg.reactive,abi:rcAbi,functionName:'enabled'}))throw Error('Reactive contract disabled');

const r=await Promise.all([fx.pool0,fx.pool1].flatMap(p=>(['reserve0','reserve1'] as const).map(f=>client.readContract({address:p,abi:poolAbi,functionName:f}))));
let direction=true,input:bigint;
try{input=dislocationInput(r[0],r[1],r[2],r[3],true,BigInt(cfg.dislocationBps));}
catch{direction=false;input=dislocationInput(r[0],r[1],r[2],r[3],false,BigInt(cfg.dislocationBps));}
const outA=await client.readContract({address:fx.pool0,abi:poolAbi,functionName:'quote',args:[direction,input]});
// The closing swap pushes pool0 slightly past pool1 in the opposite direction (CLOSE_BPS, default 30),
// so the quoted trade loses money, while the new gap stays below fees and opens no fresh trade.
const closeBps=BigInt(process.env.CLOSE_BPS||'30');
const a0=direction?r[0]+input:r[0]-outA,a1=direction?r[1]-outA:r[1]+input;
const closeInput=dislocationInput(a0,a1,r[2],r[3],!direction,closeBps);
const latest=await client.getBlock();
const deadline=latest.timestamp+120n;
const tag=Date.now();
const stimulusA=keccak256(toHex(`reject-demo-dislocate-${tag}`)),stimulusB=keccak256(toHex(`reject-demo-close-${tag}`));
const lasnaStart=await reactive.getBlockNumber();
const nonce=await client.getTransactionCount({address:account.address,blockTag:'pending'});
// Explicit nonces: the closing swap is sent without waiting for the first receipt.
const hashA=await wallet.writeContract({address:fx.pool0,abi:poolAbi,functionName:'swap',args:[direction,input,1n,deadline,stimulusA],nonce});
const hashB=await wallet.writeContract({address:fx.pool0,abi:poolAbi,functionName:'swap',args:[!direction,closeInput,1n,deadline,stimulusB],nonce:nonce+1});
const [ra,rb]=await Promise.all([hashA,hashB].map(hash=>client.waitForTransactionReceipt({hash,timeout:120000})));
if(ra.status!=='success'||rb.status!=='success')throw Error('Stimulus swap reverted');
console.log(`dislocation ${hashA} block ${ra.blockNumber}; closing swap ${hashB} block ${rb.blockNumber}`);

// Find the Reactive decision keyed to the dislocation transaction.
let decision:{id:Hash;tx:Hash;block:bigint}|undefined;
for(const until=Date.now()+90000;Date.now()<until&&!decision;await sleep(1000)){
  const logs=await reactive.getLogs({address:cfg.reactive,event:decisionEvent,args:{originTx:hashA},fromBlock:lasnaStart,toBlock:'latest'});
  if(logs.length)decision={id:logs[0].args.id as Hash,tx:logs[0].transactionHash,block:logs[0].blockNumber};
}
if(!decision)throw Error('No Reactive decision observed for the dislocation');
console.log(`reactive decision ${decision.tx} id ${decision.id}`);

// Find the callback delivery on Base: a transaction to the callback proxy carrying this decision id.
const proxy=(networks.base.callbackProxy as string).toLowerCase(),idHex=decision.id.slice(2).toLowerCase();
let callback:Hash|undefined,next=ra.blockNumber;
for(const until=Date.now()+120000;Date.now()<until&&!callback;){
  const head=await client.getBlockNumber();
  if(next>head){await sleep(500);continue;}
  const block=await client.getBlock({blockNumber:next,includeTransactions:true});
  for(const tx of block.transactions)if(tx.to?.toLowerCase()===proxy&&tx.input.toLowerCase().includes(idHex))callback=tx.hash;
  next++;
}
if(!callback)throw Error('Callback delivery not found on Base');
const rc=await client.waitForTransactionReceipt({hash:callback});
const completed=await client.readContract({address:fx.executor,abi:executorAbi,functionName:'completed',args:[decision.id]});
const completions=await client.getLogs({address:fx.executor,event:completeEvent,args:{id:decision.id},fromBlock:ra.blockNumber,toBlock:rc.blockNumber});
const result={kind:'rejected-stale-quote',at:new Date().toISOString(),direction,input:input.toString(),closingInput:closeInput.toString(),closeBps:closeBps.toString(),
  dislocationTx:hashA,dislocationBlock:ra.blockNumber.toString(),closingTx:hashB,closingBlock:rb.blockNumber.toString(),
  reactiveDecisionTx:decision.tx,decisionId:decision.id,callbackTx:callback,callbackBlock:rc.blockNumber.toString(),callbackStatus:rc.status,
  callbackLogs:rc.logs.map(l=>({address:l.address,topics:l.topics,data:l.data})),completedAfter:completed,completedEvents:completions.length};
const file=`measurements/rejected-${tag}.json`;
writeFileSync(file,JSON.stringify(result,null,2)+'\n');
console.log(`callback ${callback} status ${rc.status}; completed(id)=${completed}; Completed events ${completions.length} → ${file}`);
if(completed||completions.length)throw Error('Expected the stale callback to be rejected');
