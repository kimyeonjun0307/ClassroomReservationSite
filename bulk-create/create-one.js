// create-one.js
// 절대 웹사이트(login.html 등)에 넣지 말고, 이 파일은 본인 컴퓨터 터미널에서만 node로 실행하세요.
// service_role 키는 DB 전체를 무제한으로 조작 가능한 키라서 브라우저/웹서버에 노출되면 위험합니다.
// 실행 후에는 아래 REPLACE_WITH_SERVICE_ROLE_KEY 부분에 넣었던 실제 키를 반드시 지우거나 파일을 삭제하세요.

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  'https://yclrlgcixldovbhygjrc.supabase.co',   // Project Settings → API → Project URL
  'REPLACE_WITH_SERVICE_ROLE_KEY'                // Project Settings → API → service_role (anon 키 아님!)
);

async function createOne() {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: '20230756@ubspace.local',
    password: '123456',
    email_confirm: true,
    user_metadata: {
      name: '김연준',
      department_id: 1,       // 소프트웨어융합대학
      staff_no: '20230756',
      phone: ''
    }
  });

  if (error) console.error('생성 실패:', error.message);
  else console.log('생성 완료:', data.user.id);
}

createOne();
