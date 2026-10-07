// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {X429Queue} from "../src/X429Queue.sol";

/// @notice Deploys X429Queue and opens one queue.
///
///         Env:
///           DEPLOYER_PRIVATE_KEY  (required) broadcasting key
///           X429_OPERATOR         (required) address allowed to serve / kick
///           X429_MAX_LENGTH       (optional, default 64, 1..1024)
///           X429_QUEUE_META       (optional, default {"name":"x429 demo","serviceIntervalMs":15000})
///
///         Prints machine-readable lines `X429_CONTRACT=<address>` and `X429_QUEUE_ID=<id>`. Writes no files.
contract Deploy is Script {
    string internal constant DEFAULT_META = '{"name":"x429 demo","serviceIntervalMs":15000}';
    uint256 internal constant DEFAULT_MAX_LENGTH = 64;

    function run() external returns (X429Queue queue, uint32 queueId) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address operator = vm.envAddress("X429_OPERATOR");
        uint256 maxLength = vm.envOr("X429_MAX_LENGTH", DEFAULT_MAX_LENGTH);
        string memory meta = vm.envOr("X429_QUEUE_META", DEFAULT_META);
        require(maxLength > 0 && maxLength <= 1024, "X429_MAX_LENGTH must be in 1..1024");

        vm.startBroadcast(pk);
        queue = new X429Queue();
        // casting to uint32 is safe: maxLength <= 1024 was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        queueId = queue.createQueue(operator, uint32(maxLength), meta);
        vm.stopBroadcast();

        console.log(string.concat("X429_CONTRACT=", vm.toString(address(queue))));
        console.log(string.concat("X429_QUEUE_ID=", vm.toString(uint256(queueId))));
        console.log(
            string.concat(
                "Deployed X429Queue at ",
                vm.toString(address(queue)),
                " by ",
                vm.toString(vm.addr(pk)),
                "; queue ",
                vm.toString(uint256(queueId)),
                " (operator ",
                vm.toString(operator),
                ", maxLength ",
                vm.toString(maxLength),
                ", meta ",
                meta,
                ")"
            )
        );
    }
}
