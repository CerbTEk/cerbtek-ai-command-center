import { createClient } from '@supabase/supabase-js'
import { captureCompanyEmailReturn } from './company-email-callback'
import { captureRecoveryCallback, initializeRecovery } from './password-recovery'

const url = import.meta.env.VITE_SUPABASE_URL || 'https://suohuogalotxhsnkumvy.supabase.co'
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_tWFB1knj6CERZkUCDT-Lhw_2jibGTVh'

// Capture and replace the URL before the SDK can copy a token-bearing fragment
// into browser history. Other sign-in/confirmation flows retain SDK defaults.
captureCompanyEmailReturn()
const recoveryCallback = captureRecoveryCallback()
export const supabase = createClient(url, key, { auth: { detectSessionInUrl: !recoveryCallback } })
void initializeRecovery(supabase.auth, recoveryCallback)
