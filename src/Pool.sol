// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;
import {TestToken} from "./TestToken.sol";

/// Fixed demo liquidity, 30 bp swap fee. No LP/redemption product is implied.
contract Pool {
    TestToken public immutable token0;
    TestToken public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint256 public sequence;
    bool private locked;
    event Sync(bytes32 indexed stimulus, address indexed actor, uint256 sequence, uint112 reserve0, uint112 reserve1);
    event Swap(bytes32 indexed stimulus, address indexed sender, bool zeroForOne, uint256 amountIn, uint256 amountOut);
    modifier lock() {
        require(!locked, "locked");
        locked = true;
        _;
        locked = false;
    }

    constructor(TestToken a, TestToken b) {
        require(address(a) != address(b) && address(a) != address(0) && address(b) != address(0), "tokens");
        token0 = a;
        token1 = b;
    }

    function seed(uint112 a, uint112 b) external lock {
        require(reserve0 == 0 && reserve1 == 0 && a > 0 && b > 0, "seeded");
        require(
            token0.transferFrom(msg.sender, address(this), a) && token1.transferFrom(msg.sender, address(this), b),
            "transfer"
        );
        _sync(bytes32(0));
    }

    function quote(bool zeroForOne, uint256 amount) public view returns (uint256) {
        require(amount <= type(uint112).max, "amount");
        (uint256 rin, uint256 rout) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (rin == 0 || rout == 0) return 0;
        uint256 net = amount * 997;
        return net * rout / (rin * 1000 + net);
    }

    function swap(bool zeroForOne, uint256 amount, uint256 minOut, uint256 deadline, bytes32 stimulus)
        external
        lock
        returns (uint256 out)
    {
        require(block.timestamp <= deadline && amount > 0, "expired/zero");
        out = quote(zeroForOne, amount);
        require(out > 0 && out >= minOut, "slippage");
        TestToken input = zeroForOne ? token0 : token1;
        TestToken output = zeroForOne ? token1 : token0;
        require(input.transferFrom(msg.sender, address(this), amount) && output.transfer(msg.sender, out), "transfer");
        _sync(stimulus);
        emit Swap(stimulus, msg.sender, zeroForOne, amount, out);
    }

    function _sync(bytes32 stimulus) internal {
        uint256 a = token0.balanceOf(address(this));
        uint256 b = token1.balanceOf(address(this));
        require(a <= type(uint112).max && b <= type(uint112).max, "reserve overflow");
        reserve0 = uint112(a);
        reserve1 = uint112(b);
        sequence++;
        emit Sync(stimulus, msg.sender, sequence, reserve0, reserve1);
    }
}
