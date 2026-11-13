'use strict';
const { mentionPrompt } = require('./mention.cjs');
const protocol = require('./events.cjs');
const { createHash } = require('node:crypto');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'medium',
});
const { checkedResult, checkArgs, validateText, textElement, previewMessage } = require('./native.cjs');
function createGroup(session, binding, readJSON, writeJSON, signalMention = () => {}, { mentionsOnly = false, mentionsEnabled = () => true } = {}) {
  const msgs = session.getMsgService();
  const peer = { chatType: 2, peerUid: binding.id, guildId: '' };
  const seenFile = 'cursor-' + binding.id + '.json';
  let cursor = readJSON(seenFile);
  const self = String(binding.uin);
  const owner = readJSON('owner.json');
  if (
    owner &&
    (typeof owner.uin !== 'string' || !/^[1-9]\d{0,19}$/.test(owner.uin) || owner.uin === self)
  )
    throw Error('Invalid controller account; use a separate QQ account for the bridge');
  const closedRounds = readJSON('closed-rounds.json') ?? [];
  let activeWait = false;
  let lastPollAt, lastError, activePoll;
  let since = readJSON('mention-start-' + binding.id + '.json');
  function promptFor(raw) {
    const prompt = mentionPrompt(raw, binding, owner);
    if (prompt === null || !since || BigInt(raw.msgSeq) <= BigInt(since.seq) || !mentionsEnabled()) return null;
    return readJSON('owner.json')?.uin === owner.uin ? prompt : null;
  }
  function signal(raw) {
    if (promptFor(raw) !== null) signalMention(String(raw.msgSeq), String(raw.msgId));
  }
  function receive(rows) {
    if (Array.isArray(rows)) rows.forEach(signal);
  }
  function record(m) {
    if (
      m.chatType !== 2 ||
      String(m.peerUid) !== binding.id ||
      (m.peerUin && String(m.peerUin) !== '0' && String(m.peerUin) !== binding.id)
    ) {
      throw Error('Group identity mismatch');
    }
    const id = String(m.msgId),
      seq = String(m.msgSeq);
    if (!/^-?[1-9]\d*$/.test(id) || !/^\d+$/.test(seq))
      throw Error('Missing stable message identity');
    const uid = String(m.senderUid ?? ''),
      uin = String(m.senderUin ?? '');
    const hasSender = (uid && uid !== '0') || /^[1-9]\d*$/.test(uin);
    const fromSelf = hasSender ? uid === binding.uid || uin === self : null;
    return {
      group: binding.name,
      groupCode: binding.id,
      id,
      seq,
      fromSelf,
      priority: fromSelf === false && owner?.uin === uin ? 'owner' : 'normal',
      time: fmt.format(new Date(Number(m.msgTime) * 1000)),
      timezone: 'Asia/Shanghai',
      elements: m.elements.map((e) => e.textElement?.content ?? { elementType: e.elementType }),
    };
  }
  async function latestRecord() {
    const r = await msgs.getAioFirstViewLatestMsgs(peer, 1);
    checkedResult('getAioFirstViewLatestMsgs', r);
    if (r.msgList?.length !== 1)
      throw Error('getAioFirstViewLatestMsgs count=' + r.msgList?.length);
    const raw = r.msgList[0];
    return { raw, m: record(raw) };
  }
  async function range(start, end) {
    const count = Number(end - start >= 31n ? 32n : end - start + 1n);
    const r = await msgs.getMsgsBySeqAndCount(peer, String(start), count, false, true);
    checkedResult('getMsgsBySeqAndCount', r);
    if (!Array.isArray(r.msgList)) throw Error('getMsgsBySeqAndCount returned no list');
    return r.msgList
      .map((raw) => ({ raw, m: record(raw) }))
      .filter(({ m }) => BigInt(m.seq) >= start && BigInt(m.seq) <= end)
      .sort((a, b) => Number(BigInt(a.m.seq) - BigInt(b.m.seq)));
  }
  function save(next) {
    writeJSON(seenFile, next);
    cursor = next;
  }
  function baseline(m) {
    save({ seq: m.seq, ids: [m.id], pending: [] });
  }
  async function scan() {
    const expired = { ...cursor.events };
    if (protocol.expire(expired, Date.now())) save({ ...cursor, events: expired });
    const latest = await latestRecord();
    const top = latest.m;
    const start = BigInt(cursor.seq) + 1n;
    const end = BigInt(top.seq);
    if (start > end) return;
    const page = start === end ? [latest] : await range(start, end);
    if (!page.length)
      throw Error('Sequence range unavailable ' + start + '..' + end + '; cursor retained');
    const pending = [...(cursor.pending ?? [])],
      ids = [...cursor.ids];
    const events = { ...cursor.events };
    let seq = cursor.seq;
    for (const { raw, m } of page) {
      if (BigInt(m.seq) < BigInt(seq)) continue;
      signal(raw);
      if (!mentionsOnly && !ids.includes(m.id) && m.fromSelf === false) {
        const now = Date.now();
        const event = protocol.receive(
          m.elements,
          String(raw.senderUin ?? ''),
          self,
          Number(raw.msgTime) * 1000,
          events,
          now,
          closedRounds,
        );
        if (event) {
          if (pending.length >= 2048) throw Error('Inbox full; consume wait_next to continue');
          pending.push({ ...m, event, receivedAt: new Date(now).toISOString() });
        }
      }
      seq = m.seq;
      if (!ids.includes(m.id)) ids.push(m.id);
    }
    // Commit the queue and the high-water mark together even if Codex is closed.
    save({ seq, ids: ids.slice(-256), pending, events });
  }
  function sync() {
    if (!activePoll) {
      activePoll = scan()
        .then(() => {
          lastPollAt = new Date().toISOString();
          lastError = undefined;
        })
        .catch((e) => {
          lastError = e.message;
          throw e;
        })
        .finally(() => {
          activePoll = undefined;
        });
    }
    return activePoll;
  }
  async function watch(onStall) {
    let failures = 0;
    while (true) {
      // Restart a wedged native session through the owning supervisor.
      const watchdog = setTimeout(() => onStall('QQ history poll stalled for 30 s'), 30000);
      try {
        await sync();
        failures = 0;
      } catch (e) {
        failures++;
        if (failures === 1) console.error('QQ history sync: ' + e.message);
        if (failures >= 6 && !e.message.startsWith('Inbox full'))
          return onStall('QQ history sync failed: ' + e.message);
      } finally {
        clearTimeout(watchdog);
      }
      await pause(failures ? 3000 : 900);
    }
  }
  async function waitNext(ms, alive) {
    if (!Number.isInteger(ms) || ms < 0 || ms > 45000) throw Error('timeout_ms must be 0..45000');
    if (activeWait) throw Error('Another wait_next is already active');
    activeWait = true;
    const until = Date.now() + ms;
    try {
      while (alive()) {
        if (cursor?.pending?.length) {
          const pending = cursor.pending.slice();
          const ownerIndex = pending.findIndex((m) => m.priority === 'owner');
          const [message] = pending.splice(Math.max(0, ownerIndex), 1);
          save({ ...cursor, pending });
          if (message.elements.some((e) => protocol.matchesClosedRound(e, closedRounds))) continue;
          return {
            message: {
              ...previewMessage(message),
              event: protocol.deliver(message.event, cursor.events ?? {}, Date.now()),
            },
          };
        }
        if (Date.now() >= until) break;
        await pause(Math.min(100, until - Date.now()));
      }
      if (lastError) throw Error('QQ history sync: ' + lastError);
      return { timedOut: true };
    } finally {
      activeWait = false;
    }
  }
  // A request ID is reserved durably before entering native code. A repeat may
  // inspect its receipt, but can never submit a second message for the same ID.
  async function sendText(text, requestId, mentionReply = false) {
    validateText(text, requestId);
    const key = 'outbox/' + requestId + '.json';
    const digest = createHash('sha256').update(text).digest('hex');
    const previous = readJSON(key);
    if (previous) {
      if (previous.digest !== digest || previous.groupCode !== binding.id)
        throw Error('request_id already used for different content or group');
      return previous;
    }
    // Reject a disallowed event before any native I/O. Recheck after the await,
    // since another client or the watcher may have closed it in the meantime.
    protocol.reserve(text, cursor.events ?? {}, self, requestId, Date.now(), closedRounds);
    const before = (await latestRecord()).m;
    const tag = mentionsOnly ? '' : msgs.generateMsgUniqueId(2, session.getMSFService().getServerTime());
    if (!mentionsOnly && (!tag || String(tag) === '0')) throw Error('Could not generate message correlation ID');
    const receipt = {
      requestId,
      groupCode: binding.id,
      digest,
      beforeSeq: before.seq,
      state: 'unknown',
      correlation: String(tag),
    };
    // No await between the second lookup and reservation, even for concurrent calls.
    if (readJSON(key)) return sendText(text, requestId, mentionReply);
    if (mentionReply && (!mentionsEnabled() || readJSON('owner.json')?.uin !== owner.uin)) throw Error('Controller binding changed');
    const change = protocol.reserve(
      text,
      cursor.events ?? {},
      self,
      requestId,
      Date.now(),
      closedRounds,
    );
    if (change) save({ ...cursor, events: { ...cursor.events, [change.id]: change.value } });
    writeJSON(key, receipt);
    const element = textElement(text);
    const result = await msgs.sendMsg('0', { ...peer, guildId: String(tag) }, [element], new Map());
    checkedResult('sendMsg', result);
    receipt.state = 'accepted';
    writeJSON(key, receipt);
    const until = Date.now() + 15000;
    let nextSeq = BigInt(before.seq) + 1n;
    while (Date.now() < until) {
      const latest = await latestRecord();
      const top = latest.m;
      const end = BigInt(top.seq);
      if (end >= nextSeq) {
        const items =
          end === nextSeq ? [latest] : await range(nextSeq, end);
        const found = items.find(
          ({ raw, m }) =>
            m.fromSelf &&
            tag && Number(raw.sendStatus) === 2 &&
            String(raw.guildId) === String(tag) &&
            m.elements.length === 1 &&
            m.elements[0] === text,
        );
        // This QQ build may omit guildId from stored records. For a text
        // carrying its unique request ID, report the independent group readback.
        const echoes = items.filter(
          ({ m }) => m.fromSelf && m.elements.length === 1 && m.elements[0] === text,
        );
        const observed =
          found ||
          ((mentionReply || (requestId.length >= 8 && text.includes(requestId))) && echoes.length === 1
            ? echoes[0]
            : undefined);
        if (observed) {
          receipt.state = found ? 'confirmed' : 'observed_in_group';
          receipt.messageId = observed.m.id;
          receipt.time = observed.m.time;
          break;
        }
        // Follow the next page immediately on busy groups instead of polling the
        // same first 32 records until the readback deadline expires.
        if (items.length) {
          nextSeq = BigInt(items.at(-1).m.seq) + 1n;
          if (nextSeq <= end) continue;
        }
      }
      await pause(400);
    }
    writeJSON(key, receipt);
    return receipt;
  }
  return {
    async initialize() {
      const m = (await latestRecord()).m;
      if (!since) {
        since = { seq: m.seq };
        writeJSON('mention-start-' + binding.id + '.json', since);
      }
      if (!cursor) baseline(m);
      return m;
    },
    sync,
    receive,
    watch,
    status: () => ({
      lastPollAt,
      lastError,
      seq: cursor?.seq,
      queued: cursor?.pending?.length ?? 0,
    }),
    async call(name, args, alive) {
      if (name === 'reply_to_mention') {
        checkArgs(args, ['seq', 'id', 'text', 'group', 'account', 'owner']);
        if (!owner || args.group !== binding.id || args.account !== self || args.owner !== owner.uin ||
            typeof args.seq !== 'string' || !/^[1-9]\d*$/.test(args.seq) ||
            typeof args.id !== 'string' || !/^-?[1-9]\d*$/.test(args.id) ||
            typeof args.text !== 'string' || !args.text.trim())
          throw Error('Invalid mention reply or live binding');
        const seq = BigInt(args.seq);
        const matches = (await range(seq, seq)).filter(({ m, raw }) =>
          m.id === args.id && m.priority === 'owner' && promptFor(raw) !== null);
        if (matches.length !== 1) throw Error('Reply requires a verified controller mention');
        // Keep the output a single plain text element, even if it contains @ or a command.
        const prefix = '回复 #' + args.seq + '\n';
        const suffix = mentionsOnly ? '\n（完整回复见 Windows 上的 Codex 对话）' : '\n（完整回复见 Mac 上的 Codex 对话）';
        const full = prefix + args.text;
        const text = full.length <= 4000 ? full :
          full.slice(0, 4000 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
        return sendText(text, 'mention-reply-' + args.id, true);
      }
      if (name === 'trigger_page') {
        checkArgs(args, ['after','id']);
        if (!owner) throw Error('Set the controller account before enabling task routing');
        const latest = await latestRecord();
        const end = BigInt(latest.m.seq);
        const result = { group: binding.id, account: self, owner: owner.uin, top: String(end), rows: [] };
        if (args.after === undefined) return result;
        if (typeof args.after !== 'string' || !/^(0|[1-9]\d*)$/.test(args.after))
          throw Error('Invalid history cursor');
        const start = BigInt(args.after) + 1n;
        if (start > end) return result;
        if (args.id !== undefined && !/^-?[1-9]\d*$/.test(args.id)) throw Error('Invalid source message ID');
        const page = start === end ? [latest] : await range(start, args.id ? start : end);
        if (!page.length) throw Error('Trigger history unavailable; cursor retained');
        result.rows = page.filter(({m}) => !args.id || m.id === args.id).map(({ raw, m }) => {
          const e = raw.elements.length === 1 ? raw.elements[0] : null;
          const plain = m.priority === 'owner' && e?.elementType === 1 && e.textElement?.atType === 0
            && typeof e.textElement.content === 'string' && e.textElement.content.length <= 16000;
          return { chatType: 2, peerUid: binding.id, peerUin: binding.id, msgId: m.id, msgSeq: m.seq,
            senderUin: String(raw.senderUin), mentionPrompt: promptFor(raw), elements: plain ? [{ elementType: 1,
              textElement: { atType: 0, content: e.textElement.content } }] : [] };
        });
        return result;
      }
      if (name === 'read_latest') {
        checkArgs(args, []);
        return { ...previewMessage((await latestRecord()).m), replyPolicy: 'none' };
      }
      if (name === 'wait_next') {
        checkArgs(args, ['timeout_ms']);
        return waitNext(args.timeout_ms ?? 30000, alive);
      }
      if (name === 'send_text') {
        checkArgs(args, ['text', 'request_id']);
        return sendText(args.text, args.request_id);
      }
      throw Error('Unknown tool');
    },
  };
}
module.exports = { createGroup };
