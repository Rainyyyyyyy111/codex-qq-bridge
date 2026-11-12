'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.QQ_STATE;
const app = '/Applications/QQ.app/Contents/Resources/app';
const version = require(path.join(app, 'package.json')).version;
if (version !== '6.9.55-28172' || process.arch !== 'arm64')
  throw Error('Unverified QQ version or architecture: ' + version);
const w = require(path.join(app, 'wrapper.node'));
const engine = w.NodeIQQNTWrapperEngine.get();
const login = w.NodeIKernelLoginService.get();
const session = w.NodeIQQNTWrapperSession.create();
if (process.argv[2] === 'probe') {
  console.log(
    JSON.stringify({
      version,
      node: process.versions.node,
      electron: process.versions.electron,
      arch: process.arch,
      engine: !!engine,
      login: !!login,
      session: !!session,
    }),
  );
  process.exit(0);
}
const { loadSettings } = require('./settings.cjs');
const profile = process.env.QQ_BRIDGE_PROFILE || 'default';
const settings = loadSettings(root, profile);
const target = 'Codex共享chat';
const globalDir = path.join(root, 'data/nt_qq/global');
const downloadDir = path.join(root, 'data/temp');
for (const dir of [globalDir, downloadDir, path.join(root, 'outbox')])
  fs.mkdirSync(dir, { recursive: true });
const appid = '537246115';
const platform = 4;
const system = os.release(),
  host = os.hostname();
let qrFile,
  loggedIn = false,
  loginStarted = false,
  querying = false;
let paired;
function removeQR() {
  if (qrFile) fs.rmSync(qrFile, { force: true });
  qrFile = undefined;
}
function stop(msg) {
  console.error(msg);
  paired?.stop();
  removeQR();
  fs.rmSync('bridge.sock', { force: true });
  // Native background threads can still be active during Node atexit handlers.
  process.removeAllListeners('SIGTERM');
  process.kill(process.pid, 'SIGTERM');
}
process.on('uncaughtException', (e) => stop(e.stack));
process.on('unhandledRejection', (e) => stop(String(e?.stack || e)));
process.on('SIGTERM', () => stop('Stopped'));
process.on('SIGINT', () => stop('Stopped'));
const idle = () => {};
function callbacks(methods = {}) {
  return new Proxy(methods, { get: (o, k) => (Object.hasOwn(o, k) ? o[k] : idle) });
}
function writeJSON(name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600, flush: true });
  fs.renameSync(file + '.tmp', file);
}
function readJSON(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
function validId(id) {
  return typeof id === 'string' && /^[1-9]\d*$/.test(id);
}
// Only an explicit local operator command can disambiguate a name.
function chooseGroup(id) {
  const pending = readJSON('needs-selection.json'),
    account = readJSON('account.json');
  if (
    !pending ||
    pending.name !== target ||
    !validId(id) ||
    !pending.ids.includes(id) ||
    pending.uid !== account?.uid ||
    pending.uin !== account?.uin
  )
    throw Error('Invalid group choice');
  const existing = readJSON('binding.json');
  if (existing && (existing.id !== id || existing.uid !== pending.uid))
    throw Error('A different binding already exists');
  const chosen = { name: target, id, uid: pending.uid, uin: pending.uin };
  writeJSON('binding.json', chosen);
  fs.rmSync('needs-selection.json');
  return chosen;
}
if (process.argv[2] === 'choose') {
  console.log('Selected ' + chooseGroup(process.argv[3]).id);
  process.exit(0);
}
for (const filename of fs.readdirSync(root)) {
  if (/^login-\d+\.png$/.test(filename)) fs.rmSync(path.join(root, filename));
}
let binding, direct;
let group,
  ready = false,
  phase = 'connecting';
require('./ipc.cjs').listen(async (name, args, alive, signal) => {
  if (name === 'status') return { phase, qrFile, ready, watch: group?.status() };
  if (name === 'choose_group') {
    if (!paired || phase !== 'group selection required; paired DM active') throw Error('No pending group choice');
    binding=chooseGroup(args.id);
    void startRead().catch(e=>stop(e.message));
    return {selected:binding.id};
  }
  if (['collab_info','collab_send','collab_wait','dm_latest','dm_send'].includes(name)) {
    if (!paired) throw Error('Collaboration not configured or native session not ready');
    return paired.call(name,args,signal);
  }
  if (!ready) throw Error('QQ ' + phase + (qrFile ? ' — 请扫码 ' + qrFile : ''));
  if (name === 'read_dm_latest' || name === 'send_dm_text') {
    if (!direct) throw Error('Direct contacts are disabled for this profile');
    // Revoking a contact takes effect even for clients with a cached tools/list.
    const current = loadSettings(root, profile);
    if (current.accountUin !== binding.uin || !current.peers.has(args.input?.contact) ||
        current.peers.get(args.input.contact) !== args.scope?.peerUin) {
      throw Error('Local contact authorization changed');
    }
    return direct(name, args.input, args.scope);
  }
  return group.call(name, args, alive);
});
async function startRead() {
  phase = 'syncing group';
  if (settings.peers.size) {
    fs.mkdirSync(path.join(root, 'dm-outbox'), { recursive: true, mode: 0o700 });
    direct = require('./direct.cjs').createDirect(session, binding, settings, readJSON, writeJSON);
  }
  group = require('./group.cjs').createGroup(session, binding, readJSON, writeJSON);
  let lastError;
  for (const delay of [0, 1000, 2000, 4000, 8000, 15000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const m = await group.initialize();
      await group.sync();
      if (!readJSON('binding.json')) writeJSON('binding.json', binding);
      if (!readJSON('group-pin.json'))
        writeJSON('group-pin.json', { name: target, id: binding.id });
      group.watch(stop).catch((e) => stop(e.message));
      ready = true;
      phase = 'ready';
      console.log('VERIFIED_READ group=' + m.groupCode + ' msgId=' + m.id);
      return;
    } catch (e) {
      lastError = e;
      if (!e.message.startsWith('getAioFirstViewLatestMsgs')) throw e;
      console.error(e.message);
    }
  }
  throw lastError;
}
function selectGroup({ uin, uid }) {
  if (querying) return;
  querying = true;
  const pin = readJSON('group-pin.json');
  if (pin && (pin.name !== target || !validId(pin.id))) throw Error('Invalid pinned group');
  binding = readJSON('binding.json');
  if (binding) {
    if (
      binding.name !== target ||
      (pin && binding.id !== pin.id) ||
      !validId(binding.id) ||
      binding.uid !== uid ||
      binding.uin !== uin
    )
      throw Error('Account or binding mismatch');
    return startRead();
  }
  if (pin) {
    binding = { name: target, id: pin.id, uid, uin };
    return startRead();
  }
  phase = 'finding exact group';
  const g = session.getGroupService();
  let selected = false;
  setTimeout(() => {
    if (!selected) {
      if (paired) phase = 'waiting for group directory; paired DM active';
      else stop('getGroupList: no complete directory matched the exact group name within 60 s');
    }
  }, 60000);
  function onList(list) {
    if (selected || !Array.isArray(list) || !list.length) return;
    const matched = [
      ...new Set(list.filter((x) => x.groupName === target).map((x) => String(x.groupCode))),
    ];
    if (!matched.length) return;
    if (!matched.every(validId)) throw Error('Invalid group code');
    if (matched.length > 1) {
      selected = true;
      writeJSON('needs-selection.json', { name: target, ids: matched, uid, uin });
      if (paired) { phase = 'group selection required; paired DM active'; return; }
      return stop('Ambiguous exact matches, choose a group code: ' + matched.join(', '));
    }
    selected = true;
    binding = { name: target, id: matched[0], uid, uin };
    writeJSON('binding.json', binding);
    console.log('Bound exact group name; reading one message');
    return startRead();
  }
  g.addKernelGroupListener(
    callbacks({
      onGroupListUpdate(type, list) {
        if (type === 0 || type === 1) return onList(list);
      },
    }),
  );
  console.log('getGroupList(true)');
  Promise.resolve(g.getGroupList(true)).then((r) => onList(r?.groupList));
}
function startSession({ uin, uid }) {
  if (loggedIn) return;
  if (!uin || !uid) throw Error('Authenticated account lacks uid or uin');
  if (settings.accountUin && settings.accountUin !== String(uin))
    throw Error('Authenticated account differs from settings.json');
  const owner = readJSON('owner.json');
  if (owner && String(uin) === owner.uin)
    return stop(
      'The personal controller account cannot be used as the bridge account; scan with the Mac collaboration account',
    );
  loggedIn = true;
  phase = 'initializing session';
  removeQR();
  console.log('AUTHENTICATED');
  const pinned = readJSON('binding.json') || readJSON('account.json');
  if (pinned && (pinned.uid !== uid || pinned.uin !== uin))
    throw Error('Authenticated account differs from pinned account');
  writeJSON('account.json', { uid, uin });
  const guid = login
    .getMachineGuid()
    .replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5');
  setTimeout(() => {
    if (!ready && !paired) stop('Session initialization timed out');
  }, 120000);
  session.init(
    {
      selfUin: uin,
      selfUid: uid,
      desktopPathConfig: { account_path: path.join(root, 'data') },
      clientVer: version,
      a2: '',
      d2: '',
      d2Key: '',
      machineId: '',
      platform,
      platVer: system,
      appid,
      rdeliveryConfig: {
        appKey: '',
        systemId: 0,
        appId: '',
        logicEnvironment: '',
        platform,
        language: '',
        sdkVersion: '',
        userId: '',
        appVersion: '',
        osVersion: '',
        bundleId: '',
        serverUrl: '',
        fixedAfterHitKeys: [''],
      },
      defaultFileDownloadPath: downloadDir,
      deviceInfo: {
        guid,
        buildVer: version,
        localId: 2052,
        devName: host,
        devType: os.type(),
        vendorName: '',
        osVer: system,
        vendorOsName: os.type(),
        setMute: false,
        vendorType: 0,
      },
      deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
    },
    callbacks(),
    callbacks(),
    callbacks({
      onOpentelemetryInit(info) {
        console.log('onOpentelemetryInit', info?.is_init);
        if (info?.is_init) setImmediate(() => {
          if (!paired && settings.collaborationContact) {
            fs.mkdirSync(path.join(root,'dm-outbox'),{recursive:true,mode:0o700});
            paired = require('./paired-dm.cjs').createPairedDM({root,self:{uin:String(uin),uid},settings,
              currentSettings:()=>loadSettings(root,profile),session,callbacks,readJSON,writeJSON,
              onDisconnect:()=>stop('Paired QQ session disconnected')});
            void paired.start();
          }
          selectGroup({ uin, uid });
        });
      },
    }),
  );
  console.log('session.startNT(0)');
  session.startNT(0);
}
console.log('engine.initWithDeskTopConfig');
engine.initWithDeskTopConfig(
  {
    base_path_prefix: '',
    platform_type: platform,
    app_type: 4,
    app_version: version,
    os_version: system,
    use_xlog: false,
    qua: 'V1_MAC_NQ_6.9.55_28172_GW_B',
    global_path_config: { desktopGlobalPath: globalDir },
    thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
  },
  callbacks(),
);
console.log('login.initConfig');
login.initConfig({
  machineId: '',
  appid,
  platVer: system,
  commonPath: globalDir,
  clientVer: version,
  hostName: host,
  externalVersion: false,
});
async function beginLogin() {
  if (loginStarted || loggedIn) return;
  loginStarted = true;
  const saved = readJSON('binding.json') || readJSON('account.json');
  if (saved) {
    if (settings.accountUin && settings.accountUin !== saved.uin)
      throw Error('This profile already belongs to another account; use a new profile');
    let account;
    for (const delay of [0, 500, 1500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const list = await login.getLoginList();
      account = list.LocalLoginInfoList?.find((a) => String(a.uin) === String(saved.uin));
      if (account?.isQuickLogin) break;
    }
    console.log(
      'Pinned account in native login list:',
      !!account,
      'quick login enabled:',
      !!account?.isQuickLogin,
    );
    if (account?.isQuickLogin) {
      const r = await login.quickLoginWithUin(saved.uin);
      console.log('quickLoginWithUin result:', String(r.result));
      if (String(r.result) === '0' && !r.loginErrorInfo?.errMsg) return;
    }
  }
  console.log('getQRCodePicture', login.getQRCodePicture());
}
login.addKernelLoginListener(
  callbacks({
    onLoginConnected: beginLogin,
    onQRCodeGetPicture({ pngBase64QrcodeData }) {
      const png = Buffer.from(
        pngBase64QrcodeData.replace(/^data:image\/png;base64,/, ''),
        'base64',
      );
      if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
        throw Error('Invalid Tencent QR image');
      phase = 'waiting for QR confirmation';
      removeQR();
      qrFile = path.join(root, 'login-' + Date.now() + '.png');
      fs.writeFileSync(qrFile, png, { mode: 0o600 });
      console.log('QR_READY ' + qrFile);
    },
    onQRCodeSessionUserScaned() {
      console.log('SCANNED');
    },
    onQRCodeSessionFailed(type, code) {
      if (loggedIn) return;
      removeQR();
      if (type === 1 && code === 3) {
        console.log('QR_EXPIRED');
        login.getQRCodePicture();
      } else stop('QR failed ' + type + '/' + code);
    },
    onUserLoggedIn() {
      stop('onUserLoggedIn: native service reports that this account is already logged in');
    },
    onQRCodeSessionQuickLoginFailed(code) {
      if (!loggedIn) {
        console.error('Quick login failed', Number(code));
        login.getQRCodePicture();
      }
    },
    onLoginDisConnected() {
      if (loggedIn) stop('Native login disconnected');
    },
    onLogoutSucceed() {
      stop('Native account logged out');
    },
    onLoginFailed(type, code) {
      stop('onLoginFailed ' + [type, code].filter(Number.isInteger).join('/'));
    },
    onQRCodeLoginSucceed: startSession,
  }),
);
console.log('login.connect');
login.connect();
setTimeout(() => {
  console.log('login transport', login.getMsfStatus());
  if (!loginStarted && login.getMsfStatus() !== 3) beginLogin();
}, 5000);
