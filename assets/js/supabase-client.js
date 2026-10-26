// Supabase 프로젝트 정보 (Project Settings → API)
// anon 키는 공개용이라 브라우저에 노출돼도 괜찮음. 실제 접근 제어는 DB의 RLS 정책이 담당
var SUPABASE_URL = 'https://yclrlgcixldovbhygjrc.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljbHJsZ2NpeGxkb3ZiaHlnanJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2NzI2NTUsImV4cCI6MjEwMjI0ODY1NX0.hk2FB9D45QcGxFXPeNwNENcBusuOnLeakKNqA3gFtmo';
var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
