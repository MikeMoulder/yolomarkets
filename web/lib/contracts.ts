import type { Address } from "viem";

export const ADDRESSES = {
    factory: "0x1BED285DfD8C52e837A87681b73506B2301F7441" as Address,
    usdc: "0x3600000000000000000000000000000000000000" as Address,
    // Phase 4 redeploy — adds USDC binding + auto-approve before buy().
    agentFactory: "0x04538699e0dAe81258FD6Ff1408f763379827a8d" as Address,
} as const;

export enum Outcome {
    Unresolved = 0,
    Yes = 1,
    No = 2,
}

export const factoryAbi = [
    {
        type: "function",
        name: "marketCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "allMarkets",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address[]" }],
    },
    {
        type: "function",
        name: "markets",
        stateMutability: "view",
        inputs: [{ type: "uint256" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "admin",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
] as const;

export const marketAbi = [
    {
        type: "function",
        name: "question",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "category",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "resolutionCriteria",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
    {
        type: "function",
        name: "deadline",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "initialLiquidity",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "totalLiquidity",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "priceYes",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "int256" }],
    },
    {
        type: "function",
        name: "resolved",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "outcome",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }],
    },
    {
        type: "function",
        name: "totalSharesYes",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "totalSharesNo",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "sharesYes",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "sharesNo",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "previewBuy",
        stateMutability: "view",
        inputs: [{ type: "uint8" }, { type: "uint256" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "previewSell",
        stateMutability: "view",
        inputs: [{ type: "uint8" }, { type: "uint256" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "buy",
        stateMutability: "nonpayable",
        inputs: [
            { type: "uint8" },
            { type: "uint256" },
            { type: "uint256" },
        ],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "sell",
        stateMutability: "nonpayable",
        inputs: [
            { type: "uint8" },
            { type: "uint256" },
            { type: "uint256" },
        ],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "claim",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
] as const;

export const erc20Abi = [
    {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "address" }],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
    },
] as const;

export const agentFactoryAbi = [
    {
        type: "function",
        name: "deploy",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "predict",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "accountOf",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "accountCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
    },
    {
        type: "event",
        name: "AccountCreated",
        inputs: [
            { indexed: true, name: "owner", type: "address" },
            { indexed: true, name: "account", type: "address" },
        ],
    },
] as const;

export const agentAccountAbi = [
    {
        type: "function",
        name: "owner",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
    },
    {
        type: "function",
        name: "isSessionLive",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "sessions",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [
            { name: "validUntil", type: "uint64" },
            { name: "totalCap", type: "uint128" },
            { name: "totalSpent", type: "uint128" },
            { name: "perCallCap", type: "uint128" },
            { name: "allowedTarget", type: "address" },
            { name: "allowedSelector", type: "bytes4" },
        ],
    },
    {
        type: "function",
        name: "execute",
        stateMutability: "nonpayable",
        inputs: [
            { type: "address" },
            { type: "uint256" },
            { type: "bytes" },
        ],
        outputs: [{ type: "bytes" }],
    },
    {
        type: "function",
        name: "withdraw",
        stateMutability: "nonpayable",
        inputs: [
            { type: "address" },
            { type: "uint256" },
            { type: "address" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "grantSession",
        stateMutability: "nonpayable",
        inputs: [
            { name: "key", type: "address" },
            { name: "validUntil", type: "uint64" },
            { name: "totalCap", type: "uint128" },
            { name: "perCallCap", type: "uint128" },
            { name: "allowedTarget", type: "address" },
            { name: "allowedSelector", type: "bytes4" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "revokeSession",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }],
        outputs: [],
    },
    {
        type: "event",
        name: "SessionGranted",
        inputs: [
            { indexed: true, name: "key", type: "address" },
            { name: "validUntil", type: "uint64" },
            { name: "totalCap", type: "uint128" },
            { name: "perCallCap", type: "uint128" },
            { name: "allowedTarget", type: "address" },
            { name: "allowedSelector", type: "bytes4" },
        ],
    },
    {
        type: "event",
        name: "SessionRevoked",
        inputs: [{ indexed: true, name: "key", type: "address" }],
    },
] as const;

/** Phase 3 — bytes4(keccak256("buy(uint8,uint256,uint256)")).
 *  Sessions usually scope `allowedSelector` to this so the runner can only
 *  call PredictionMarket.buy() (and AgentAccount meters cost from its 3rd arg). */
export const BUY_SELECTOR = "0xf6d956df" as `0x${string}`;
