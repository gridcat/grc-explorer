import { JsonOptions } from 'yayson';

export type Attributes = { [key: string]: unknown };

export interface PresenterInterface {
  render(data: unknown, options?: JsonOptions): Record<string, unknown>;
  type?: string;
}
