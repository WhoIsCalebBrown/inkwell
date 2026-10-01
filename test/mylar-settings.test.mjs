import assert from 'node:assert/strict';
import test from 'node:test';
import { createMylarSettings } from '../mylar-settings.js';

const base = 'http://mylar.test/';
const configData = (overrides = {}) => Object.entries({
  autowant_all: 'False', autowant_upcoming: 'False', keep_html_cache: 'True', auto_update: 'False',
  rtorrent_ssl: 'False', experimental: 'False', enable_32p: 'False', enable_external_server: 'False',
  enforce_perms: 'True', ct_tag_cbl: 'False', newznab_name1: 'Private indexer', newznab_host1: 'https://indexer.test',
  newznab_apikey1: 'provider-secret', ...overrides,
}).map(([key, value]) => [key, value]);

function page({ all = false, upcoming = false, action = 'configUpdate', extra = '' } = {}) {
  const checked = (value) => value ? ' checked' : '';
  return `<!doctype html><form id="configUpdate" action="${action}" method="post">
    <input type="checkbox" name="api_enabled" value="1" checked>
    <input type="password" name="api_key" value="api-secret">
    <input type="hidden" name="quoted_password" value="p&gt;&quot;&amp;">
    <input type="checkbox" name="enable_ddl" value="1" checked>
    <input type="checkbox" name="enable_getcomics" value="1" checked>
    <input type="checkbox" name="autowant_all" value="1"${checked(all)}>
    <input type="checkbox" name="autowant_upcoming" value="1"${checked(upcoming)}>
    <input type="password" name="newznab_name1" value="Private indexer">
    <input type="url" name="newznab_host1" value="https://indexer.test">
    <input type="password" name="newznab_apikey1" value="provider-secret">
    <input type="text" name="newznab_uid1" value="42">
    <input type="checkbox" name="newznab_verify1" value="1" checked>
    <input type="checkbox" name="newznab_enabled1" value="1" checked>
    <input type="radio" name="nzb_downloader" value="sabnzbd" checked>
    <input type="radio" name="nzb_downloader" value="nzbget">
    <select name="preferred_quality"><option value="0">Any</option><option value="1" selected>High</option></select>
    <textarea name="extra_newznabs">keep this</textarea>
    <input type="checkbox" name="enforce_perms" value="1" disabled>
    <input type="text" name="sabstatus" value="http://secret-status" disabled>
    <!-- <select name="pushbullet_device"><option value="bad" selected>bad</option></select> -->
    ${extra}
  </form>`;
}

function fakeMylar({ all = false, upcoming = false, config = {} } = {}) {
  let current = { all, upcoming, config: { ...Object.fromEntries(configData()), ...config } };
  const posts = [];
  const fetchFn = async (url, options = {}) => {
    const target = new URL(url).pathname;
    if (target === '/config') return new Response(page(current));
    if (target === '/getConfig') return Response.json({ aaData: configData({
      ...current.config, autowant_all: current.all ? 'True' : 'False', autowant_upcoming: current.upcoming ? 'True' : 'False',
    }) });
    if (target === '/configUpdate') {
      const body = new URLSearchParams(options.body);
      posts.push(body);
      current = { ...current, all: body.has('autowant_all'), upcoming: body.has('autowant_upcoming') };
      return new Response('OK');
    }
    return new Response('', { status: 404 });
  };
  return { fetchFn, posts, setConfig(value) { current = { ...current, config: { ...current.config, ...value } }; } };
}

test('saves only two intended toggles while preserving Mylar’s full form server-side', async () => {
  const fake = fakeMylar();
  const settings = createMylarSettings({ baseUrl: base, fetchFn: fake.fetchFn, readConfig: () => 'safe local config' });
  const snapshot = await settings.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['autoWantAll', 'autoWantUpcoming', 'code', 'editable', 'reason', 'version']);
  assert.equal(snapshot.editable, true);
  assert.equal(snapshot.autoWantAll, false);
  const saved = await settings.save({ autoWantAll: false, autoWantUpcoming: true, version: snapshot.version });
  assert.equal(saved.autoWantUpcoming, true);
  assert.equal(fake.posts.length, 1);
  const body = fake.posts[0];
  assert.equal(body.has('autowant_all'), false);
  assert.equal(body.get('autowant_upcoming'), '1');
  assert.equal(body.get('api_key'), 'api-secret');
  assert.equal(body.get('quoted_password'), 'p>"&', 'HTML entities in hidden credentials survive exactly');
  assert.equal(body.get('newznab_apikey1'), 'provider-secret');
  assert.equal(body.get('newznab_host1'), 'https://indexer.test');
  assert.equal(body.get('nzb_downloader'), 'sabnzbd');
  assert.equal(body.get('preferred_quality'), '1');
  assert.equal(body.get('extra_newznabs'), 'keep this');
  assert.equal(body.has('sabstatus'), false, 'disabled diagnostics are not config settings');
  assert.equal(body.get('keep_html_cache'), '1', 'unrendered true checkbox survives');
  assert.equal(body.get('enforce_perms'), '1', 'disabled true checkbox comes from in-memory config');
  assert.equal(body.has('pushbullet_device'), false, 'commented dynamic controls are ignored');
});

test('requires a current snapshot version and refuses a concurrent Mylar change', async () => {
  const fake = fakeMylar();
  const settings = createMylarSettings({ baseUrl: base, fetchFn: fake.fetchFn });
  const snapshot = await settings.snapshot();
  fake.setConfig({ newznab_apikey1: 'rotated-secret' });
  await assert.rejects(() => settings.save({ autoWantAll: false, autoWantUpcoming: false, version: snapshot.version }), /changed/i);
  assert.equal(fake.posts.length, 0);
  await assert.rejects(() => settings.save({ autoWantAll: false, autoWantUpcoming: false }), /valid/i);
  await assert.rejects(() => settings.save({ autoWantAll: false, autoWantUpcoming: false, version: snapshot.version, provider: 'nope' }), /valid/i);
});

test('fails closed for an authentication redirect and malformed provider form', async () => {
  const redirect = createMylarSettings({ baseUrl: base, fetchFn: async () => new Response('', { status: 303, headers: { Location: '/auth/login' } }) });
  assert.deepEqual(await redirect.snapshot(), {
    editable: false, reason: 'Mylar settings are unavailable.', code: 'unavailable',
    autoWantAll: null, autoWantUpcoming: null, version: null,
  });
  const malformed = createMylarSettings({ baseUrl: base, fetchFn: async (url) => {
    if (new URL(url).pathname === '/getConfig') return Response.json({ aaData: configData() });
    return new Response(page().replace('name="newznab_uid1"', 'name="missing_uid"'));
  } });
  const snapshot = await malformed.snapshot();
  assert.equal(snapshot.editable, false);
  assert.equal(snapshot.code, 'unsafe_form');
});

test('rejects a cross-origin action and keeps a reverse-proxy base path', async () => {
  const crossOrigin = createMylarSettings({ baseUrl: base, fetchFn: async (url) => {
    if (new URL(url).pathname === '/getConfig') return Response.json({ aaData: configData() });
    return new Response(page({ action: 'https://evil.test/configUpdate' }));
  } });
  assert.equal((await crossOrigin.snapshot()).code, 'unsafe_form');

  const calls = [];
  const proxied = createMylarSettings({ baseUrl: 'http://mylar.test/mylar/', fetchFn: async (url, options) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, signal: options.signal });
    if (target.pathname === '/mylar/getConfig') return Response.json({ aaData: configData() });
    if (target.pathname === '/mylar/config') return new Response(page());
    return new Response('', { status: 404 });
  } });
  assert.equal((await proxied.snapshot()).editable, true);
  assert.deepEqual(calls.map((call) => call.path).sort(), ['/mylar/config', '/mylar/getConfig']);
  assert.equal(calls.every((call) => call.signal instanceof AbortSignal), true, 'every Mylar read has a timeout signal');
});

test('rejects partial provider lists and incomplete configuration pagination', async () => {
  for (const extra of [
    { extra_newznabs: 'one, http://one, 1, secret1, 42, 1, 1, two, http://two, 1, secret2, 43, 1, 2' },
    { extra_torznabs: 'one, http://one, 1, secret, 7030, 1, 7' },
  ]) {
    const fake = fakeMylar({ config: extra });
    assert.equal((await createMylarSettings({ baseUrl: base, fetchFn: fake.fetchFn }).snapshot()).editable, false);
    assert.equal(fake.posts.length, 0);
  }
  const incomplete = createMylarSettings({ baseUrl: base, fetchFn: async (url) => new URL(url).pathname === '/config'
    ? new Response(page()) : Response.json({ aaData: configData(), iTotalDisplayRecords: 1001 }) });
  assert.equal((await incomplete.snapshot()).editable, false);
});

test('preserves entity-encoded credentials and accepts an empty multi-select', async () => {
  let body;
  let upcoming = false;
  const settings = createMylarSettings({ baseUrl: base, fetchFn: async (url, options = {}) => {
    if (new URL(url).pathname === '/config') return new Response(page({ upcoming })
      .replace('value="api-secret"', 'value="key&gt;&amp;&quot;&#39;"')
      .replace('</form>', '<select name="ignore_search_words[]" multiple></select></form>'));
    if (new URL(url).pathname === '/getConfig') return Response.json({ aaData: configData({ autowant_upcoming: upcoming ? 'True' : 'False' }) });
    body = new URLSearchParams(options.body);
    upcoming = body.has('autowant_upcoming');
    return new Response('OK');
  } });
  const snapshot = await settings.snapshot();
  assert.equal(snapshot.editable, true);
  await settings.save({ autoWantAll: false, autoWantUpcoming: true, version: snapshot.version });
  assert.equal(body.get('api_key'), 'key>&"\'');
  assert.equal(body.has('ignore_search_words[]'), false);
  await assert.rejects(settings.save({ autoWantAll: false, autoWantUpcoming: false, version: snapshot.version, api_key: 'forbidden' }), /valid/);
});
