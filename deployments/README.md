# Deployments

One JSON file per network, written after a deployment (e.g. `arc-mainnet.json`):

```json
{
  "chainId": 5042,
  "network": "eip155:5042",
  "contract": "0x…",
  "queueId": 1,
  "operator": "0x…",
  "deployer": "0x…",
  "deployTx": "0x…",
  "deployBlock": 0,
  "maxLength": 64,
  "meta": "{\"name\":\"x429 demo\",\"serviceIntervalMs\":15000}",
  "commit": "<git sha of the deployed source>",
  "deployedAt": "2026-10-08T00:00:00Z"
}
```

Deploy with the Foundry script (it writes no files and only logs `X429_CONTRACT=` and `X429_QUEUE_ID=`):

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=… X429_OPERATOR=0x… \
  forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.arc.io --broadcast \
  --with-gas-price 50gwei --priority-gas-price 0.01gwei
```

`arc-forge script --network arc …` (Arc Foundry) works the same way; it is required against
`arc-anvil --network arc`, whose node-info stock forge rejects.

Then point the site at it: `X429_CHAIN=arc X429_CONTRACT=0x… X429_QUEUE_ID=1 X429_DEPLOY_BLOCK=… X429_ADDRESSES_FILE=… node demo/setup.ts site-config`.
