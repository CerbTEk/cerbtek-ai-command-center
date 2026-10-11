// Provider-neutral own-mailbox authority for the existing human-approved send route.
// Legacy Microsoft names are retained at the RPC boundary for deployed compatibility.
import {connectionBinding, getMicrosoftAccessToken} from './microsoft-connection.ts';
import {getGoogleAccessToken} from './google-connection.ts';
export const GOOGLE_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GOOGLE_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const emailProvider = (value: unknown) => value === 'microsoft' || value === 'google';
export function emailConnectionBinding(connection: any, integration: any) {
  const binding = connectionBinding(connection, integration);
  return connection.provider === 'google' ? {...binding, external_account_email: connection.external_account_email} : binding;
}
export function emailSendGranted(connection: any) {
  return Array.isArray(connection.scopes) && connection.scopes.includes(connection.provider === 'microsoft' ? 'Mail.Send' : GOOGLE_SEND_SCOPE);
}
export async function getEmailAccessToken(args: any) {
  if (!emailProvider(args.connection?.provider)) throw new Error('Unsupported email account');
  return args.connection.provider === 'google' ? getGoogleAccessToken(args) : getMicrosoftAccessToken(args);
}
