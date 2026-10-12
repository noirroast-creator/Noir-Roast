// Public Supabase settings. The anon key is designed to be public: the database rules
// (see supabase/schema.sql) only let visitors read the order counter and place orders.
// NEVER put the service_role / secret key in this file or anywhere on the website.
window.NOIR_CONFIG = {
  supabaseUrl: 'https://vjpjpkjqeyeohahjscta.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZqcGpwa2pxZXllb2hhaGpzY3RhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE3OTkzODIsImV4cCI6MjEwNzM3NTM4Mn0.3RMbR5dHrLo0M9UIr546ZIJGrhWJboJTmh9h9MWby8A',
};
