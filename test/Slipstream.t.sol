// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Pool} from "../src/Pool.sol";
import {TestToken} from "../src/TestToken.sol";
import {Executor, KeeperBaseline} from "../src/Executor.sol";
import {SlipstreamReactive} from "../src/SlipstreamReactive.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

contract MockSystem {
    uint256 public count;
    bytes public payload;
    function subscribe(uint256, address, uint256, uint256, uint256, uint256) external {}
    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external {
        count++;
        payload = c.payload;
    }
}

contract SlipstreamTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    address constant PROXY = address(0x100);
    TestToken t0;
    TestToken t1;
    Pool a;
    Pool b;
    Executor executor;
    SlipstreamReactive rc;

    function setUp() public {
        vm.warp(1000);
        MockSystem m = new MockSystem();
        vm.etch(SYSTEM, address(m).code);
        t0 = new TestToken("A", "A", 10000000 ether, address(this));
        t1 = new TestToken("B", "B", 10000000 ether, address(this));
        a = new Pool(t0, t1);
        b = new Pool(t0, t1);
        t0.approve(address(a), type(uint256).max);
        t1.approve(address(a), type(uint256).max);
        t0.approve(address(b), type(uint256).max);
        t1.approve(address(b), type(uint256).max);
        a.seed(1000000 ether, 1000000 ether);
        b.seed(1000000 ether, 1000000 ether);
        rc = new SlipstreamReactive(address(this), 10, address(a), address(b), 1000 ether, 1 ether, 50, 120, 700000);
        executor = new Executor(PROXY, address(rc), address(this), a, b, 1000 ether, 1 ether, 100);
        rc.setExecutor(address(executor));
        t0.transfer(address(executor), 10000 ether);
    }

    function dislocate() internal {
        a.swap(false, 50000 ether, 1, block.timestamp, bytes32(uint256(1)));
    }

    function execute(bytes32 id, uint256 deadline) internal {
        (uint256 mid, uint256 out) = executor.quote(true, 1000 ether);
        vm.prank(PROXY);
        executor.execute(address(rc), id, true, 1000 ether, mid, out, deadline);
    }

    function sync(Pool p, uint256 seq, address actor) internal {
        IReactive.LogRecord memory l;
        l.chainId = 10;
        l.contractAddress = address(p);
        l.topic0 = rc.SYNC();
        l.topic2 = uint256(uint160(actor));
        l.data = abi.encode(seq, p.reserve0(), p.reserve1());
        l.txHash = seq;
        l.logIndex = uint160(address(p));
        vm.prank(SYSTEM);
        rc.react(l);
    }

    function testProfitableAtomicTradeAndReplayNoop() public {
        dislocate();
        uint256 beforeBalance = t0.balanceOf(address(executor));
        execute(bytes32(uint256(1)), block.timestamp + 10);
        assertGe(t0.balanceOf(address(executor)), beforeBalance + 1 ether);
        execute(bytes32(uint256(1)), block.timestamp + 10);
        assertTrue(executor.completed(bytes32(uint256(1))));
    }

    function testWrongProxyAndIdRejected() public {
        vm.expectRevert();
        executor.execute(address(rc), 0, true, 1, 1, 2, 2000);
        vm.prank(PROXY);
        vm.expectRevert();
        executor.execute(address(99), 0, true, 1, 1, 2, 2000);
        IReactive.LogRecord memory l;
        vm.expectRevert();
        rc.react(l);
    }

    function testCapPauseDeadlineAndProfitGuards() public {
        dislocate();
        (uint256 mid, uint256 out) = executor.quote(true, 1000 ether);
        executor.setPaused(true);
        vm.prank(PROXY);
        vm.expectRevert();
        executor.execute(address(rc), 0, true, 1000 ether, mid, out, 2000);
        executor.setPaused(false);
        vm.prank(PROXY);
        vm.expectRevert();
        executor.execute(address(rc), 0, true, 1000 ether, mid, out, 999);
        vm.prank(PROXY);
        vm.expectRevert();
        executor.execute(address(rc), 0, true, 1001 ether, 2000 ether, 3000 ether, 2000);
        vm.prank(PROXY);
        vm.expectRevert();
        executor.execute(address(rc), 0, true, 1000 ether, 1000 ether, 1000 ether, 2000);
    }

    function testStaleQuoteRevertsAtomically() public {
        dislocate();
        (uint256 mid, uint256 out) = executor.quote(true, 1000 ether);
        a.swap(true, 100000 ether, 1, 2000, 0);
        uint256 beforeBalance = t0.balanceOf(address(executor));
        vm.prank(PROXY);
        vm.expectRevert();
        executor.execute(address(rc), 0, true, 1000 ether, mid, out, 2000);
        assertEq(t0.balanceOf(address(executor)), beforeBalance);
        assertFalse(executor.completed(0));
    }

    function testReactiveDetectsDedupsAndIgnoresFeedback() public {
        sync(a, 1, address(this));
        sync(b, 1, address(this));
        assertEq(MockSystem(SYSTEM).count(), 0);
        dislocate();
        sync(a, 2, address(this));
        assertEq(MockSystem(SYSTEM).count(), 1);
        sync(a, 2, address(this));
        assertEq(MockSystem(SYSTEM).count(), 1);
        sync(a, 3, address(executor));
        assertEq(MockSystem(SYSTEM).count(), 1);
        rc.setEnabled(false);
        sync(a, 4, address(this));
        assertEq(MockSystem(SYSTEM).count(), 1);
    }

    function testRecordedCallbackPayloadExecutesThroughProxy() public {
        sync(b, 1, address(this));
        dislocate();
        sync(a, 2, address(this));
        bytes memory payload = MockSystem(SYSTEM).payload();
        // Model exactly the proxy's first ABI argument replacement.
        address reactive = address(rc);
        assembly { mstore(add(payload, 36), reactive) }
        vm.prank(PROXY);
        (bool ok,) = address(executor).call(payload);
        assertTrue(ok);
        assertGt(t0.balanceOf(address(executor)), 10000 ether);
    }

    function testFuzzPoolConservesK(bool direction, uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1 ether, 10000 ether);
        uint256 k = uint256(a.reserve0()) * a.reserve1();
        a.swap(direction, amount, 0, 2000, 0);
        assertGe(uint256(a.reserve0()) * a.reserve1(), k);
    }
}

contract PoolHandler is Test {
    Pool public pool;
    TestToken public a;
    TestToken public b;
    uint256 public initialK;

    constructor() {
        a = new TestToken("A", "A", 1e30, address(this));
        b = new TestToken("B", "B", 1e30, address(this));
        pool = new Pool(a, b);
        a.approve(address(pool), type(uint256).max);
        b.approve(address(pool), type(uint256).max);
        pool.seed(1000000 ether, 1000000 ether);
        initialK = uint256(pool.reserve0()) * pool.reserve1();
    }

    function trade(bool direction, uint96 raw) external {
        pool.swap(direction, bound(uint256(raw), 1 ether, 10000 ether), 0, block.timestamp, 0);
    }
}

contract PoolInvariantTest is StdInvariant, Test {
    PoolHandler handler;

    function setUp() public {
        handler = new PoolHandler();
        targetContract(address(handler));
    }

    function invariant_FeesNeverDecreaseKAndReservesMatchBalances() public {
        Pool p = handler.pool();
        assertGe(uint256(p.reserve0()) * p.reserve1(), handler.initialK());
        assertEq(p.reserve0(), handler.a().balanceOf(address(p)));
        assertEq(p.reserve1(), handler.b().balanceOf(address(p)));
    }
}

contract ExecutorHandler is Test {
    TestToken public a;
    TestToken public b;
    Pool public first;
    Pool public second;
    Executor public executor;
    uint256 public nonce;
    uint256 public successful;
    address constant PROXY = address(0x100);
    address constant RC = address(0x500);

    constructor() {
        a = new TestToken("A", "A", 1e30, address(this));
        b = new TestToken("B", "B", 1e30, address(this));
        first = new Pool(a, b);
        second = new Pool(a, b);
        a.approve(address(first), type(uint256).max);
        b.approve(address(first), type(uint256).max);
        a.approve(address(second), type(uint256).max);
        b.approve(address(second), type(uint256).max);
        first.seed(1000000 ether, 1000000 ether);
        second.seed(1000000 ether, 1000000 ether);
        executor = new Executor(PROXY, RC, address(this), first, second, 1000 ether, 1 ether, 100);
        a.transfer(address(executor), 100000 ether);
    }

    function perturbAndExecute(bool direction, uint96 raw, bool authorized) external {
        first.swap(direction, bound(uint256(raw), 1 ether, 50000 ether), 0, block.timestamp, 0);
        (uint256 mid0, uint256 out0) = executor.quote(true, 1000 ether);
        (uint256 mid1, uint256 out1) = executor.quote(false, 1000 ether);
        bool route = out0 > out1;
        uint256 beforeBalance = a.balanceOf(address(executor));
        vm.prank(authorized ? PROXY : address(0xBAD));
        try executor.execute(
            RC, bytes32(++nonce), route, 1000 ether, route ? mid0 : mid1, route ? out0 : out1, block.timestamp
        ) {
            successful++;
            assertTrue(authorized);
            assertGe(a.balanceOf(address(executor)), beforeBalance + 1 ether);
        } catch {
            assertEq(a.balanceOf(address(executor)), beforeBalance);
        }
    }
}

contract ExecutorInvariantTest is StdInvariant, Test {
    ExecutorHandler handler;

    function setUp() public {
        handler = new ExecutorHandler();
        targetContract(address(handler));
    }

    function invariant_ExecutorInventoryNeverFalls() public view {
        assertGe(handler.a().balanceOf(address(handler.executor())), 100000 ether + handler.successful() * 1 ether);
    }
}
