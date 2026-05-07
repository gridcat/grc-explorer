import { IS_TESTNET } from '../../../lib/network';

export const API_BASE = IS_TESTNET
  ? 'https://testnet-explorer.gridcoin.club/api'
  : 'https://explorer.gridcoin.club/api';
