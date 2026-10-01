// Mylar's configuration page is the only supported write surface for these
// settings. Keep its full form server-side: configUpdate resets omitted keys,
// so posting only two checkboxes would silently alter unrelated providers.
import crypto from 'node:crypto';
import { load } from 'cheerio';

const unavailable = (code = 'unavailable') => ({
  editable: false, reason: code === 'unsafe_form' ? 'Mylar settings page is not safe to edit.' : 'Mylar settings are unavailable.',
  code, autoWantAll: null, autoWantUpcoming: null, version: null,
});
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url');
function formMarkup(html, expectedAction) {
  const $ = load(String(html), { decodeEntities: true });
  const forms = $('form#configUpdate');
  if (forms.length !== 1) throw new Error('Mylar settings form is unavailable.');
  const form = forms.first();
  const action = new URL(String(form.attr('action') || ''), expectedAction);
  if (String(form.attr('method') || 'get').toLowerCase() !== 'post' || action.href !== expectedAction.href) {
    throw new Error('Mylar settings form is unavailable.');
  }
  return { $, form };
}

function disabled($, node) {
  // Cheerio covers the control's own disabled attribute. Fieldset inheritance
  // is handled explicitly because a disabled fieldset can otherwise leak a
  // credential into the POST even though a browser would omit it.
  return $(node).is(':disabled') || $(node).closest('fieldset[disabled]').length > 0;
}

function controlEntries($, form) {
  const entries = [];
  const seen = new Map();
  const add = (entry) => {
    if (!entry.name) return;
    const prior = seen.get(entry.name) || [];
    prior.push(entry);
    seen.set(entry.name, prior);
    entries.push(entry);
  };
  form.find('input, select, textarea').each((_index, node) => {
    const tag = node.tagName.toLowerCase();
    const element = $(node);
    const name = String(element.attr('name') || '');
    if (!name) return;
    const isDisabled = disabled($, node);
    if (tag === 'input') {
      const type = String(element.attr('type') || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) return;
      if (!['text', 'password', 'hidden', 'checkbox', 'radio', 'number', 'email', 'url', 'search'].includes(type)) {
        throw new Error('Mylar settings form uses an unsupported control.');
      }
      const checked = element.is(':checked');
      add({ name, value: element.attr('value') ?? '', type, checked, disabled: isDisabled });
      return;
    }
    if (tag === 'textarea') {
      add({ name, value: element.text().replace(/\r\n/g, '\n'), type: 'textarea', disabled: isDisabled });
      return;
    }
    const multiple = element.is('[multiple]');
    const options = element.find('option').toArray().map((option) => ({
      value: $(option).attr('value') ?? $(option).text(),
      selected: $(option).is(':selected'),
      disabled: disabled($, option) || $(option).closest('optgroup[disabled]').length > 0,
    }));
    if (!options.length && !multiple) throw new Error('Mylar settings form is unavailable.');
    const chosen = options.filter((option) => option.selected);
    const values = (chosen.length ? chosen : multiple ? [] : options.slice(0, 1)).filter((option) => !option.disabled).map((option) => option.value);
    add({ name, values, type: multiple ? 'select-multiple' : 'select', disabled: isDisabled });
  });
  for (const [name, controls] of seen) {
    const types = new Set(controls.map((control) => control.type));
    // Duplicate names are normal only for checkbox groups, radio groups, or
    // multi-selects. Anything else needs page-specific JavaScript to explain
    // which value configUpdate consumes, so fail closed.
    if (controls.length > 1 && !name.endsWith('[]') && ![...types].every((type) => ['checkbox', 'radio', 'select-multiple'].includes(type))) {
      throw new Error(`Mylar settings form has ambiguous ${name} controls.`);
    }
  }
  return entries;
}

function requiredControls(entries, config) {
  const names = new Set(entries.map((entry) => entry.name));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const name of ['api_enabled', 'api_key', 'enable_ddl', 'enable_getcomics', 'autowant_all', 'autowant_upcoming']) {
    if (!names.has(name) || byName.get(name).disabled) throw new Error('Mylar settings form is incomplete.');
  }
  // Provider identity is indexed by Mylar's persistent numeric row id. Do not
  // accept a page missing it: resubmitting would be able to rewrite a provider.
  const providerRows = new Set();
  for (const name of names) {
    const match = name.match(/^(?:newznab|torznab)_name(\d+)$/);
    if (match) providerRows.add(`${name.startsWith('newznab_') ? 'newznab' : 'torznab'}:${match[1]}`);
  }
  for (const row of providerRows) {
    const [prefix, id] = row.split(':');
    const fields = prefix === 'newznab'
      ? ['name', 'host', 'apikey', 'uid', 'verify', 'enabled']
      : ['name', 'host', 'apikey', 'category', 'verify', 'enabled'];
    if (fields.some((field) => !names.has(`${prefix}_${field}${id}`) || byName.get(`${prefix}_${field}${id}`).disabled)) {
      throw new Error('Mylar settings form is incomplete.');
    }
  }
  for (const prefix of ['newznab', 'torznab']) {
    const value = String(config.get(`extra_${prefix}s`) || '').trim();
    if (!config.has(`extra_${prefix}s`)) continue;
    // Mylar's getConfig flattens its seven-field provider records. Ambiguous
    // comma-containing records cannot safely be replayed through this adapter.
    const fields = value ? value.split(',').map((field) => field.trim()) : [];
    if (fields.length % 7) throw new Error('Mylar settings form is incomplete.');
    const ids = [];
    for (let index = 6; index < fields.length; index += 7) {
      if (!/^\d+$/.test(fields[index])) throw new Error('Mylar settings form is incomplete.');
      ids.push(fields[index]);
    }
    const formIds = [...providerRows].filter((row) => row.startsWith(`${prefix}:`)).map((row) => row.split(':')[1]);
    if (ids.length !== formIds.length || ids.some((id) => !formIds.includes(id))) {
      throw new Error('Mylar settings form is incomplete.');
    }
  }
}

function booleanControl(entries, name) {
  const controls = entries.filter((entry) => entry.name === name && entry.type === 'checkbox');
  if (controls.length !== 1) throw new Error('Mylar settings form is incomplete.');
  return controls[0].checked;
}

function serialise(entries, overrides, preservedFlags) {
  const body = new URLSearchParams();
  const encountered = new Set();
  for (const control of entries) {
    encountered.add(control.name);
    if (control.disabled && !PRESERVED_FLAGS.includes(control.name)) continue;
    const override = Object.hasOwn(overrides, control.name) ? overrides[control.name]
      : Object.hasOwn(preservedFlags, control.name) ? preservedFlags[control.name] : undefined;
    if (control.type === 'checkbox') {
      // Disabled controls are deliberately included at their displayed state.
      // Mylar's updater turns several missing checkboxes into False.
      const checked = override === undefined ? control.checked : override;
      if (checked) body.append(control.name, control.value || '1');
    } else if (control.type === 'radio') {
      if (control.checked) body.append(control.name, control.value);
    } else if (control.type === 'select' || control.type === 'select-multiple') {
      for (const value of control.values) body.append(control.name, value);
    } else body.append(control.name, control.value);
  }
  // Mylar's updater applies defaults to several booleans omitted from its
  // rendered form. Include their in-memory values so an unrelated save cannot
  // reset a Docker-disabled or legacy option.
  for (const [name, value] of Object.entries(preservedFlags)) {
    if (!encountered.has(name) && value) body.append(name, '1');
  }
  return body;
}

const PRESERVED_FLAGS = [
  'keep_html_cache', 'auto_update', 'rtorrent_ssl', 'experimental',
  'enable_32p', 'enable_external_server', 'enforce_perms', 'ct_tag_cbl',
];

function parseBoolean(value) {
  const normal = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normal)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normal)) return false;
  throw new Error('Mylar settings are unavailable.');
}

function configRows(payload) {
  if (!payload || !Array.isArray(payload.aaData)) throw new Error('Mylar settings are unavailable.');
  const rows = new Map();
  for (const row of payload.aaData) {
    if (!Array.isArray(row) || row.length < 2 || typeof row[0] !== 'string') throw new Error('Mylar settings are unavailable.');
    rows.set(row[0], String(row[1] ?? ''));
  }
  if (!rows.size || (payload.iTotalDisplayRecords != null && Number(payload.iTotalDisplayRecords) !== payload.aaData.length)) throw new Error('Mylar settings are unavailable.');
  return rows;
}

function configDigest(readConfig) {
  if (!readConfig) return null;
  try {
    const value = readConfig();
    return value == null ? null : digest(value);
  } catch { return null; }
}

export function createMylarSettings({ baseUrl, fetchFn = globalThis.fetch, readConfig = null } = {}) {
  if (!baseUrl || typeof fetchFn !== 'function') throw new Error('Mylar settings need a configured server connection.');
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const settingsUrl = new URL('config', base);
  const configUrl = new URL('getConfig?iDisplayStart=0&iDisplayLength=1000', base);
  const updateUrl = new URL('configUpdate', base);
  let saving = false;

  async function timedFetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    try { return await fetchFn(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async function fetchConfig() {
    let response;
    try { response = await timedFetch(configUrl, { redirect: 'manual', headers: { Accept: 'application/json' } }); }
    catch { throw new Error('Mylar settings are unavailable.'); }
    if (!response || response.status !== 200 || response.type === 'opaqueredirect' || response.redirected) {
      throw new Error('Mylar settings are unavailable.');
    }
    try { return configRows(await response.json()); }
    catch { throw new Error('Mylar settings are unavailable.'); }
  }

  async function load() {
    let response, config;
    try {
      [response, config] = await Promise.all([
        timedFetch(settingsUrl, { redirect: 'manual', headers: { Accept: 'text/html' } }), fetchConfig(),
      ]);
    } catch { return unavailable(); }
    if (!response || response.status !== 200 || response.type === 'opaqueredirect' || response.redirected) return unavailable();
    let html;
    try { html = await response.text(); } catch { return unavailable(); }
    try {
      const form = formMarkup(html, updateUrl);
      const entries = controlEntries(form.$, form.form);
      requiredControls(entries, config);
      const autoWantAll = parseBoolean(config.get('autowant_all'));
      const autoWantUpcoming = parseBoolean(config.get('autowant_upcoming'));
      if (autoWantAll !== booleanControl(entries, 'autowant_all') || autoWantUpcoming !== booleanControl(entries, 'autowant_upcoming')) {
        throw new Error('Mylar settings form is unavailable.');
      }
      const preservedFlags = Object.fromEntries(PRESERVED_FLAGS.map((name) => [name,
        config.has(name) ? parseBoolean(config.get(name)) : false]));
      // The mounted config hash is optional, but when supplied it catches a
      // concurrent disk-side edit even if Mylar has not refreshed its memory.
      const configHash = configDigest(readConfig);
      const canonical = JSON.stringify({ html, config: [...config.entries()].sort(([a], [b]) => a.localeCompare(b)), configHash });
      return {
        editable: true, reason: null,
        code: null, autoWantAll, autoWantUpcoming,
        version: digest(canonical), configHash, preservedFlags,
        entries, action: updateUrl,
      };
    } catch { return unavailable('unsafe_form'); }
  }

  return {
    async snapshot() {
      const result = await load();
      if (result.editable) {
        delete result.entries;
        delete result.action;
        delete result.configHash;
        delete result.preservedFlags;
      }
      return result;
    },
    async save(intent = {}) {
      const { autoWantAll, autoWantUpcoming, version } = intent;
      if (!intent || typeof intent !== 'object' || Object.keys(intent).some((key) => !['autoWantAll', 'autoWantUpcoming', 'version'].includes(key))
        || typeof autoWantAll !== 'boolean' || typeof autoWantUpcoming !== 'boolean' || typeof version !== 'string' || !version) {
        throw new Error('Choose valid automatic-download settings.');
      }
      if (saving) throw new Error('Mylar settings save is already running.');
      saving = true;
      try {
      const fresh = await load();
      if (!fresh.editable) throw new Error('Mylar settings are unavailable.');
      if (version !== fresh.version) {
        throw new Error('Mylar settings changed. Reload before saving.');
      }
      // The snapshot carries only the approved overrides. No caller can add a
      // provider, key, endpoint, or arbitrary Mylar setting to this payload.
      const body = serialise(fresh.entries, { autowant_all: autoWantAll, autowant_upcoming: autoWantUpcoming }, fresh.preservedFlags);
      let response;
      try {
        response = await timedFetch(fresh.action, { method: 'POST', redirect: 'manual', headers: {
          'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html',
        }, body });
      } catch { throw new Error('Mylar settings are unavailable.'); }
      if (!response || response.status < 200 || response.status >= 300 || response.type === 'opaqueredirect' || response.redirected) {
        throw new Error('Mylar settings are unavailable.');
      }
      return this.snapshot();
      } finally { saving = false; }
    },
    update(args) { return this.save(args); },
  };
}
