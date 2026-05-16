import { IS_TESTNET } from '../../../lib/network';

export const MAINNET_API_BASE = 'https://explorer.gridcoin.club/api';
export const TESTNET_API_BASE = 'https://testnet-explorer.gridcoin.club/api';

export const API_BASE = IS_TESTNET ? TESTNET_API_BASE : MAINNET_API_BASE;
