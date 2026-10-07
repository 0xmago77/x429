// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {X429Queue} from "../src/X429Queue.sol";

/// @dev Runs the deploy script in-process (nothing is broadcast to any node). Env vars are process-global,
///      so all cases live in a single test function to avoid races with parallel tests.
contract DeployScriptTest is Test {
    function test_deployScript_defaultsAndOverrides() public {
        address operator = makeAddr("deploy.operator");
        uint256 pk = uint256(keccak256("x429.deploy.test.key")); // throwaway key, test-only
        vm.deal(vm.addr(pk), 1 ether);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(pk));
        vm.setEnv("X429_OPERATOR", vm.toString(operator));

        // defaults (only when the optional vars are not set in the caller's environment)
        if (!vm.envExists("X429_MAX_LENGTH") && !vm.envExists("X429_QUEUE_META")) {
            (X429Queue queue, uint32 queueId) = new Deploy().run();
            assertEq(queueId, 1);
            X429Queue.Queue memory info = queue.queueInfo(queueId);
            assertEq(info.operator, operator);
            assertEq(info.maxLength, 64);
            assertEq(info.meta, '{"name":"x429 demo","serviceIntervalMs":15000}');
            assertEq(info.length, 0);
        }

        // overrides
        vm.setEnv("X429_MAX_LENGTH", "1024");
        vm.setEnv("X429_QUEUE_META", '{"name":"override"}');
        (X429Queue queue2, uint32 queueId2) = new Deploy().run();
        assertEq(queueId2, 1, "fresh contract, first queue");
        X429Queue.Queue memory info2 = queue2.queueInfo(queueId2);
        assertEq(info2.operator, operator);
        assertEq(info2.maxLength, 1024);
        assertEq(info2.meta, '{"name":"override"}');

        // out-of-range max length is rejected before anything is deployed
        vm.setEnv("X429_MAX_LENGTH", "1025");
        Deploy script = new Deploy();
        vm.expectRevert(bytes("X429_MAX_LENGTH must be in 1..1024"));
        script.run();
    }
}
