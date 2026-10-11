import {createConnectHandler} from "../_shared/company-email-oauth.ts";
export {cors} from "../_shared/company-email-oauth.ts";
export function createHandler(options:Omit<Parameters<typeof createConnectHandler>[0],"provider">){return createConnectHandler({...options,provider:"google"})}
