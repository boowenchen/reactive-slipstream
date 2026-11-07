// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;
import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

contract SlipstreamReactive is AbstractReactive {
    uint256 public constant SYNC = uint256(keccak256("Sync(bytes32,address,uint256,uint112,uint112)"));

    struct Reserves {
        uint256 sequence;
        uint112 r0;
        uint112 r1;
    }
    Reserves[2] public reserves;
    address public immutable owner;
    uint256 public immutable originChain;
    address public immutable pool0;
    address public immutable pool1;
    uint256 public immutable amountIn;
    uint256 public immutable minProfit;
    uint256 public immutable spreadBps;
    uint256 public immutable ttl;
    uint64 public immutable callbackGas;
    address public executor;
    bool public enabled = true;
    event ExecutorLinked(address indexed executor);
    event Decision(
        bytes32 indexed id,
        bytes32 indexed originTx,
        uint256 logIndex,
        bytes32 stimulus,
        bool firstPool0,
        uint256 mid,
        uint256 out
    );

    constructor(
        address o,
        uint256 chain,
        address a,
        address b,
        uint256 amount,
        uint256 profit,
        uint256 spread,
        uint256 ttl_,
        uint64 gas_
    ) payable {
        require(
            o != address(0) && a != address(0) && b != address(0) && a != b && amount > 0 && amount <= type(uint112).max
                && profit > 0 && spread <= 10000 && ttl_ > 0 && ttl_ <= 1 hours && gas_ >= 100000,
            "config"
        );
        owner = o;
        originChain = chain;
        pool0 = a;
        pool1 = b;
        amountIn = amount;
        minProfit = profit;
        spreadBps = spread;
        ttl = ttl_;
        callbackGas = gas_;
        _subscriptions(true);
    }

    function setExecutor(address e) external {
        require(msg.sender == owner && executor == address(0) && e != address(0), "owner/executor");
        executor = e;
        emit ExecutorLinked(e);
    }

    function setEnabled(bool e) external {
        require(msg.sender == owner, "owner");
        if (enabled == e) return;
        enabled = e;
        _subscriptions(e);
    }

    function _subscriptions(bool e) internal {
        for (uint256 i; i < 2; i++) {
            address p = i == 0 ? pool0 : pool1;
            if (e) SYSTEM.subscribe(originChain, p, SYNC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            else SYSTEM.unsubscribe(originChain, p, SYNC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }

    function react(LogRecord calldata log) external onlySystem {
        if (
            !enabled || log.chainId != originChain || log.topic0 != SYNC
                || (log.contractAddress != pool0 && log.contractAddress != pool1)
        ) return;
        uint256 i = log.contractAddress == pool0 ? 0 : 1;
        (uint256 seq, uint112 a, uint112 b) = abi.decode(log.data, (uint256, uint112, uint112));
        if (seq <= reserves[i].sequence) return;
        reserves[i] = Reserves(seq, a, b);
        // Keep execution-induced reserves current without recursively trading.
        if (executor == address(0) || address(uint160(log.topic2)) == executor) return;
        Reserves memory x = reserves[0];
        Reserves memory y = reserves[1];
        if (x.r0 == 0 || x.r1 == 0 || y.r0 == 0 || y.r1 == 0) return;
        uint256 left = uint256(x.r1) * y.r0;
        uint256 right = uint256(y.r1) * x.r0;
        uint256 low = left < right ? left : right;
        uint256 diff = left > right ? left - right : right - left;
        if (diff * 10000 < low * spreadBps) return;
        bool direction = left > right;
        Reserves memory first = direction ? x : y;
        Reserves memory second = direction ? y : x;
        uint256 mid = _quote(amountIn, first.r0, first.r1);
        uint256 out = _quote(mid, second.r1, second.r0);
        if (out < amountIn + minProfit) return;
        bytes32 id = keccak256(abi.encode(log.chainId, log.txHash, log.logIndex));
        bytes memory payload = abi.encodeWithSignature(
            "execute(address,bytes32,bool,uint256,uint256,uint256,uint256)",
            address(0),
            id,
            direction,
            amountIn,
            mid,
            out,
            block.timestamp + ttl
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0(originChain, executor, callbackGas, payload)
        );
        emit Decision(id, bytes32(log.txHash), log.logIndex, bytes32(log.topic1), direction, mid, out);
    }

    function _quote(uint256 amount, uint256 rin, uint256 rout) internal pure returns (uint256) {
        return amount * 997 * rout / (rin * 1000 + amount * 997);
    }
}
