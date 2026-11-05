"""Durable queue for locally authorized QQ tasks."""

import re
import sqlite3
from contextlib import contextmanager

ROUTE_NAME = r"(?:mac|win|acct-[a-z][a-z0-9-]{0,23})"
ROUTE = re.compile(r"/task +(" + ROUTE_NAME + r") +")


def routed_body(text, route):
    if not isinstance(text, str):
        return None
    routes = set()
    pos = 0
    while text.startswith("/task ", pos):
        match = ROUTE.match(text, pos)
        if not match:
            return None
        routes.add(match[1])
        pos = match.end()
    body = text[pos:]
    if route in routes and body.strip():
        return body
    return None


def decimal(value, signed=False):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value)
    return text if re.fullmatch(r"-?[1-9][0-9]*" if signed else r"[1-9][0-9]*", text) else None


class StalePage(ValueError):
    """Another reader committed this page while the native query was in flight."""


class TriggerQueue:
    """One private database per bridge account. Bind on local operator enablement."""

    def __init__(self, path, group, owner, account, route, live_account, enabled_after):
        if (
            not re.fullmatch(ROUTE_NAME, route)
            or account != live_account
            or account == owner
            or not all(decimal(n) for n in (group, owner, account))
        ):
            raise ValueError("Invalid local binding or authenticated account")
        self.group, self.owner, self.account, self.route = group, owner, account, route
        self.db = sqlite3.connect(path, timeout=5, isolation_level=None)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS scope (
                id INTEGER PRIMARY KEY CHECK(id=1), grp TEXT, owner TEXT, account TEXT,
                route TEXT, enabled_after INTEGER NOT NULL, cursor INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks (
                grp TEXT NOT NULL, msg_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
                state TEXT NOT NULL, host TEXT, thread_id TEXT, client_id TEXT,
                PRIMARY KEY(grp,msg_id));
        """
        )
        with self.transaction():
            if "updated" not in {row[1] for row in self.db.execute("PRAGMA table_info(tasks)")}:
                self.db.execute("ALTER TABLE tasks ADD COLUMN updated INTEGER NOT NULL DEFAULT 0")
            self.db.execute(
                "INSERT OR IGNORE INTO scope VALUES(1,?,?,?,?,?,?)",
                (group, owner, account, route, enabled_after, enabled_after),
            )
            stored = self.db.execute(
                "SELECT grp,owner,account,route,enabled_after FROM scope"
            ).fetchone()
            if stored[:4] != (group, owner, account, route):
                raise ValueError("Existing database belongs to another binding")
            self.enabled_after = stored[4]

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def _record(self, m, *, replay=False):
        if (
            m.get("chatType") != 2
            or str(m.get("peerUid")) != self.group
            or str(m.get("peerUin", "0")) not in ("0", self.group)
        ):
            raise ValueError("Foreign or unverified conversation")
        seq = decimal(m.get("msgSeq"))
        msg_id = decimal(m.get("msgId"), signed=True)
        if not seq or not msg_id:
            raise ValueError("Missing stable QQ identity")
        seq = int(seq)
        if (seq <= self.enabled_after and not replay) or str(m.get("senderUin")) != self.owner:
            return seq
        elements = m.get("elements")
        if not isinstance(elements, list) or len(elements) != 1:
            return seq
        element = elements[0]
        text = element.get("textElement") or {}
        if element.get("elementType") != 1 or text.get("atType") != 0:
            return seq
        body = routed_body(text.get("content"), self.route)
        if body is not None:
            self.db.execute(
                "INSERT OR IGNORE INTO tasks(grp,msg_id,seq,body,state) VALUES(?,?,?,?,'pending')",
                (self.group, msg_id, seq, body),
            )
        return seq

    def observe(self, message, *, replay=False):
        # Push can arrive out of order. Only a completed scoped history page advances the cursor.
        with self.transaction():
            self._record(message, replay=replay)

    def page(self, after, messages):
        with self.transaction():
            (cursor,) = self.db.execute("SELECT cursor FROM scope").fetchone()
            if cursor != after:
                raise StalePage("Stale history page; read again from the durable cursor")
            for message in messages:
                seq = self._record(message)
                if seq < cursor:
                    raise ValueError("History page out of order")
                cursor = seq
            self.db.execute("UPDATE scope SET cursor=?", (cursor,))

    def claim(self):
        # The caller is a desktop dispatcher. A second worker can only claim another row.
        with self.transaction():
            row = self.db.execute(
                "SELECT msg_id,body FROM tasks WHERE state='pending' ORDER BY seq LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            msg_id, body = row
            self.db.execute(
                "UPDATE tasks SET state='creating',updated=strftime('%s','now') WHERE grp=? AND msg_id=?", (self.group, msg_id)
            )
        title = "QQ-" + self.route.upper() + "-" + msg_id
        return msg_id, {"target": {"type": "projectless"}, "title": title, "prompt": body}

    def recovery(self):
        row = self.db.execute(
            """
            SELECT msg_id,state,host,thread_id,client_id,body FROM tasks
            WHERE state IN ('creating','awaiting','verifying') AND updated < strftime('%s','now')-180
            ORDER BY seq LIMIT 1
            """
        ).fetchone()
        if row:
            return {"reconcile": dict(zip(
                ("msgId", "state", "hostId", "threadId", "clientThreadId", "expectedPrompt"), row))}

    def created(self, msg_id, *, host=None, thread_id=None, client_id=None, resolves=None):
        if not ((host and thread_id and not client_id) or (client_id and not thread_id)):
            raise ValueError("Expected a host/thread pair or a queued client ID")
        if resolves and not thread_id:
            raise ValueError("Resolving a queued request requires a durable thread ID")
        with self.transaction():
            changed = self.db.execute(
                """
                UPDATE tasks SET state=?,host=?,thread_id=?,client_id=COALESCE(?,client_id),updated=strftime('%s','now')
                WHERE grp=? AND msg_id=? AND ((state='creating' AND ? IS NULL) OR (state='awaiting' AND client_id=?))
            """,
                (
                    "verifying" if thread_id else "awaiting",
                    host,
                    thread_id,
                    client_id,
                    self.group,
                    msg_id,
                    resolves,
                    resolves,
                ),
            )
            if changed.rowcount != 1:
                raise ValueError("Unexpected or repeated creation result")

    def verified(self, msg_id, host, thread_id, first_user_prompt):
        # Call only after desktop history finds this exact host/thread and the original prompt is verified.
        with self.transaction():
            changed = self.db.execute(
                """
                UPDATE tasks SET state='dispatched'
                WHERE grp=? AND msg_id=? AND state='verifying' AND host=? AND thread_id=? AND body=?
            """,
                (self.group, msg_id, host, thread_id, first_user_prompt),
            )
            if changed.rowcount != 1:
                raise ValueError("Desktop evidence does not match the creation receipt")
