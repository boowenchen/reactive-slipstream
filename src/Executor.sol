// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Pool} from "./Pool.sol";
import {TestToken} from "./TestToken.sol";

abstract contract TradeEngine {
    address public immutable owner;
    Pool public immutable pool0;
    Pool public immutable pool1;
    uint256 public immutable maxInput;
    uint256 public immutable minProfit;
    uint256 public immutable slippageBps;
    bool public paused;
    mapping(bytes32 => bool) public completed;
    event Completed(bytes32 indexed id, uint256 amountIn, uint256 amountOut, uint256 profit);
    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    constructor(address o, Pool a, Pool b, uint256 cap, uint256 profit, uint256 slippage) {
        require(
            o != address(0) && address(a) != address(b) && cap > 0 && cap <= type(uint112).max && profit > 0
                && slippage <= 1000,
            "config"
        );
        require(a.token0() == b.token0() && a.token1() == b.token1(), "pair");
        owner = o;
        pool0 = a;
        pool1 = b;
        maxInput = cap;
        minProfit = profit;
        slippageBps = slippage;
        require(
            a.token0().approve(address(a), type(uint256).max) && a.token0().approve(address(b), type(uint256).max),
            "approve0"
        );
        require(
            a.token1().approve(address(a), type(uint256).max) && a.token1().approve(address(b), type(uint256).max),
            "approve1"
        );
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
    }

    function withdraw(TestToken token, uint256 amount) external onlyOwner {
        require(paused, "pause first");
        require(token.transfer(owner, amount), "transfer");
    }

    function quote(bool firstPool0, uint256 amount) public view returns (uint256 mid, uint256 out) {
        Pool first = firstPool0 ? pool0 : pool1;
        Pool second = firstPool0 ? pool1 : pool0;
        mid = first.quote(true, amount);
        out = second.quote(false, mid);
    }

    function _execute(
        bytes32 id,
        bool firstPool0,
        uint256 amount,
        uint256 expectedMid,
        uint256 expectedOut,
        uint256 deadline
    ) internal {
        if (completed[id]) return;
        require(!paused && block.timestamp <= deadline, "paused/expired");
        require(amount > 0 && amount <= maxInput, "cap");
        require(expectedMid > 0 && expectedOut >= amount + minProfit, "unprofitable");
        Pool first = firstPool0 ? pool0 : pool1;
        Pool second = firstPool0 ? pool1 : pool0;
        uint256 beforeBalance = pool0.token0().balanceOf(address(this));
        completed[id] = true;
        uint256 mid = first.swap(true, amount, expectedMid * (10000 - slippageBps) / 10000, deadline, id);
        uint256 floor = expectedOut * (10000 - slippageBps) / 10000;
        if (floor < amount + minProfit) floor = amount + minProfit;
        uint256 out = second.swap(false, mid, floor, deadline, id);
        require(pool0.token0().balanceOf(address(this)) >= beforeBalance + minProfit, "profit");
        emit Completed(id, amount, out, out - amount);
    }
}

contract Executor is AbstractCallback, TradeEngine {
    constructor(
        address proxy,
        address reactive,
        address owner_,
        Pool a,
        Pool b,
        uint256 cap,
        uint256 profit,
        uint256 slippage
    ) payable AbstractCallback(IPayable(payable(proxy)), reactive) TradeEngine(owner_, a, b, cap, profit, slippage) {
        require(proxy != address(0) && reactive != address(0), "address");
    }

    function execute(
        address rc,
        bytes32 id,
        bool firstPool0,
        uint256 amount,
        uint256 mid,
        uint256 out,
        uint256 deadline
    ) external onlyServiceProvider onlyCallbackSender(rc) {
        _execute(id, firstPool0, amount, mid, out, deadline);
    }
}

/// Separate fixture for measuring a real polling keeper. Never the Reactive recipient.
contract KeeperBaseline is TradeEngine {
    constructor(address o, Pool a, Pool b, uint256 cap, uint256 profit, uint256 slippage)
        TradeEngine(o, a, b, cap, profit, slippage)
    {}

    function execute(bytes32 id, bool direction, uint256 amount, uint256 mid, uint256 out, uint256 deadline)
        external
        onlyOwner
    {
        _execute(id, direction, amount, mid, out, deadline);
    }
}
