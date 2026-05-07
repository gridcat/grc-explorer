import { Network } from '../theme';

const RAW = process.env.NEXT_PUBLIC_NETWORK ?? 'testnet';

export const NETWORK: Network = RAW === 'mainnet' ? 'mainnet' : 'testnet';

export const IS_TESTNET = NETWORK === 'testnet';
