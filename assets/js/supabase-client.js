// 모든 페이지 공용 Supabase 클라이언트 + 인증 헬퍼
// 각 HTML에서 <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> 다음에 이 파일을 불러온다.
//
// 주의: CDN 라이브러리 자체가 전역 이름 `supabase`를 씀(window.supabase = { createClient, ... }).
// 여기서 만드는 클라이언트 인스턴스는 그거랑 이름이 겹치면 안 되므로 반드시 supabaseClient로 부른다.

const SUPABASE_URL = 'https://obakslwnehoghvenxoro.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_cUctnqCP7yFfUQnKPvtgtA_ApnicAep';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// 로그인 안 되어 있으면 login.html로 보낸다. 되어 있으면 assistants 프로필까지 합쳐서 돌려준다.
async function requireSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  const { data: profile, error } = await supabaseClient
    .from('assistants')
    .select('*')
    .eq('id', session.user.id)
    .single();
  if (error || !profile || !profile.is_active) {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
    return null;
  }
  return { session, profile };
}

// 특정 페이지가 요구하는 role과 실제 role이 다르면 자기 role에 맞는 페이지로 돌려보낸다.
function redirectToRoleHome(role) {
  if (role === 'final_admin') window.location.href = 'admin.html';
  else if (role === 'mid_admin') window.location.href = 'manager.html';
  else window.location.href = 'index.html';
}

async function requireRole(allowedRoles) {
  const auth = await requireSession();
  if (!auth) return null;
  if (!allowedRoles.includes(auth.profile.role)) {
    redirectToRoleHome(auth.profile.role);
    return null;
  }
  return auth;
}

async function signOutAndRedirect() {
  await supabaseClient.auth.signOut();
  window.location.href = 'login.html';
}
