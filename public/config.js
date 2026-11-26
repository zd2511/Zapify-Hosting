// Public browser configuration. The anon key is public by design with RLS enabled.
// NEVER put Supabase service-role keys or Cloudflare API tokens in this file.
window.ZAPIFY_CONFIG = {
  supabaseUrl: "YOUR_SUPABASE_PROJECT_URL",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
  apiBaseUrl: "YOUR_CLOUDFLARE_WORKER_URL"
};
