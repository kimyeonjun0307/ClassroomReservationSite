  var ROLE_REDIRECT = {
    assistant: 'index.html',
    mid_admin: 'manager.html',
    final_admin: 'admin.html'
  };

  function showMsg(text, type) {
    var el = document.getElementById('msg');
    el.textContent = text;
    el.className = 'form-msg ' + type;
    el.classList.remove('hidden');
  }

  (async function requireLogin() {
    var sessionRes = await supabase.auth.getSession();
    if (!sessionRes.data.session) {
      window.location.href = 'login.html';
    }
  })();

  document.getElementById('changeForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = document.getElementById('btnChange');
    var pw1 = document.getElementById('newPw').value;
    var pw2 = document.getElementById('newPw2').value;

    if (pw1.length < 6) { showMsg('비밀번호는 6자 이상이어야 해요.', 'error'); return; }
    if (pw1 !== pw2) { showMsg('두 비밀번호가 서로 달라요.', 'error'); return; }

    btn.disabled = true;

    var updateRes = await supabase.auth.updateUser({ password: pw1 });
    if (updateRes.error) {
      showMsg('비밀번호 변경에 실패했습니다: ' + updateRes.error.message, 'error');
      btn.disabled = false;
      return;
    }

    var sessionRes = await supabase.auth.getSession();
    var userId = sessionRes.data.session.user.id;

    var flagRes = await supabase.from('users').update({ must_change_password: false }).eq('id', userId);
    if (flagRes.error) {
      showMsg('비밀번호는 변경됐지만 상태 갱신에 실패했습니다: ' + flagRes.error.message, 'error');
      btn.disabled = false;
      return;
    }

    var profileRes = await supabase.from('users').select('role').eq('id', userId).single();
    window.location.href = (profileRes.data && ROLE_REDIRECT[profileRes.data.role]) || 'index.html';
  });
