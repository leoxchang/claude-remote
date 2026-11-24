export const ADMIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Remote 管理</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; color: #222; background: #f6f7f9; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #fff; border-bottom: 1px solid #e5e7eb; }
  .topbar h1 { margin: 0; font-size: 16px; }
  .gate { max-width: 360px; margin: 18vh auto 0; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; }
  .gate h2 { margin: 0 0 12px; font-size: 15px; }
  .gate input, .gate button { width: 100%; margin-top: 8px; }
  .main { display: none; }
  .layout { display: flex; gap: 16px; padding: 16px 20px; align-items: flex-start; }
  .accounts { width: 300px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
  .detail { flex: 1; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; min-height: 200px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; }
  .row:hover { background: #f3f4f6; }
  .row.selected { background: #e8f0fe; }
  .row .name { font-weight: 600; }
  .row .meta { color: #6b7280; font-size: 12px; }
  .badge-disabled { color: #b91c1c; font-size: 12px; }
  .detail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .detail-head h2 { margin: 0; font-size: 15px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button { padding: 5px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; }
  button:hover { background: #f9fafb; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.primary:hover { background: #1d4ed8; }
  button.danger { color: #b91c1c; border-color: #fca5a5; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-top: 1px solid #f0f0f0; font-size: 13px; }
  th { color: #6b7280; font-weight: 500; border-top: 0; }
  td .sub { color: #9ca3af; font-size: 12px; }
  .create { display: flex; gap: 8px; padding: 0 20px 16px; flex-wrap: wrap; }
  .create input { padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; }
  .error { display: none; margin: 0 20px 0; padding: 8px 12px; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 6px; }
  .empty { color: #9ca3af; padding: 16px 0; }
  input { font-size: 13px; }
</style>
</head>
<body>
<div class="topbar">
  <h1>Claude Remote 管理</h1>
  <button id="signOut" style="display:none">更换令牌</button>
</div>

<div class="gate" id="gate">
  <h2>输入管理令牌</h2>
  <input id="tokenInput" type="password" placeholder="RELAY_ADMIN_TOKEN" autocomplete="off">
  <button class="primary" id="tokenSubmit">进入</button>
</div>

<div class="main" id="main">
  <div class="error" id="error"></div>
  <div class="create">
    <input id="newUsername" placeholder="用户名">
    <input id="newPassword" type="password" placeholder="口令" autocomplete="new-password">
    <button class="primary" id="createButton">创建账号</button>
  </div>
  <div class="layout">
    <div class="accounts" id="accounts"></div>
    <div class="detail" id="detail">
      <div class="empty">选择左侧账号查看设备</div>
    </div>
  </div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'claude-remote-admin-token';
  var API = '/admin/api';
  var selected = null;
  var lastAccounts = [];

  function token() { return localStorage.getItem(TOKEN_KEY); }

  function showGate() {
    document.getElementById('gate').style.display = 'block';
    document.getElementById('main').style.display = 'none';
    document.getElementById('signOut').style.display = 'none';
    document.getElementById('tokenInput').value = '';
  }

  function showMain() {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    document.getElementById('signOut').style.display = 'inline-block';
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    selected = null;
    showGate();
  }

  function showError(code) {
    var el = document.getElementById('error');
    el.textContent = '操作失败：' + code;
    el.style.display = 'block';
    setTimeout(function () { el.style.display = 'none'; }, 5000);
  }

  function request(method, path, body) {
    var options = {
      method: method,
      headers: { authorization: 'Bearer ' + token() }
    };
    if (body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(API + path, options).then(function (res) {
      if (res.status === 401) {
        clearToken();
        throw new Error('UNAUTHORIZED');
      }
      return res.json().then(function (data) {
        if (!data.ok) throw new Error(data.error && data.error.code || 'REQUEST_FAILED');
        return data.result;
      });
    });
  }

  function renderAccounts(accounts) {
    lastAccounts = accounts;
    var list = document.getElementById('accounts');
    list.innerHTML = '';
    if (!accounts.length) {
      list.innerHTML = '<div class="empty">还没有账号</div>';
      document.getElementById('detail').innerHTML = '<div class="empty">选择左侧账号查看设备</div>';
      return;
    }
    accounts.forEach(function (account) {
      var row = document.createElement('div');
      row.className = 'row' + (account.username === selected ? ' selected' : '');
      var left = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = account.username;
      left.appendChild(name);
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = account.accountId;
      left.appendChild(meta);
      row.appendChild(left);
      if (account.disabled) {
        var badge = document.createElement('span');
        badge.className = 'badge-disabled';
        badge.textContent = '已禁用';
        row.appendChild(badge);
      }
      row.onclick = function () { selectAccount(account.username); };
      list.appendChild(row);
    });
  }

  function loadAccounts() {
    return request('GET', '/accounts').then(renderAccounts).catch(function (e) {
      if (e.message !== 'UNAUTHORIZED') showError(e.message);
    });
  }

  function selectAccount(username) {
    selected = username;
    if (lastAccounts.length) renderAccounts(lastAccounts);
    request('GET', '/accounts/' + encodeURIComponent(username) + '/devices')
      .then(renderDetail)
      .catch(function (e) {
        if (e.message !== 'UNAUTHORIZED') showError(e.message);
      });
  }

  function renderDetail(devices) {
    var detail = document.getElementById('detail');
    detail.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'detail-head';
    var title = document.createElement('h2');
    title.textContent = selected;
    head.appendChild(title);

    var actions = document.createElement('div');
    actions.className = 'actions';

    var toggle = document.createElement('button');
    toggle.textContent = '禁用账号';
    toggle.onclick = function () {
      if (!confirm('禁用账号「' + selected + '」？该账号所有在线连接将被断开。')) return;
      request('POST', '/accounts/' + encodeURIComponent(selected) + '/disable')
        .then(loadAccounts)
        .catch(function (e) { if (e.message !== 'UNAUTHORIZED') showError(e.message); });
    };
    actions.appendChild(toggle);

    var enable = document.createElement('button');
    enable.textContent = '启用账号';
    enable.onclick = function () {
      request('POST', '/accounts/' + encodeURIComponent(selected) + '/enable')
        .then(loadAccounts)
        .catch(function (e) { if (e.message !== 'UNAUTHORIZED') showError(e.message); });
    };
    actions.appendChild(enable);

    var reset = document.createElement('button');
    reset.textContent = '重置口令';
    reset.onclick = function () {
      var password = prompt('输入「' + selected + '」的新口令');
      if (!password) return;
      if (!confirm('确认重置「' + selected + '」的口令？')) return;
      request('POST', '/accounts/' + encodeURIComponent(selected) + '/reset-password', { password: password })
        .then(loadAccounts)
        .catch(function (e) { if (e.message !== 'UNAUTHORIZED') showError(e.message); });
    };
    actions.appendChild(reset);
    head.appendChild(actions);
    detail.appendChild(head);

    if (!devices.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '该账号还没有设备';
      detail.appendChild(empty);
      return;
    }

    var table = document.createElement('table');
    var header = document.createElement('tr');
    ['设备', '平台', ''].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      header.appendChild(th);
    });
    table.appendChild(header);
    devices.forEach(function (device) {
      var row = document.createElement('tr');
      var nameCell = document.createElement('td');
      nameCell.textContent = device.deviceName;
      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = device.deviceId + (device.revoked ? ' · 已吊销' : '');
      nameCell.appendChild(sub);
      row.appendChild(nameCell);
      var platformCell = document.createElement('td');
      platformCell.textContent = device.platform;
      row.appendChild(platformCell);
      var actionCell = document.createElement('td');
      if (!device.revoked) {
        var revoke = document.createElement('button');
        revoke.className = 'danger';
        revoke.textContent = '吊销';
        revoke.onclick = function () {
          if (!confirm('吊销设备「' + device.deviceName + '」？该设备将立即断线且无法再连。')) return;
          request('DELETE', '/devices/' + encodeURIComponent(device.deviceId))
            .then(function () { selectAccount(selected); })
            .catch(function (e) { if (e.message !== 'UNAUTHORIZED') showError(e.message); });
        };
        actionCell.appendChild(revoke);
      }
      row.appendChild(actionCell);
      table.appendChild(row);
    });
    detail.appendChild(table);
  }

  document.getElementById('tokenSubmit').onclick = function () {
    var value = document.getElementById('tokenInput').value.trim();
    if (!value) return;
    localStorage.setItem(TOKEN_KEY, value);
    showMain();
    loadAccounts();
  };

  document.getElementById('tokenInput').onkeydown = function (event) {
    if (event.key === 'Enter') document.getElementById('tokenSubmit').onclick();
  };

  document.getElementById('signOut').onclick = clearToken;

  document.getElementById('createButton').onclick = function () {
    var username = document.getElementById('newUsername').value.trim();
    var password = document.getElementById('newPassword').value;
    if (!username || !password) return;
    request('POST', '/accounts', { username: username, password: password })
      .then(function () {
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
        return loadAccounts();
      })
      .catch(function (e) { if (e.message !== 'UNAUTHORIZED') showError(e.message); });
  };

  if (token()) {
    showMain();
    loadAccounts();
  } else {
    showGate();
  }
})();
</script>
</body>
</html>
`;
