import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Uses the new publishable key (sb_publishable_...)
// in the anon-key position, which @supabase/ssr supports.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
