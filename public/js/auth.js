'use strict';
// Client auth: login/register forms, token persistence, auto-resume.

(() => {
  const TOKEN_KEY = 'wuziqi_token';

  function token() { return localStorage.getItem(TOKEN_KEY); }

  async function api(method, url, body, withAuth) {
    const headers = { 'Content-Type': 'application/json' };
    if (withAuth && token()) headers.Authorization = 'Bearer ' + token();
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  function setError(text) {
    App.$('auth-error').textContent = text || '';
  }

  function loggedIn(username) {
    App.user = username;
    App.$('user-name').textContent = username;
    App.$('user-info').classList.remove('hidden');
    setError('');
    App.show('menu');
  }

  function loggedOut() {
    localStorage.removeItem(TOKEN_KEY);
    App.user = null;
    App.$('user-info').classList.add('hidden');
    if (window.Net) Net.disconnect();
    App.show('login');
  }

  window.Auth = { token, loggedOut };

  window.addEventListener('DOMContentLoaded', () => {
    const tabLogin = App.$('tab-login'), tabRegister = App.$('tab-register');
    const formLogin = App.$('form-login'), formRegister = App.$('form-register');

    function switchTab(showRegister) {
      tabLogin.classList.toggle('active', !showRegister);
      tabRegister.classList.toggle('active', showRegister);
      formLogin.classList.toggle('hidden', showRegister);
      formRegister.classList.toggle('hidden', !showRegister);
      setError('');
    }
    tabLogin.addEventListener('click', () => switchTab(false));
    tabRegister.addEventListener('click', () => switchTab(true));

    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      setError('');
      const { ok, data } = await api('POST', '/api/login', {
        username: App.$('login-username').value.trim(),
        password: App.$('login-password').value,
      });
      if (!ok) return setError(data.error || '登录失败');
      localStorage.setItem(TOKEN_KEY, data.token);
      loggedIn(data.username);
    });

    formRegister.addEventListener('submit', async (e) => {
      e.preventDefault();
      setError('');
      const username = App.$('reg-username').value.trim();
      const password = App.$('reg-password').value;
      if (password !== App.$('reg-password2').value) {
        return setError('两次输入的密码不一致');
      }
      const { ok, data } = await api('POST', '/api/register', { username, password });
      if (!ok) return setError(data.error || '注册失败');
      // Auto-login after registration.
      const login = await api('POST', '/api/login', { username, password });
      if (!login.ok) {
        switchTab(false);
        return setError('注册成功，请登录');
      }
      localStorage.setItem(TOKEN_KEY, login.data.token);
      loggedIn(login.data.username);
    });

    App.$('btn-logout').addEventListener('click', async () => {
      await api('POST', '/api/logout', { token: token() }).catch(() => {});
      loggedOut();
    });

    // Auto-resume an existing session.
    (async () => {
      if (!token()) return;
      const { ok, data } = await api('GET', '/api/me', null, true);
      if (ok) loggedIn(data.username);
      else localStorage.removeItem(TOKEN_KEY);
    })();
  });
})();
