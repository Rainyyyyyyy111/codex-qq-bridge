'use strict';

// Shared by both machines. Only the local caller can submit QQ messages.
// The receiver returns data and updated local state; it never calls send.
const TTL = 15 * 60_000;
const marker = 'QQCOOP/1';
const header =
  /^QQCOOP\/1 (REQUEST|DONE|FAILED) ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}) ([1-9]\d{0,19})$/;

function parse(text) {
  if (typeof text !== 'string' || !text.startsWith(marker)) return null;
  const newline = text.indexOf('\n');
  const match = newline > 0 && header.exec(text.slice(0, newline));
  if (!match || !text.slice(newline + 1).trim()) return { invalid: true };
  return { kind: match[1], id: match[2], to: match[3] };
}

function matchesClosedRound(text, rounds) {
  return (
    typeof text === 'string' &&
    !text.startsWith(marker) &&
    rounds.some((round) => round.aliases.some((alias) => text.includes(alias)))
  );
}

function note(kind, id, replyPolicy) {
  return { kind, id, replyPolicy };
}

function expire(events, now) {
  let changed = false;
  for (const [id, event] of Object.entries(events)) {
    if (event.state === 'open' && event.deadline <= now) {
      events[id] = { ...event, state: 'expired' };
      changed = true;
    }
  }
  return changed;
}

function canFinish(event, side, peer, now) {
  return (
    event?.side === side && event.state === 'open' && event.peer === peer && event.deadline > now
  );
}

function reserve(text, events, self, requestId, now, rounds) {
  if (matchesClosedRound(text, rounds)) throw Error('This round is closed; no further group reply');
  const wire = parse(text);
  if (!wire) {
    // Keep the manual-text path available, but do not let an unframed
    // follow-up silently bypass the lifecycle of a known protocol event.
    if (Object.keys(events).some((id) => text.includes(id)))
      throw Error('Use the event header for an existing event');
    return null;
  }
  if (wire.invalid || wire.to === self) throw Error('Invalid event header or destination');
  const prior = events[wire.id];
  if (wire.kind === 'REQUEST') {
    if (prior) throw Error('Event already exists; cannot start it again');
    return {
      id: wire.id,
      value: { side: 'initiator', state: 'open', peer: wire.to, deadline: now + TTL, requestId },
    };
  }
  if (!canFinish(prior, 'responder', wire.to, now))
    throw Error('No open incoming event for this result');
  // Reserve the one terminal send before entering the native module, even if the
  // process subsequently crashes or the transport returns an uncertain result.
  return { id: wire.id, value: { ...prior, state: 'closed', outcome: wire.kind, requestId } };
}

function receive(elements, senderUin, self, sentAt, events, now, rounds) {
  if (elements.some((text) => matchesClosedRound(text, rounds))) return null;
  const wire = parse(elements[0]);
  if (!wire) return { kind: 'data', replyPolicy: 'none' };
  if (
    elements.length !== 1 ||
    wire.invalid ||
    wire.to !== self ||
    !/^[1-9]\d{0,19}$/.test(senderUin) ||
    senderUin === self
  )
    return null;
  const prior = events[wire.id];
  if (wire.kind === 'REQUEST') {
    if (prior || !Number.isFinite(sentAt)) return null;
    const deadline = Math.min(now, sentAt) + TTL;
    events[wire.id] = {
      side: 'responder',
      state: deadline > now ? 'open' : 'expired',
      peer: senderUin,
      deadline,
    };
    if (deadline <= now) return null;
    return {
      ...note(wire.kind, wire.id, 'one_final_result_with_local_approval'),
      replyToUin: senderUin,
    };
  }
  if (!canFinish(prior, 'initiator', senderUin, now)) return null;
  events[wire.id] = { ...prior, state: 'closed', outcome: wire.kind };
  return note(wire.kind, wire.id, 'none');
}

function deliver(event, events, now) {
  if (event?.kind === 'REQUEST' && !canFinish(events[event.id], 'responder', event.replyToUin, now))
    return note('closed', event.id, 'none');
  return event ?? { kind: 'data', replyPolicy: 'none' };
}

module.exports = { reserve, receive, deliver, expire, matchesClosedRound, TTL };
