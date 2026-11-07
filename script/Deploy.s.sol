// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;
import {Script} from "forge-std/Script.sol";
import {Pool} from "../src/Pool.sol";
import {TestToken} from "../src/TestToken.sol";
import {Executor, KeeperBaseline, TradeEngine} from "../src/Executor.sol";
import {SlipstreamReactive} from "../src/SlipstreamReactive.sol";

contract Deploy is Script {
    function run() external {
        string memory cfg = vm.readFile("config/networks.json");
        string memory step = vm.envString("STEP");
        uint256 base = vm.parseJsonUint(cfg, ".base.chainId");
        uint256 lasna = vm.parseJsonUint(cfg, ".lasna.chainId");
        uint256 expected = vm.envUint("EXPECTED_CHAIN_ID");
        require(block.chainid == expected && (expected == base || expected == lasna), "wrong/testnet chain");
        address owner = vm.envAddress("OWNER");
        uint256 key = vm.envUint("PRIVATE_KEY");
        require(vm.addr(key) == owner, "owner/key mismatch");
        vm.startBroadcast(key);
        if (eq(step, "pools")) {
            require(expected == base, "Base");
            address t0 = vm.envOr("TOKEN0", address(0));
            address t1 = vm.envOr("TOKEN1", address(0));
            if (t0 == address(0)) t0 = address(new TestToken("Slipstream A", "SSA", 1000000000 ether, owner));
            if (t1 == address(0)) t1 = address(new TestToken("Slipstream B", "SSB", 1000000000 ether, owner));
            address a = vm.envOr("POOL0", address(0));
            address b = vm.envOr("POOL1", address(0));
            if (a == address(0)) new Pool(TestToken(t0), TestToken(t1));
            else require(Pool(a).token0() == TestToken(t0) && Pool(a).token1() == TestToken(t1), "pool0 pair");
            if (b == address(0)) new Pool(TestToken(t0), TestToken(t1));
            else require(Pool(b).token0() == TestToken(t0) && Pool(b).token1() == TestToken(t1), "pool1 pair");
        } else if (eq(step, "reactive")) {
            require(expected == lasna, "Lasna");
            address old = vm.envOr("REACTIVE", address(0));
            if (old == address(0)) {
                new SlipstreamReactive{value: vm.envUint("REACTIVE_FUND_WEI")}(
                    owner,
                    base,
                    vm.envAddress("POOL0"),
                    vm.envAddress("POOL1"),
                    vm.envUint("AMOUNT_WEI"),
                    vm.envUint("MIN_PROFIT_WEI"),
                    vm.envUint("SPREAD_BPS"),
                    vm.envUint("TTL_SECONDS"),
                    700000
                );
            } else {
                require(SlipstreamReactive(payable(old)).owner() == owner, "existing owner");
            }
        } else if (eq(step, "executor") || eq(step, "keeper")) {
            require(expected == base, "Base");
            address old = vm.envOr("EXECUTOR", address(0));
            if (old != address(0)) {
                require(TradeEngine(old).owner() == owner, "existing owner");
            } else if (eq(step, "executor")) {
                new Executor{value: vm.envUint("CALLBACK_FUND_WEI")}(
                    vm.parseJsonAddress(cfg, ".base.callbackProxy"),
                    vm.envAddress("REACTIVE"),
                    owner,
                    Pool(vm.envAddress("POOL0")),
                    Pool(vm.envAddress("POOL1")),
                    vm.envUint("AMOUNT_WEI"),
                    vm.envUint("MIN_PROFIT_WEI"),
                    vm.envUint("SLIPPAGE_BPS")
                );
            } else {
                new KeeperBaseline(
                    owner,
                    Pool(vm.envAddress("POOL0")),
                    Pool(vm.envAddress("POOL1")),
                    vm.envUint("AMOUNT_WEI"),
                    vm.envUint("MIN_PROFIT_WEI"),
                    vm.envUint("SLIPPAGE_BPS")
                );
            }
        } else if (eq(step, "link")) {
            require(expected == lasna, "Lasna");
            SlipstreamReactive rc = SlipstreamReactive(payable(vm.envAddress("REACTIVE")));
            address e = vm.envAddress("EXECUTOR");
            if (rc.executor() == address(0)) rc.setExecutor(e);
            else require(rc.executor() == e, "wrong executor");
        } else if (eq(step, "seed")) {
            require(expected == base, "Base");
            Pool a = Pool(vm.envAddress("POOL0"));
            Pool b = Pool(vm.envAddress("POOL1"));
            for (uint256 i; i < 2; i++) {
                Pool p = i == 0 ? a : b;
                if (p.reserve0() == 0) {
                    p.token0().approve(address(p), 1000000 ether);
                    p.token1().approve(address(p), 1000000 ether);
                    p.seed(1000000 ether, 1000000 ether);
                }
            }
            address e = vm.envAddress("EXECUTOR");
            uint256 desired = 1000000 ether;
            uint256 present = a.token0().balanceOf(e);
            if (present < desired) require(a.token0().transfer(e, desired - present), "transfer");
        } else {
            revert("unknown STEP");
        }
        vm.stopBroadcast();
    }

    function eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
