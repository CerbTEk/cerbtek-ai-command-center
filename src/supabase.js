import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL || 'https://suohuogalotxhsnkumvy.supabase.co'
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_tWFB1knj6CERZkUCDT-Lhw_2jibGTVh'

export const supabase = createClient(url, key)
