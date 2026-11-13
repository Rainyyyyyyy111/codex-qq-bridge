"""Resolve a controller's routing instruction against this account's verified group tasks."""
import re
import sqlite3

NUMBER = re.compile(r"[#＃]\s*([0-9]+)")
FORK = re.compile(r"另开|另起(?:一|个|新)|新开(?:一|个|对话|聊天)|新建(?:一个?)?(?:对话|聊天)")
DIRECTIVE = re.compile(r"^\s*(?:请(?:你)?\s*)?(?:继续|接着|接续|续写|续聊|基于|参考|根据|沿用|回到|跟进|针对|接上|用|从)\s*(?:原任务|任务|群序号|回复|原稿)?\s*[#＃]")
MISSING_REF = re.compile(r"^\s*(?:请(?:你)?\s*)?(?:继续|接着|接上|接续|续写|续聊|按刚才|基于上|基于刚才|上次那个|刚才那个|把上一版|修改上一版|沿用上一版)")
ASK = "请再 @ 我，引用要继续的那条回群答复，或写「继续 #原任务群序号」并附上要求。需要另开时写「基于 #原任务群序号 的终稿另开」；独立的新任务可以直接发。"


def install_schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS mention_turns (
        msg_id TEXT PRIMARY KEY, action TEXT NOT NULL, root_id TEXT NOT NULL, source_id TEXT,
        clarification_id TEXT, turn_id TEXT, previous_turn TEXT, submitted TEXT, final TEXT, published TEXT, reply_id TEXT, reply_seq TEXT)""")
    db.execute("CREATE INDEX IF NOT EXISTS mention_reply_id ON mention_turns(reply_id)")
    db.execute("CREATE INDEX IF NOT EXISTS mention_reply_seq ON mention_turns(reply_seq)")
    db.execute("CREATE INDEX IF NOT EXISTS task_seq ON tasks(grp,seq)")


def stored(q, key):
    cur = q.db.cursor()
    cur.row_factory = sqlite3.Row
    return cur.execute("""SELECT t.*,m.action,coalesce(m.root_id,t.msg_id) AS root_id,m.source_id,
        m.clarification_id,m.turn_id,m.previous_turn,m.submitted,m.final,m.published FROM tasks t LEFT JOIN mention_turns m USING(msg_id)
        WHERE t.grp=? AND t.msg_id=? AND t.origin='mention'""", (q.group, key)).fetchone()


def quoted_task(q, row):
    native = row.get("quotedTask")
    native_key = native["id"] if native else None
    # New receipts can resolve a native quote locally even after QQ evicts its history.
    msg, seq = row.get("quoteId"), row.get("quoteSeq")
    if msg or seq:
        hits = q.db.execute("""SELECT msg_id FROM mention_turns WHERE
                           (? IS NULL OR reply_id=?) AND (? IS NULL OR reply_seq=?)""",
                            (msg, msg, seq, seq)).fetchall()
        if len(hits) > 1 or (hits and native_key and hits[0][0] != native_key):
            return None
        if hits:
            native_key = hits[0][0]
    return stored(q, native_key) if native_key else None


def plan(q, key, row):
    """Freeze the routing decision before touching Codex; repeat delivery reads the same plan."""
    with q.transaction():
        task = stored(q, key)
        if task["action"] or task["state"] != "pending":
            return task
        text = task["body"].strip()
        # Interpret the leading routing clause. Numbers in the actual writing/coding task are data.
        clause = re.split(r"[，,。；;：:\n]", text, maxsplit=1)[0]
        fork = bool(FORK.search(clause) or re.search(r"[，,。；;]\s*(?:请)?另开", text))
        explicit = bool(DIRECTIVE.match(clause) or fork or re.match(r"^[#＃]\s*[0-9]+\s*(?:继续|另开)", clause))
        refs = set(NUMBER.findall(clause)) if explicit else set()
        # Accept “另开，基于 #42 …” and detect contradictory subsequent routing clauses.
        for following in re.split(r"[，,。；;：:\n]", text)[1:]:
            if DIRECTIVE.match(following):
                refs.update(NUMBER.findall(following))
        quote = quoted_task(q, row)
        ambiguous = "quotedTask" in row and (not quote or quote["seq"] >= task["seq"])
        clarification = None
        if quote and quote["action"] == "clarify" and re.match(r"^[#＃]\s*[0-9]+", text):
            refs.update(NUMBER.findall(clause))
        if quote:
            if quote["action"] == "clarify":
                clarification = quote
            else:
                refs.add(str(quote["seq"]))
        source = None
        if len(refs) == 1:
            seq = refs.pop()
            if re.fullmatch(r"[1-9][0-9]{0,18}", seq) and int(seq) < task["seq"]:
                matches = q.db.execute("SELECT msg_id FROM tasks WHERE grp=? AND seq=? AND origin='mention'",
                                       (q.group, int(seq))).fetchall()
                if len(matches) == 1:
                    source = stored(q, matches[0][0])
            ambiguous |= source is None
            if source and source["state"] == "pending" and source["action"] is None:
                # trigger sync may have observed the source before its wake worker planned it.
                # Its own native quote metadata must be read before deriving our root.
                raise RuntimeError("Referenced group task is awaiting routing")
        elif refs or MISSING_REF.match(text) or (fork and re.search(r"上[一次个版]|刚才|之前|原稿|该稿", clause)):
            ambiguous = True
        if clarification:
            ambiguous |= source is None
            if source and source["state"] == "pending" and source["action"] is None:
                # trigger sync may have observed the source before its wake worker planned it.
                # Its own native quote metadata must be read before deriving our root.
                raise RuntimeError("Referenced group task is awaiting routing")
            fork |= bool(FORK.search(clarification["body"].split("，", 1)[0]))
        if source:
            ambiguous |= source["action"] == "clarify" or source["state"] in ("uncertain", "failed")
            ambiguous |= source["state"] == "dispatched" and not source["reply_state"]
        if ambiguous:
            action, source = "clarify", None
        elif source:
            action = "fork" if fork else "resume"
        else:
            action = "new"
        root = source["root_id"] if action == "resume" else key
        q.db.execute("INSERT INTO mention_turns(msg_id,action,root_id,source_id,clarification_id) VALUES(?,?,?,?,?)",
                     (key, action, root, source["msg_id"] if source else None,
                      clarification["msg_id"] if clarification and not ambiguous else None))
        return stored(q, key)
