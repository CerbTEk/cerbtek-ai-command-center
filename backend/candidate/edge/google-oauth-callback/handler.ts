import {createCallbackHandler} from "../_shared/company-email-oauth.ts";
export {cors} from "../_shared/company-email-oauth.ts";
export function createHandler(options:Omit<Parameters<typeof createCallbackHandler>[0],"provider">){return createCallbackHandler({...options,provider:"google"})}
