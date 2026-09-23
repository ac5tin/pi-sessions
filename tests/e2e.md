# Manual end-to-end checks

Run each from the repo root after `npm install`.

The automated suite (`npm test`) covers the unit behaviour; this file checks the two
things it cannot: that pi loads the packaged extension, and that a real model sees the
injected context.

## 1. Injection across repos

```bash
PI_SESSIONS_ROOT="tests/fixtures/sessions" \
PI_SESSIONS_CONFIG="$PWD/tests/fixtures/config-e2e.json" \
pi -e ./extensions/pi-sessions --no-session -p "Reply with only the repo path from #feature-db-orm"
```

Expect: the reply contains `/repo/backend`, and the run prints no extension load error.

> Roots are deduped by real path: the same directory reached through an absolute path, a
> relative path, or a symlink is walked once, whichever spelling comes first. The old
> double-index trap — one file, two cache keys, every reference ambiguous, injection
> suppressed — is gone; the run below proves it live.

The same from the package manifest instead of the directory:

```bash
PI_SESSIONS_ROOT="tests/fixtures/sessions" \
PI_SESSIONS_CONFIG="$PWD/tests/fixtures/config-e2e.json" \
pi -e . --no-session -p "Reply with only the repo path from #feature-db-orm"
```

## 2. Non-reference tokens are untouched

```bash
PI_SESSIONS_ROOT="tests/fixtures/sessions" \
PI_SESSIONS_CONFIG="$PWD/tests/fixtures/config-e2e.json" \
pi -e ./extensions/pi-sessions --no-session -p "Reply with only the number in issue #42"
```

Expect: `42`.

A `-p` reply cannot show what was injected, so to inspect the context block itself, rerun
without `--no-session` and with a scratch session directory. The block is stored in the
saved session file, so grep for it:

```bash
TMP=$(mktemp -d)
PI_SESSIONS_ROOT="tests/fixtures/sessions" \
PI_SESSIONS_CONFIG="$PWD/tests/fixtures/config-e2e.json" \
pi -e ./extensions/pi-sessions --session-dir "$TMP" -p "Reply with only the number in issue #42" >/dev/null
grep -rl "pi-sessions-reference" "$TMP" || echo "no reference block (correct)"

PI_SESSIONS_ROOT="tests/fixtures/sessions" \
PI_SESSIONS_CONFIG="$PWD/tests/fixtures/config-e2e.json" \
pi -e ./extensions/pi-sessions --session-dir "$TMP" -p "Reply with only the repo path from #feature-db-orm" >/dev/null
grep -rl "pi-sessions-reference" "$TMP"
```

Expect: the `#42` run prints `no reference block (correct)`; the `#feature-db-orm` run
prints a session file path. The injected block is stored in that file as a
`custom_message` with `customType: "pi-sessions-reference"`.

## 3. Ambiguity is reported, never guessed

Create two sessions with the same name in different repos:

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/root/--repo-a--" "$TMP/root/--repo-b--"
cat > "$TMP/root/--repo-a--/001.jsonl" <<'EOF'
{"type":"session","version":3,"id":"11111111-0000-4000-8000-000000000001","timestamp":"2026-09-22T10:00:00.000Z","cwd":"/repo/a"}
{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-09-22T10:00:01.000Z","message":{"role":"user","content":"Start the auth work","timestamp":1758532801000}}
{"type":"session_info","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-09-22T10:00:02.000Z","name":"fix-auth"}
{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","timestamp":"2026-09-22T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Started."}],"api":"x","provider":"p","model":"m","usage":{},"stopReason":"stop","timestamp":1758532803000}}
EOF
cat > "$TMP/root/--repo-b--/001.jsonl" <<'EOF'
{"type":"session","version":3,"id":"22222222-0000-4000-8000-000000000002","timestamp":"2026-09-22T10:00:00.000Z","cwd":"/repo/b"}
{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-09-22T10:00:01.000Z","message":{"role":"user","content":"Start the auth work too","timestamp":1758532801000}}
{"type":"session_info","id":"bbbbbbbb","parentId":"aaaaaaaa","timestamp":"2026-09-22T10:00:02.000Z","name":"fix-auth"}
{"type":"message","id":"cccccccc","parentId":"bbbbbbbb","timestamp":"2026-09-22T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Started."}],"api":"x","provider":"p","model":"m","usage":{},"stopReason":"stop","timestamp":1758532803000}}
EOF

PI_SESSIONS_ROOT="$TMP/root" \
PI_SESSIONS_CONFIG="$PWD/tests/fixtures/config-e2e.json" \
pi -e ./extensions/pi-sessions --no-session \
  -p "Use #feature-db-orm and #fix-auth. If #fix-auth is ambiguous, list every candidate and ask which one."
```

Expect: the reply names both `/repo/a` and `/repo/b` (the injected block carries a
`#fix-auth is ambiguous. Candidates: …` note) and asks which session was meant.

A lone ambiguous token injects nothing: the same rule that keeps `#42` untouched means a
prompt whose only reference does not resolve sends the model nothing to guess from. The
UI still warns that no session matched, so the dead token is not silent for the user.

## 4. Live session tolerance

Start a pi session in another repository and leave it running mid-turn (or type into it
so its session file is written within the last 2 minutes). From a session in a different
repository, reference it by id prefix:

```text
#<id-prefix> what is the state of this work?
```

Expect: a digest appears with `state="active"`, and no error. The file is being appended
to while it is read, so a partially written final line must be skipped, not fatal — and
the file must be left byte-identical, because a file without a trailing newline is read
through a temporary copy rather than repaired in place.

## 5. Dropdown

In an interactive session, type `#`. Expect a list whose rows show the session name, the
repo, the age, the message count, and the state (`active` / `finished`). Type `#fea` and
expect fuzzy filtering. Press Enter and expect the reference to be inserted, with a
trailing space when it lands at the end of the line.

## 6. Blocking summary

With `summaryMode` left at the default (`"blocking"`, so no `PI_SESSIONS_CONFIG` that
sets it to `"off"`), reference a real session in another repo.

Expect: a status line `summarizing …` while the model works, then a `Handoff:` line in
the injected block. Reference the same session again in a second prompt: the summary is
served from `~/.pi/agent/pi-sessions-cache/` and the block appears without the status
line.

## 7. Injection proof (recorded 2026-09-23)

Earlier smoke runs did not prove that the digest reached the model: the double-index bug
made every reference ambiguous and the answers came from a `session_read` tool call.
These checks use `--no-tools`, which removes `session_read` and `read`, so the answer can
only come from the injected digest.

```bash
TMP=$(mktemp -d)
printf '{"summaryMode":"off"}' > "$TMP/config.json"

# 1. Discriminating run
PI_SESSIONS_ROOT="$PWD/tests/fixtures/sessions" PI_SESSIONS_CONFIG="$TMP/config.json" \
pi -e ./extensions/pi-sessions --no-session --no-tools \
  -p "Reply with only the repo path from #feature-db-orm"
# observed stdout: /repo/backend

# 2. Persistence assertion: same run, session saved
PI_SESSIONS_ROOT="$PWD/tests/fixtures/sessions" PI_SESSIONS_CONFIG="$TMP/config.json" \
pi -e ./extensions/pi-sessions --session-dir "$TMP/ref" --no-tools \
  -p "Reply with only the repo path from #feature-db-orm"
# observed stdout: /repo/backend
# observed in "$TMP/ref"/*.jsonl, one entry:
#   type=custom_message  customType=pi-sessions-reference  display=true
#   content starts with '<referenced-session name="feature-db-orm"',
#   contains repo="/repo/backend", ends with the untrusted-data line

# 3. Control: an issue number injects nothing
PI_SESSIONS_ROOT="$PWD/tests/fixtures/sessions" PI_SESSIONS_CONFIG="$TMP/config.json" \
pi -e ./extensions/pi-sessions --session-dir "$TMP/ctl" --no-tools \
  -p "Reply with only the number in issue #42"
# observed stdout: 42
# observed: no pi-sessions-reference entry anywhere under "$TMP/ctl"

# 4. Frame count: one closing frame per reference
REF=$(find "$TMP/ref" -name '*.jsonl')
grep -o '</referenced-session>' "$REF" | wc -l
# observed: 1
```

The overlapping-roots spelling from section 1 is safe now, because roots are deduped by
real path. With the absolute root plus the config's relative `extraRoots`:

```bash
PI_SESSIONS_ROOT="$PWD/tests/fixtures/sessions" \
PI_SESSIONS_CONFIG="$PWD/tests/fixtures/config-e2e.json" \
pi -e ./extensions/pi-sessions --no-session --no-tools \
  -p "Reply with only the repo path from #feature-db-orm"
# observed stdout: /repo/backend
```